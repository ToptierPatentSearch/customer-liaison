import { createScannedDocumentUrl } from '../_shared/document-scan.ts'
import { withSupabase } from 'npm:@supabase/server@^1'
import { enforceRateLimit, withRequestRateLimit } from '../_shared/rate-limit.ts'

const ORDER_BUCKET = 'order-supporting-documents'
const QUOTE_BUCKET = 'quote-supporting-documents'
const WORKSPACE_BUCKET = 'request-workspace-documents'
const MAX_PAGE_SIZE = 200
const MAX_FILES = 8
const MAX_FILE_BYTES = 10 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'png', 'jpg', 'jpeg',
])
const ADMIN_DOCUMENT_CATEGORIES = new Set(['deliverable', 'quote', 'report', 'other'])

const STATUS_OPTIONS: Record<string, Set<string>> = {
  discussion: new Set([
    'new',
    'reviewing',
    'clarification_required',
    'quote_requested',
    'converted',
    'closed',
  ]),
  quote: new Set([
    'submitted',
    'reviewing',
    'clarification_required',
    'quote_sent',
    'accepted',
    'declined',
    'converted',
    'closed',
  ]),
  order: new Set([
    'submitted',
    'reviewing',
    'clarification_required',
    'scope_confirmed',
    'search_in_progress',
    'report_delivered',
    'completed',
    'closed',
  ]),
}

const RECORD_CONFIG: Record<string, { table: string; label: string }> = {
  discussion: { table: 'project_discussions', label: 'Project discussion' },
  quote: { table: 'quote_requests', label: 'Quotation request' },
  order: { table: 'order_requests', label: 'Search request' },
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}


function textOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeFileName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(-140)
}

function extensionOf(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function normalizeWorkspaceFiles(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) {
    throw new Error(`Select between 1 and ${MAX_FILES} documents.`)
  }

  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Document information is invalid.')
    const item = raw as Record<string, unknown>
    const originalName = textOrNull(item.name)
    const sizeBytes = Number(item.size)
    const contentType = textOrNull(item.type)?.slice(0, 200) ?? null

    if (!originalName || originalName.length > 255) {
      throw new Error('Each document must have a valid file name.')
    }
    if (!ALLOWED_EXTENSIONS.has(extensionOf(originalName))) {
      throw new Error(`${originalName}: unsupported file type.`)
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
      throw new Error(`${originalName}: files must be 10 MB or smaller.`)
    }

    return { originalName, sizeBytes, contentType }
  })
}

function adminWorkspacePath(
  recordType: string,
  recordId: string,
  documentId: string,
  originalName: string,
) {
  return `admin/${recordType}/${recordId}/${documentId}-${safeFileName(originalName) || 'document'}`
}

async function isAdministrator(ctx: any, userId: string) {
  const { data, error } = await ctx.supabaseAdmin
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.error('Administrator lookup failed:', error)
    throw new Error('Administrator authorization could not be checked.')
  }

  return Boolean(data?.user_id)
}

function paging(body: Record<string, unknown>) {
  const requestedOffset = Number(body.offset ?? 0)
  const requestedLimit = Number(body.limit ?? 100)

  return {
    offset: Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0,
    limit:
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_PAGE_SIZE)
        : 100,
  }
}

async function listRecords(
  ctx: any,
  table: string,
  key: string,
  errorMessage: string,
  body: Record<string, unknown>,
) {
  const { offset, limit } = paging(body)

  const { data, error, count } = await ctx.supabaseAdmin
    .from(table)
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error(`Administrator ${table} query failed:`, error)
    return Response.json({ ok: false, error: errorMessage }, { status: 500 })
  }

  return Response.json({
    ok: true,
    [key]: data ?? [],
    total: count ?? data?.length ?? 0,
  })
}

async function createDocumentUrl(
  ctx: any,
  body: Record<string, unknown>,
  options: {
    idField: string
    table: string
    bucket: string
    missingMessage: string
  },
) {
  const recordId = body[options.idField]
  const storagePath = body.storagePath

  if (!isUuid(recordId) || typeof storagePath !== 'string' || !storagePath.trim()) {
    return Response.json(
      { ok: false, error: 'Invalid supporting-document request.' },
      { status: 400 },
    )
  }

  const { data: record, error: recordError } = await ctx.supabaseAdmin
    .from(options.table)
    .select('supporting_documents')
    .eq('id', recordId)
    .single()

  if (recordError || !record) {
    return Response.json({ ok: false, error: options.missingMessage }, { status: 404 })
  }

  const documents = Array.isArray(record.supporting_documents)
    ? record.supporting_documents
    : []

  const belongsToRecord = documents.some(
    (document: Record<string, unknown>) => document?.storage_path === storagePath,
  )

  if (!belongsToRecord) {
    return Response.json(
      { ok: false, error: 'Supporting document does not belong to this record.' },
      { status: 403 },
    )
  }

  return createScannedDocumentUrl(ctx, options.bucket, storagePath)
}

async function createWorkspaceUploads(
  ctx: any,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''

  if (!RECORD_CONFIG[recordType] || !isUuid(recordId)) {
    return Response.json({ ok: false, error: 'Invalid workspace upload request.' }, { status: 400 })
  }

  const record = await assertRecordExists(ctx, recordType, recordId)
  if (!record) {
    return Response.json({ ok: false, error: 'Request record was not found.' }, { status: 404 })
  }

  let files
  try {
    files = normalizeWorkspaceFiles(body.files)
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Invalid documents.' },
      { status: 400 },
    )
  }

  try {
    const uploads = await Promise.all(files.map(async (file) => {
      const documentId = crypto.randomUUID()
      const storagePath = adminWorkspacePath(recordType, recordId, documentId, file.originalName)
      const { data, error } = await ctx.supabaseAdmin.storage
        .from(WORKSPACE_BUCKET)
        .createSignedUploadUrl(storagePath, { upsert: false })

      if (error || !data?.token) throw error ?? new Error('Upload token was not returned.')

      return {
        documentId,
        storagePath,
        token: data.token,
        originalName: file.originalName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      }
    }))

    return Response.json({ ok: true, bucket: WORKSPACE_BUCKET, uploads })
  } catch (error) {
    console.error('Administrator signed workspace upload creation failed:', error)
    return Response.json({ ok: false, error: 'Secure upload links could not be created.' }, { status: 500 })
  }
}

async function registerWorkspaceDocuments(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''
  const category = typeof body.category === 'string' ? body.category : 'deliverable'
  const rawDocuments = Array.isArray(body.documents) ? body.documents : []

  if (
    !RECORD_CONFIG[recordType] ||
    !isUuid(recordId) ||
    !ADMIN_DOCUMENT_CATEGORIES.has(category) ||
    rawDocuments.length < 1 ||
    rawDocuments.length > MAX_FILES
  ) {
    return Response.json({ ok: false, error: 'Invalid workspace document registration.' }, { status: 400 })
  }

  const record = await assertRecordExists(ctx, recordType, recordId)
  if (!record) {
    return Response.json({ ok: false, error: 'Request record was not found.' }, { status: 404 })
  }

  const rows: Record<string, unknown>[] = []
  try {
    for (const raw of rawDocuments) {
      if (!raw || typeof raw !== 'object') throw new Error('Document information is invalid.')
      const item = raw as Record<string, unknown>
      const documentId = item.documentId
      const storagePath = textOrNull(item.storagePath)
      const originalName = textOrNull(item.originalName)
      const contentType = textOrNull(item.contentType)
      const sizeBytes = Number(item.sizeBytes)

      if (!isUuid(documentId) || !storagePath || !originalName || originalName.length > 255) {
        throw new Error('Document information is invalid.')
      }
      if (!ALLOWED_EXTENSIONS.has(extensionOf(originalName))) {
        throw new Error(`${originalName}: unsupported file type.`)
      }
      if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
        throw new Error(`${originalName}: files must be 10 MB or smaller.`)
      }

      const expectedPath = adminWorkspacePath(recordType, recordId, documentId, originalName)
      if (storagePath !== expectedPath) throw new Error('Document storage path is invalid.')

      rows.push({
        id: documentId,
        request_id: recordId,
        request_type: recordType,
        uploader_id: userId,
        uploader_role: 'admin',
        category,
        original_name: originalName,
        storage_path: storagePath,
        content_type: contentType?.slice(0, 200) ?? null,
        size_bytes: sizeBytes,
        visible_to_client: true,
      })
    }
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Invalid documents.' },
      { status: 400 },
    )
  }

  const { data, error } = await ctx.supabaseAdmin
    .from('request_documents')
    .upsert(rows, { onConflict: 'storage_path' })
    .select('id, original_name, content_type, size_bytes, category, uploader_role, visible_to_client, created_at')

  if (error) {
    console.error('Administrator workspace document registration failed:', error)
    return Response.json({ ok: false, error: 'Documents could not be registered.' }, { status: 500 })
  }

  const now = new Date().toISOString()
  const names = (data ?? []).map((document: Record<string, any>) => document.original_name).filter(Boolean)
  const label = category === 'report'
    ? 'REPORT AVAILABLE'
    : category === 'quote'
      ? 'QUOTATION DOCUMENT AVAILABLE'
      : 'DOCUMENT AVAILABLE'

  // Documents are already committed. Notification failures must not make the
  // client retry the upload with new document IDs and storage paths.
  let notificationCreated = false
  try {
    const { error: replyError } = await ctx.supabaseAdmin
      .from('request_replies')
      .insert({
        request_id: recordId,
        request_type: recordType,
        sender_id: userId,
        sender_role: 'admin',
        message: `${label} — ${names.join(', ')}`,
        is_draft: false,
        created_at: now,
        updated_at: now,
      })
    notificationCreated = !replyError
    if (replyError) console.error('Administrator document notification reply failed:', replyError)
  } catch (error) {
    console.error('Administrator document notification reply failed:', error)
  }

  if (!notificationCreated) {
    return Response.json({
      ok: true,
      documents: data ?? [],
      notificationCreated: false,
      warningCode: 'DOCUMENT_NOTIFICATION_FAILED',
      warning: 'Documents were published to My Requests, but the client notification could not be created. Do not upload these files again. Send a reply to notify the client.',
    })
  }

  const config = RECORD_CONFIG[recordType]
  await ctx.supabaseAdmin
    .from(config.table)
    .update({ updated_at: now })
    .eq('id', recordId)

  return Response.json({ ok: true, documents: data ?? [], notificationCreated: true })
}

async function listWorkspaceDocuments(
  ctx: any,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''
  const record = await assertRecordExists(ctx, recordType, recordId)

  if (!record) {
    return Response.json({ ok: false, error: 'Request record was not found.' }, { status: 404 })
  }

  const { data, error } = await ctx.supabaseAdmin
    .from('request_documents')
    .select('id, original_name, content_type, size_bytes, category, uploader_role, visible_to_client, created_at')
    .eq('request_type', recordType)
    .eq('request_id', recordId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Administrator workspace document list failed:', error)
    return Response.json({ ok: false, error: 'Request documents could not be loaded.' }, { status: 500 })
  }

  return Response.json({ ok: true, documents: data ?? [] })
}

async function createWorkspaceDocumentUrl(
  ctx: any,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''
  const documentId = typeof body.documentId === 'string' ? body.documentId : ''

  if (!RECORD_CONFIG[recordType] || !isUuid(recordId) || !isUuid(documentId)) {
    return Response.json({ ok: false, error: 'Invalid workspace-document request.' }, { status: 400 })
  }

  const record = await assertRecordExists(ctx, recordType, recordId)
  if (!record) {
    return Response.json({ ok: false, error: 'Request record was not found.' }, { status: 404 })
  }

  const { data: document, error: documentError } = await ctx.supabaseAdmin
    .from('request_documents')
    .select('id, storage_path')
    .eq('id', documentId)
    .eq('request_type', recordType)
    .eq('request_id', recordId)
    .maybeSingle()

  if (documentError) {
    console.error('Administrator workspace document lookup failed:', documentError)
    return Response.json({ ok: false, error: 'Request document could not be verified.' }, { status: 500 })
  }

  if (!document) {
    return Response.json({ ok: false, error: 'Request document was not found.' }, { status: 404 })
  }

  return createScannedDocumentUrl(ctx, WORKSPACE_BUCKET, document.storage_path)
}

async function updateRecordStatus(
  ctx: any,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = body.recordId
  const nextStatus = typeof body.status === 'string' ? body.status.trim() : ''

  const config = RECORD_CONFIG[recordType]
  const allowedStatuses = STATUS_OPTIONS[recordType]

  if (!config || !allowedStatuses || !isUuid(recordId) || !allowedStatuses.has(nextStatus)) {
    return Response.json(
      { ok: false, error: 'Invalid status update request.' },
      { status: 400 },
    )
  }

  const updatedAt = new Date().toISOString()

  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .update({
      status: nextStatus,
      updated_at: updatedAt,
    })
    .eq('id', recordId)
    .select('id, status, updated_at')
    .maybeSingle()

  if (error) {
    console.error(`Administrator ${config.table} status update failed:`, error)
    return Response.json(
      { ok: false, error: `${config.label} status could not be updated.` },
      { status: 500 },
    )
  }

  if (!data) {
    return Response.json(
      { ok: false, error: `${config.label} was not found.` },
      { status: 404 },
    )
  }

  return Response.json({
    ok: true,
    recordType,
    record: data,
  })
}

async function assertRecordExists(
  ctx: any,
  recordType: string,
  recordId: string,
) {
  const config = RECORD_CONFIG[recordType]
  if (!config || !isUuid(recordId)) return null

  const { data, error } = await ctx.supabaseAdmin
    .from(config.table)
    .select('id, user_id')
    .eq('id', recordId)
    .maybeSingle()

  if (error) {
    console.error(`Administrator ${config.table} record lookup failed:`, error)
    throw new Error(`${config.label} could not be loaded.`)
  }

  return data
}

async function listReplies(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''

  const record = await assertRecordExists(ctx, recordType, recordId)
  if (!record) {
    return Response.json({ ok: false, error: 'Request record was not found.' }, { status: 404 })
  }

  const replyColumns =
    'id, request_id, request_type, sender_id, sender_role, message, is_draft, read_at, created_at, updated_at'

  const [sentResult, draftResult] = await Promise.all([
    ctx.supabaseAdmin
      .from('request_replies')
      .select(replyColumns)
      .eq('request_type', recordType)
      .eq('request_id', recordId)
      .eq('is_draft', false)
      .order('created_at', { ascending: true }),
    ctx.supabaseAdmin
      .from('request_replies')
      .select(replyColumns)
      .eq('request_type', recordType)
      .eq('request_id', recordId)
      .eq('sender_id', userId)
      .eq('sender_role', 'admin')
      .eq('is_draft', true)
      .order('created_at', { ascending: true }),
  ])

  if (sentResult.error || draftResult.error) {
    console.error('Administrator reply list failed:', sentResult.error ?? draftResult.error)
    return Response.json({ ok: false, error: 'Conversation could not be loaded.' }, { status: 500 })
  }

  const replies = [...(sentResult.data ?? []), ...(draftResult.data ?? [])].sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0
    return leftTime - rightTime
  })

  const now = new Date().toISOString()
  await ctx.supabaseAdmin
    .from('request_replies')
    .update({ read_at: now, updated_at: now })
    .eq('request_type', recordType)
    .eq('request_id', recordId)
    .eq('sender_role', 'client')
    .eq('is_draft', false)
    .is('read_at', null)

  return Response.json({ ok: true, replies })
}

async function saveAdminReply(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const recordType = typeof body.recordType === 'string' ? body.recordType : ''
  const recordId = typeof body.recordId === 'string' ? body.recordId : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const isDraft = body.isDraft === true

  if (!RECORD_CONFIG[recordType] || !isUuid(recordId) || !message || message.length > 10000) {
    return Response.json(
      { ok: false, error: 'Enter a reply between 1 and 10,000 characters.' },
      { status: 400 },
    )
  }

  const record = await assertRecordExists(ctx, recordType, recordId)
  if (!record) {
    return Response.json({ ok: false, error: 'Request record was not found.' }, { status: 404 })
  }

  const { data: existingDraft, error: draftLookupError } = await ctx.supabaseAdmin
    .from('request_replies')
    .select('id')
    .eq('request_type', recordType)
    .eq('request_id', recordId)
    .eq('sender_id', userId)
    .eq('sender_role', 'admin')
    .eq('is_draft', true)
    .maybeSingle()

  if (draftLookupError) {
    console.error('Administrator draft lookup failed:', draftLookupError)
    return Response.json(
      { ok: false, error: isDraft ? 'Draft could not be saved.' : 'Reply could not be sent.' },
      { status: 500 },
    )
  }

  const now = new Date().toISOString()
  const replyColumns =
    'id, request_id, request_type, sender_id, sender_role, message, is_draft, read_at, created_at, updated_at'

  let data
  let error

  if (existingDraft?.id) {
    const updateValues: Record<string, unknown> = {
      message,
      is_draft: isDraft,
      updated_at: now,
    }

    if (!isDraft) {
      updateValues.created_at = now
    }

    const updateResult = await ctx.supabaseAdmin
      .from('request_replies')
      .update(updateValues)
      .eq('id', existingDraft.id)
      .eq('sender_id', userId)
      .eq('sender_role', 'admin')
      .eq('is_draft', true)
      .select(replyColumns)
      .single()

    data = updateResult.data
    error = updateResult.error
  } else {
    const insertResult = await ctx.supabaseAdmin
      .from('request_replies')
      .insert({
        request_id: recordId,
        request_type: recordType,
        sender_id: userId,
        sender_role: 'admin',
        message,
        is_draft: isDraft,
        created_at: now,
        updated_at: now,
      })
      .select(replyColumns)
      .single()

    data = insertResult.data
    error = insertResult.error
  }

  if (error) {
    console.error('Administrator reply save failed:', error)
    return Response.json(
      { ok: false, error: isDraft ? 'Draft could not be saved.' : 'Reply could not be sent.' },
      { status: 500 },
    )
  }

  if (!isDraft) {
    const config = RECORD_CONFIG[recordType]
    await ctx.supabaseAdmin
      .from(config.table)
      .update({ updated_at: now })
      .eq('id', recordId)
  }

  return Response.json({ ok: true, reply: data })
}

export default {
  fetch: withSupabase(
    { auth: 'user' },
    withRequestRateLimit(async (req, ctx) => {
      if (req.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed.' }, { status: 405 })
      }

      const userId = ctx.userClaims?.id
      if (typeof userId !== 'string' || !userId) {
        return Response.json({ ok: false, error: 'Authentication is required.' }, { status: 401 })
      }

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, error: 'Invalid JSON request.' }, { status: 400 })
      }

      try {
        const administrator = await isAdministrator(ctx, userId)

        if (body.action === 'status') {
          const blocked = await enforceRateLimit(ctx, userId, 'admin_status')
          if (blocked) return blocked
          return Response.json({ ok: true, isAdmin: administrator, mfaVerified: administrator && ctx.jwtClaims?.aal === 'aal2' })
        }

        if (!administrator) {
          return Response.json({ ok: false, error: 'Administrator access is required.' }, { status: 403 })
        }

        // withSupabase authenticates the JWT; only its signed top-level claim is trusted.
        if (ctx.jwtClaims?.aal !== 'aal2') {
          return Response.json(
            { ok: false, code: 'ADMIN_MFA_REQUIRED', error: 'Verify your authenticator before accessing administrator records.' },
            { status: 403 },
          )
        }

        const blocked = await enforceRateLimit(ctx, userId, 'admin_operation')
        if (blocked) return blocked

        if (body.action === 'update-status') {
          return updateRecordStatus(ctx, body)
        }

        if (body.action === 'list-replies') {
          return listReplies(ctx, userId, body)
        }

        if (body.action === 'save-reply') {
          return saveAdminReply(ctx, userId, body)
        }

        if (body.action === 'create-workspace-upload') {
          return createWorkspaceUploads(ctx, body)
        }

        if (body.action === 'register-workspace-documents') {
          return registerWorkspaceDocuments(ctx, userId, body)
        }

        if (body.action === 'list-workspace-documents') {
          return listWorkspaceDocuments(ctx, body)
        }

        if (body.action === 'workspace-document-url') {
          return createWorkspaceDocumentUrl(ctx, body)
        }

        if (body.action === 'list') {
          return listRecords(ctx, 'order_requests', 'orders', 'Orders could not be loaded.', body)
        }

        if (body.action === 'list-discussions') {
          return listRecords(
            ctx,
            'project_discussions',
            'discussions',
            'Project discussions could not be loaded.',
            body,
          )
        }

        if (body.action === 'list-quotes') {
          return listRecords(
            ctx,
            'quote_requests',
            'quotes',
            'Quotation requests could not be loaded.',
            body,
          )
        }

        if (body.action === 'document-url') {
          return createDocumentUrl(ctx, body, {
            idField: 'orderId',
            table: 'order_requests',
            bucket: ORDER_BUCKET,
            missingMessage: 'Order not found.',
          })
        }

        if (body.action === 'quote-document-url') {
          return createDocumentUrl(ctx, body, {
            idField: 'quoteId',
            table: 'quote_requests',
            bucket: QUOTE_BUCKET,
            missingMessage: 'Quotation request not found.',
          })
        }

        return Response.json({ ok: false, error: 'Unknown administrator action.' }, { status: 400 })
      } catch (error) {
        console.error('Administrator function error:', error)
        return Response.json(
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Administrator request failed.',
          },
          { status: 500 },
        )
      }
    }),
  ),
}
