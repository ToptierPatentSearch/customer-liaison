import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { importEdgeFunction } from './helpers/importEdgeFunction.js'
import { createFunctionInvoker } from '../src/lib/functionInvoker.js'

const { createScannedDocumentUrl } = await importEdgeFunction(new URL('../supabase/functions/_shared/document-scan.ts', import.meta.url))
const admin = await importEdgeFunction(new URL('../supabase/functions/admin-orders/index.ts', import.meta.url))
const client = await importEdgeFunction(new URL('../supabase/functions/my-requests/index.ts', import.meta.url))
const token = 'a'.repeat(64)
const userId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const documentId = '33333333-3333-4333-8333-333333333333'
const payload = new Blob(['Example confidential document'])
const env = name => ({ DOCUMENT_SCANNER_URL: 'https://scanner.example.test/scan', DOCUMENT_SCANNER_TOKEN: token })[name]
const hash = Buffer.from(await crypto.subtle.digest('SHA-256', await payload.arrayBuffer())).toString('hex')

function fixture(overrides = {}) {
  const touched = []
  const ctx = { supabaseAdmin: { storage: { from(bucket) {
    return {
      async download(path) { touched.push(['download', bucket, path]); return { data: payload, error: null, ...overrides.download } },
      async createSignedUrl(path, seconds) { touched.push(['sign', bucket, path, seconds]); return { data: { signedUrl: 'https://storage.example.test/signed' }, error: null, ...overrides.sign } },
    }
  } } } }
  const fetcher = async (url, options) => {
    touched.push(['scan', url])
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    assert.equal(options.headers['X-Document-SHA256'], hash)
    assert.equal(options.redirect, 'error')
    assert.deepEqual(new Uint8Array(options.body), new Uint8Array(await payload.arrayBuffer()))
    if (overrides.throw) throw new Error('scanner unavailable')
    if (overrides.response) return overrides.response
    return Response.json({ verdict: 'clean', sha256: hash, scannedBytes: payload.size, engineVersion: '1.5.4', signatureVersion: 1000, signatureTimestamp: Math.floor(Date.now() / 1000), ...overrides.report })
  }
  return { ctx, touched, dependencies: { readEnv: env, fetch: fetcher } }
}

test('a clean digest-bound report is required before issuing a 60-second private link', async () => {
  const f = fixture()
  const response = await createScannedDocumentUrl(f.ctx, 'order-supporting-documents', 'private/document.pdf', f.dependencies)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).expiresIn, 60)
  assert.deepEqual(f.touched.map(x => x[0]), ['download', 'scan', 'sign'])
})

test('detected malware, encrypted documents, and exceeded inspection limits cannot receive links', async () => {
  const f = fixture({ report: { verdict: 'blocked' } })
  const response = await createScannedDocumentUrl(f.ctx, 'quote-supporting-documents', 'document', f.dependencies)
  assert.equal(response.status, 422)
  assert.equal((await response.json()).code, 'DOCUMENT_BLOCKED')
  assert.equal(f.touched.some(x => x[0] === 'sign'), false)
})

test('stale signatures, unsupported engines, mismatched digests, and malformed reports fail closed', async () => {
  for (const report of [
    { sha256: 'b'.repeat(64) }, { scannedBytes: payload.size + 1 }, { verdict: 'unknown' },
    { engineVersion: '1.5.3' }, { engineVersion: 'invalid' }, { signatureVersion: 0 },
    { signatureTimestamp: Math.floor(Date.now() / 1000) - 73 * 3600 },
    { signatureTimestamp: Math.floor(Date.now() / 1000) + 1000 }, { signatureTimestamp: null },
  ]) {
    const f = fixture({ report })
    const response = await createScannedDocumentUrl(f.ctx, 'order-supporting-documents', 'document', f.dependencies)
    assert.equal(response.status, 503, JSON.stringify(report))
    assert.equal(f.touched.some(x => x[0] === 'sign'), false)
  }
})

test('scanner network errors, redirects, HTTP failures, oversized responses, and invalid JSON cannot authorize downloads', async () => {
  for (const overrides of [
    { throw: true }, { response: new Response('', { status: 503 }) },
    { response: new Response('', { status: 302 }) },
    { response: new Response('invalid') }, { response: new Response('x'.repeat(8193)) },
  ]) {
    const f = fixture(overrides)
    assert.equal((await createScannedDocumentUrl(f.ctx, 'order-supporting-documents', 'document', f.dependencies)).status, 503)
    assert.equal(f.touched.some(x => x[0] === 'sign'), false)
  }
})

test('missing/unsafe scanner configuration rejects requests before storage access', async () => {
  for (const values of [
    {}, { DOCUMENT_SCANNER_URL: 'http://scanner.test/scan', DOCUMENT_SCANNER_TOKEN: token },
    { DOCUMENT_SCANNER_URL: 'https://user:password@scanner.test/scan', DOCUMENT_SCANNER_TOKEN: token },
    { DOCUMENT_SCANNER_URL: 'https://scanner.test/scan?token=x', DOCUMENT_SCANNER_TOKEN: token },
    { DOCUMENT_SCANNER_URL: 'https://scanner.test/other', DOCUMENT_SCANNER_TOKEN: token },
    { DOCUMENT_SCANNER_URL: 'https://scanner.test/scan', DOCUMENT_SCANNER_TOKEN: 'short' },
  ]) {
    const f = fixture()
    f.dependencies.readEnv = name => values[name]
    assert.equal((await createScannedDocumentUrl(f.ctx, 'order-supporting-documents', 'document', f.dependencies)).status, 503)
    assert.deepEqual(f.touched, [])
  }
})

test('empty, oversized, missing, or inconsistent stored files cannot be signed', async () => {
  for (const [download, expected] of [
    [{ data: new Blob([]) }, 422], [{ data: { size: 10 * 1024 * 1024 + 1, arrayBuffer() {} } }, 422],
    [{ data: null }, 503], [{ error: new Error('missing') }, 503],
    [{ data: { size: 4, arrayBuffer: async () => new ArrayBuffer(3) } }, 503],
  ]) {
    const f = fixture({ download })
    assert.equal((await createScannedDocumentUrl(f.ctx, 'order-supporting-documents', 'document', f.dependencies)).status, expected)
    assert.deepEqual(f.touched.map(x => x[0]), ['download'])
  }
})

test('frontend surfaces actionable document protection errors without consuming the SDK response', async () => {
  for (const [status, code] of [[422, 'DOCUMENT_BLOCKED'], [503, 'DOCUMENT_SCAN_UNAVAILABLE']]) {
    const context = Response.json({ ok: false, code, error: 'Document security checking is unavailable.' }, { status })
    const invoke = createFunctionInvoker({ invoke: async () => ({ data: null, error: { context } }) })
    assert.equal((await invoke('admin-orders')).error.message, 'Document security checking is unavailable.')
    assert.equal(context.bodyUsed, false)
  }
})

function endpointFixture({ owned = true, visible = true, administrator = true, aal = 'aal2', blocked = false } = {}) {
  const f = fixture({ report: { verdict: blocked ? 'blocked' : 'clean' } })
  f.ctx.userClaims = { id: userId }
  f.ctx.jwtClaims = { aal }
  f.ctx.supabaseAdmin.rpc = async () => ({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null })
  f.ctx.supabaseAdmin.from = table => {
    const filters = {}
    const query = {
      select() { return query }, eq(key, value) { filters[key] = value; return query },
      async maybeSingle() {
        if (table === 'admin_users') return { data: administrator ? { user_id: userId } : null }
        if (table === 'request_documents') return { data: visible || !filters.visible_to_client ? { id: documentId, storage_path: 'document' } : null }
        return { data: owned || !filters.user_id ? { id: requestId, supporting_documents: [{ storage_path: 'document' }] } : null }
      },
      async single() { return query.maybeSingle() },
    }
    return query
  }
  return f
}

async function withEndpointScanner(f, callback) {
  const previousFetch = globalThis.fetch, previousDeno = globalThis.Deno
  globalThis.fetch = f.dependencies.fetch
  globalThis.Deno = { env: { get: env } }
  try { return await callback() } finally { globalThis.fetch = previousFetch; globalThis.Deno = previousDeno }
}

function invoke(handler, ctx, body) {
  return handler.fetch(new Request('https://app.test', { method: 'POST', body: JSON.stringify(body) }), ctx)
}

test('all six administrator/client download routes execute the scanner and reject unsafe reports', async () => {
  const cases = [
    [admin.default, { action: 'document-url', orderId: requestId, storagePath: 'document' }],
    [admin.default, { action: 'quote-document-url', quoteId: requestId, storagePath: 'document' }],
    [admin.default, { action: 'workspace-document-url', recordType: 'order', recordId: requestId, documentId }],
    [client.default, { action: 'original-document-url', requestType: 'order', requestId, storagePath: 'document' }],
    [client.default, { action: 'original-document-url', requestType: 'quote', requestId, storagePath: 'document' }],
    [client.default, { action: 'document-url', requestType: 'order', requestId, documentId }],
  ]
  for (const [handler, body] of cases) for (const blocked of [false, true]) {
    const f = endpointFixture({ blocked })
    const response = await withEndpointScanner(f, () => invoke(handler, f.ctx, body))
    assert.equal(response.status, blocked ? 422 : 200, JSON.stringify(body))
    assert.equal(f.touched.filter(x => x[0] === 'scan').length, 1)
    assert.equal(f.touched.some(x => x[0] === 'sign'), !blocked)
  }
})

test('ownership, visibility, administrator membership, and MFA are checked before sending any bytes', async () => {
  for (const [handler, options, body, status] of [
    [client.default, { owned: false }, { action: 'original-document-url', requestType: 'order', requestId, storagePath: 'document' }, 404],
    [client.default, { visible: false }, { action: 'document-url', requestType: 'order', requestId, documentId }, 404],
    [admin.default, { administrator: false }, { action: 'document-url', orderId: requestId, storagePath: 'document' }, 403],
    [admin.default, { aal: 'aal1' }, { action: 'document-url', orderId: requestId, storagePath: 'document' }, 403],
    [admin.default, {}, { action: 'document-url', orderId: requestId, storagePath: 'forged-path' }, 403],
  ]) {
    const f = endpointFixture(options)
    assert.equal((await withEndpointScanner(f, () => invoke(handler, f.ctx, body))).status, status)
    assert.deepEqual(f.touched, [])
  }
})

test('upload tokens always disable overwrite and only the scan helper can issue document links', async () => {
  for (const name of ['admin-orders', 'my-requests', 'create-upload-url', 'create-quote-upload-url']) {
    const source = await readFile(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8')
    assert.equal(source.includes('.createSignedUploadUrl(storagePath)'), false)
    assert.ok(source.includes('.createSignedUploadUrl(storagePath, { upsert: false })'))
    assert.equal(source.includes('.createSignedUrl('), false)
  }
})
