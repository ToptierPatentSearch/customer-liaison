import { withSupabase } from 'npm:@supabase/server@^1'

const BUCKET = 'order-supporting-documents'
const MAX_FILES = 8
const MAX_FILE_BYTES = 10 * 1024 * 1024

const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'png', 'jpg', 'jpeg',
])

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function safeFileName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(-140)
}

function validateFileName(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A supporting-document file name is required.')
  }

  const originalName = value.trim()
  if (originalName.length > 255) {
    throw new Error('A supporting-document file name is too long.')
  }

  const extension = originalName.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`${originalName}: unsupported file type.`)
  }

  return originalName
}

export default {
  fetch: withSupabase(
    { auth: 'user' },
    async (req, ctx) => {
      if (req.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed.' }, { status: 405 })
      }

      const authenticatedUserId = ctx.userClaims?.id
      if (typeof authenticatedUserId !== 'string' || !authenticatedUserId) {
        return Response.json({ ok: false, error: 'Authentication is required.' }, { status: 401 })
      }

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, error: 'Invalid JSON request.' }, { status: 400 })
      }

      try {
        const orderId = body.orderId
        if (!isUuid(orderId)) throw new Error('Invalid order ID.')
        if (!Array.isArray(body.files)) {
          throw new Error('Supporting-document information is required.')
        }

        if (body.files.length === 0) {
          return Response.json({ ok: true, uploads: [] })
        }

        if (body.files.length > MAX_FILES) {
          throw new Error(`No more than ${MAX_FILES} supporting documents are permitted.`)
        }

        const uploads = []

        for (let index = 0; index < body.files.length; index += 1) {
          const item = body.files[index]
          if (!item || typeof item !== 'object') {
            throw new Error('Invalid supporting-document information.')
          }

          const file = item as Record<string, unknown>
          const originalName = validateFileName(file.originalName)
          const sizeBytes = Number(file.sizeBytes)
          if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
            throw new Error(`${originalName}: invalid file size.`)
          }
          if (sizeBytes > MAX_FILE_BYTES) {
            throw new Error(`${originalName}: files must be 10 MB or smaller.`)
          }

          const contentType =
            typeof file.contentType === 'string' && file.contentType.trim()
              ? file.contentType.trim().slice(0, 200)
              : null

          const storagePath =
            `${authenticatedUserId}/${orderId}/` +
            `${String(index + 1).padStart(2, '0')}-` +
            `${crypto.randomUUID()}-` +
            `${safeFileName(originalName)}`

          const { data, error } = await ctx.supabaseAdmin.storage
            .from(BUCKET)
            .createSignedUploadUrl(storagePath, { upsert: false })

          if (error || !data?.token) {
            console.error('Signed upload URL error:', error)
            return Response.json(
              { ok: false, error: 'Upload authorization could not be created.' },
              { status: 500 },
            )
          }

          uploads.push({
            originalName,
            storagePath: data.path,
            token: data.token,
            contentType,
            sizeBytes,
          })
        }

        return Response.json({ ok: true, uploads }, { status: 201 })
      } catch (error) {
        console.error('Upload authorization validation error:', error)
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid upload request.',
          },
          { status: 400 },
        )
      }
    },
  ),
}
