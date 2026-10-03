const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_BUCKETS = new Set(['order-supporting-documents', 'quote-supporting-documents', 'request-workspace-documents'])
const MIN_ENGINE = [1, 5, 4]
const MAX_SIGNATURE_AGE_SECONDS = 72 * 3600

type Dependencies = {
  readEnv?: (name: string) => string | undefined
  fetch?: typeof fetch
  now?: () => number
}

function unavailable() {
  return Response.json({ ok: false, code: 'DOCUMENT_SCAN_UNAVAILABLE', error: 'Document security checking is temporarily unavailable. Please try again later.', retryAfter: 60 }, { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } })
}

function blocked() {
  return Response.json({ ok: false, code: 'DOCUMENT_BLOCKED', error: 'This document could not pass the security check. Please provide an unencrypted, malware-free replacement.' }, { status: 422, headers: { 'Cache-Control': 'no-store' } })
}

function supportedEngine(value: unknown) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return false
  const parts = value.split('.').map(Number)
  for (let i = 0; i < MIN_ENGINE.length; i++) {
    if (parts[i] !== MIN_ENGINE[i]) return parts[i] > MIN_ENGINE[i]
  }
  return true
}

async function smallJson(response: Response) {
  if (!response.body) throw new Error('No scanner response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 8192) throw new Error('Oversized scanner response')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}

// Call only after ownership/visibility or administrator/MFA authorization.
// No bypass mode: missing configuration, timeouts, stale signatures, and invalid
// reports all deny signed links. Do not deploy until the private scanner is ready.
export async function createScannedDocumentUrl(ctx: any, bucket: string, path: string, dependencies: Dependencies = {}) {
  const readEnv = dependencies.readEnv ?? ((name: string) => typeof Deno === 'undefined' ? undefined : Deno.env.get(name))
  const fetcher = dependencies.fetch ?? fetch
  const now = dependencies.now ?? Date.now
  try {
    if (!ALLOWED_BUCKETS.has(bucket) || !path) return unavailable()
    const endpoint = new URL(readEnv('DOCUMENT_SCANNER_URL') ?? '')
    const token = readEnv('DOCUMENT_SCANNER_TOKEN') ?? ''
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/scan' || !/^[a-f0-9]{64}$/.test(token)) return unavailable()

    const storage = ctx.supabaseAdmin.storage.from(bucket)
    const { data: blob, error: downloadError } = await storage.download(path)
    if (downloadError || !blob || typeof blob.arrayBuffer !== 'function') return unavailable()
    if (!Number.isInteger(blob.size) || blob.size < 1 || blob.size > MAX_BYTES) return blocked()
    const bytes = await blob.arrayBuffer()
    if (bytes.byteLength !== blob.size) return unavailable()
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let report: any
    try {
      const response = await fetcher(endpoint.href, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Document-SHA256': hash }, body: bytes, signal: controller.signal, redirect: 'error' })
      if (response.status !== 200) return unavailable()
      report = await smallJson(response)
    } finally { clearTimeout(timer) }
    const age = now() / 1000 - report?.signatureTimestamp
    if (!report || report.sha256 !== hash || report.scannedBytes !== bytes.byteLength || !supportedEngine(report.engineVersion) || !Number.isSafeInteger(report.signatureVersion) || report.signatureVersion < 1 || !Number.isSafeInteger(report.signatureTimestamp) || age < -300 || age > MAX_SIGNATURE_AGE_SECONDS) return unavailable()
    if (report.verdict === 'blocked') return blocked()
    if (report.verdict !== 'clean') return unavailable()

    // Application uploads use upsert:false and unique paths; browser roles have
    // no Storage UPDATE/DELETE permissions. Keep that immutability requirement.
    const { data, error } = await storage.createSignedUrl(path, 60)
    if (error || !data?.signedUrl) return unavailable()
    return Response.json({ ok: true, signedUrl: data.signedUrl, expiresIn: 60 }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    // Never log document bytes, filenames, tokens, scanner URLs, or raw reports.
    return unavailable()
  }
}
