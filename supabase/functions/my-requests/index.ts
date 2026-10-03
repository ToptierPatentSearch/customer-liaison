import { createScannedDocumentUrl } from '../_shared/document-scan.ts'
import { withSupabase } from 'npm:@supabase/server@^1'
import { enforceRateLimit, withRequestRateLimit } from '../_shared/rate-limit.ts'

type ReplyRecord = {
  id: string
  senderRole: 'admin' | 'client'
  message: string
  createdAt: string | null
  readAt: string | null
  isUnread: boolean
}

type StatusHistoryRecord = {
  id: string
  fromStatus: string | null
  toStatus: string
  statusVersion: number
  changedAt: string | null
}

type DocumentRecord = {
  id: string
  originalName: string
  contentType: string | null
  sizeBytes: number
  category: string
  uploaderRole: 'admin' | 'client'
  createdAt: string | null
  source: 'workspace'
}

type OriginalDocumentRecord = {
  originalName: string
  contentType: string | null
  sizeBytes: number
  storagePath: string
  source: 'original'
}

type RequestRecord = {
  id: string
  type: 'discussion' | 'quote' | 'search'
  typeLabel: string
  reference: string | null
  subject: string
  service: string | null
  summary: string | null
  status: string | null
  statusUpdatedAt: string | null
  statusVersion: number
  seenStatusVersion: number
  hasStatusUpdate: boolean
  statusHistory: StatusHistoryRecord[]
  createdAt: string | null
  updatedAt: string | null
  requestedCompletionDate: string | null
  replies: ReplyRecord[]
  unreadMessageIds: string[]
  unreadMessageCount: number
  hasUnreadMessage: boolean
  details: Record<string, unknown>
  originalDocuments: OriginalDocumentRecord[]
  documents: DocumentRecord[]
}

const WORKSPACE_BUCKET = 'request-workspace-documents'
const MAX_FILES = 8
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_MESSAGE_IDS = 100

const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'png',
  'jpg',
  'jpeg',
])

const REQUEST_CONFIG = {
  discussion: { table: 'project_discussions' },
  quote: { table: 'quote_requests' },
  order: { table: 'order_requests' },
} as const

const ORIGINAL_DOCUMENT_CONFIG = {
  quote: { table: 'quote_requests', bucket: 'quote-supporting-documents' },
  order: { table: 'order_requests', bucket: 'order-supporting-documents' },
} as const

const AMENDMENT_CATEGORIES: Record<string, string> = {
  scope: 'Search scope',
  dates: 'Relevant dates',
  jurisdictions: 'Jurisdictions',
  claims: 'Claims / technical information',
  deliverable: 'Deliverable',
  completion_date: 'Completion date',
  other: 'Other',
}

const FINAL_STATUSES = new Set(['completed', 'closed', 'converted', 'declined'])

function textOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function integerOrDefault(value: unknown, fallback = 1) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
}

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

function extensionOf(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function normalizeUploadFiles(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) {
    throw new Error(`Select between 1 and ${MAX_FILES} documents.`)
  }

  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Document information is invalid.')
    const item = raw as Record<string, unknown>
    const originalName = typeof item.name === 'string' ? item.name.trim() : ''
    const sizeBytes = Number(item.size)
    const contentType = typeof item.type === 'string' && item.type.trim()
      ? item.type.trim().slice(0, 200)
      : null

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

function workspaceDocumentPath(
  userId: string,
  requestType: string,
  requestId: string,
  documentId: string,
  originalName: string,
) {
  const fileName = safeFileName(originalName) || 'document'
  return `${userId}/${requestType}/${requestId}/${documentId}-${fileName}`
}

function mapWorkspaceDocument(row: Record<string, any>): DocumentRecord {
  return {
    id: row.id,
    originalName: row.original_name,
    contentType: textOrNull(row.content_type),
    sizeBytes: Number(row.size_bytes) || 0,
    category: textOrNull(row.category) || 'client_attachment',
    uploaderRole: row.uploader_role === 'admin' ? 'admin' : 'client',
    createdAt: textOrNull(row.created_at),
    source: 'workspace',
  }
}

function normalizeOriginalDocuments(value: unknown): OriginalDocumentRecord[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const originalName = textOrNull(item.original_name)
    const storagePath = textOrNull(item.storage_path)
    if (!originalName || !storagePath) return []

    const size = Number(item.size_bytes)
    return [{
      originalName,
      storagePath,
      contentType: textOrNull(item.content_type),
      sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
      source: 'original' as const,
    }]
  })
}

async function getOwnedRequest(
  ctx: any,
  userId: string,
  requestType: string,
  requestId: string,
  columns = 'id',
) {
  const config = REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG]
  if (!config || !isUuid(requestId)) return { data: null, error: null, config: null }

  const result = await ctx.supabaseAdmin
    .from(config.table)
    .select(columns)
    .eq('id', requestId)
    .eq('user_id', userId)
    .maybeSingle()

  return { ...result, config }
}

async function touchRequest(ctx: any, requestType: string, requestId: string) {
  const config = REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG]
  if (!config) return
  await ctx.supabaseAdmin
    .from(config.table)
    .update({ updated_at: new Date().toISOString() })
    .eq('id', requestId)
}

async function insertClientReply(
  ctx: any,
  userId: string,
  requestType: string,
  requestId: string,
  message: string,
) {
  const now = new Date().toISOString()
  const { data, error } = await ctx.supabaseAdmin
    .from('request_replies')
    .insert({
      request_id: requestId,
      request_type: requestType,
      sender_id: userId,
      sender_role: 'client',
      message,
      is_draft: false,
      created_at: now,
      updated_at: now,
    })
    .select('id, sender_role, message, read_at, created_at')
    .single()

  if (error) throw error

  return {
    id: data.id,
    senderRole: data.sender_role,
    message: data.message,
    createdAt: textOrNull(data.created_at),
    readAt: textOrNull(data.read_at),
    isUnread: false,
  } satisfies ReplyRecord
}

async function sendClientReply(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  if (!REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] || !isUuid(requestId) || !message || message.length > 10000) {
    return Response.json(
      { ok: false, error: 'Enter a message between 1 and 10,000 characters.' },
      { status: 400 },
    )
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
  )

  if (requestError) {
    console.error('Client request ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  try {
    const reply = await insertClientReply(ctx, userId, requestType, requestId, message)
    await touchRequest(ctx, requestType, requestId)
    return Response.json({ ok: true, reply })
  } catch (error) {
    console.error('Client reply insert failed:', error)
    return Response.json({ ok: false, error: 'Your message could not be sent.' }, { status: 500 })
  }
}

async function acknowledgeStatusVersion(
  ctx: any,
  userId: string,
  requestType: string,
  requestId: string,
  renderedStatusVersion: number,
) {
  const seenAt = new Date().toISOString()

  const { error: insertError } = await ctx.supabaseAdmin
    .from('request_status_views')
    .upsert(
      {
        request_id: requestId,
        request_type: requestType,
        user_id: userId,
        seen_status_version: renderedStatusVersion,
        seen_at: seenAt,
      },
      { onConflict: 'request_type,request_id,user_id', ignoreDuplicates: true },
    )

  if (insertError) throw insertError

  const { error: updateError } = await ctx.supabaseAdmin
    .from('request_status_views')
    .update({ seen_status_version: renderedStatusVersion, seen_at: seenAt })
    .eq('request_id', requestId)
    .eq('request_type', requestType)
    .eq('user_id', userId)
    .lt('seen_status_version', renderedStatusVersion)

  if (updateError) throw updateError

  return seenAt
}

async function markStatusSeen(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const renderedStatusVersion = body.statusVersion

  if (
    !REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] ||
    !isUuid(requestId) ||
    !Number.isInteger(renderedStatusVersion) ||
    Number(renderedStatusVersion) < 1
  ) {
    return Response.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
    'id, status_version',
  )

  if (requestError) {
    console.error('Status seen ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  if (Number(renderedStatusVersion) > integerOrDefault(requestRecord.status_version)) {
    return Response.json({ ok: false, error: 'Invalid status version.' }, { status: 400 })
  }

  try {
    const seenAt = await acknowledgeStatusVersion(
      ctx,
      userId,
      requestType,
      requestId,
      Number(renderedStatusVersion),
    )
    return Response.json({
      ok: true,
      seenStatusVersion: Number(renderedStatusVersion),
      seenAt,
    })
  } catch (error) {
    console.error('Status seen update failed:', error)
    return Response.json({ ok: false, error: 'Status update could not be marked as viewed.' }, { status: 500 })
  }
}

async function markMessagesSeen(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const rawMessageIds = Array.isArray(body.messageIds) ? body.messageIds : []
  const messageIds = [...new Set(rawMessageIds)]

  if (
    !REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] ||
    !isUuid(requestId) ||
    messageIds.length < 1 ||
    messageIds.length > MAX_MESSAGE_IDS ||
    messageIds.some((id) => !isUuid(id))
  ) {
    return Response.json({ ok: false, error: 'Invalid message acknowledgment.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
  )

  if (requestError) {
    console.error('Message seen ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  const readAt = new Date().toISOString()
  const { error } = await ctx.supabaseAdmin
    .from('request_replies')
    .update({ read_at: readAt, updated_at: readAt })
    .eq('request_type', requestType)
    .eq('request_id', requestId)
    .eq('sender_role', 'admin')
    .eq('is_draft', false)
    .in('id', messageIds)
    .is('read_at', null)

  if (error) {
    console.error('Message seen update failed:', error)
    return Response.json({ ok: false, error: 'Messages could not be marked as viewed.' }, { status: 500 })
  }

  return Response.json({ ok: true, messageIds, readAt })
}

async function createDocumentUploads(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''

  if (!REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] || !isUuid(requestId)) {
    return Response.json({ ok: false, error: 'Invalid document upload request.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
    'id, status',
  )

  if (requestError) {
    console.error('Document upload ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  if (FINAL_STATUSES.has(requestRecord.status)) {
    return Response.json(
      { ok: false, error: 'This request is closed to additional document uploads.' },
      { status: 409 },
    )
  }

  let files
  try {
    files = normalizeUploadFiles(body.files)
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Invalid documents.' },
      { status: 400 },
    )
  }

  try {
    const uploads = await Promise.all(
      files.map(async (file) => {
        const documentId = crypto.randomUUID()
        const storagePath = workspaceDocumentPath(
          userId,
          requestType,
          requestId,
          documentId,
          file.originalName,
        )

        const { data, error } = await ctx.supabaseAdmin.storage
          .from(WORKSPACE_BUCKET)
          .createSignedUploadUrl(storagePath, { upsert: false })

        if (error || !data?.token) {
          throw error ?? new Error('Upload token was not returned.')
        }

        return {
          documentId,
          storagePath,
          token: data.token,
          originalName: file.originalName,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        }
      }),
    )

    return Response.json({ ok: true, bucket: WORKSPACE_BUCKET, uploads })
  } catch (error) {
    console.error('Signed workspace upload creation failed:', error)
    return Response.json({ ok: false, error: 'Secure upload links could not be created.' }, { status: 500 })
  }
}

async function registerDocuments(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const rawDocuments = Array.isArray(body.documents) ? body.documents : []

  if (
    !REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] ||
    !isUuid(requestId) ||
    rawDocuments.length < 1 ||
    rawDocuments.length > MAX_FILES
  ) {
    return Response.json({ ok: false, error: 'Invalid document registration request.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
    'id, status',
  )

  if (requestError) {
    console.error('Document registration ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  if (FINAL_STATUSES.has(requestRecord.status)) {
    return Response.json(
      { ok: false, error: 'This request is closed to additional document uploads.' },
      { status: 409 },
    )
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

      const expectedPath = workspaceDocumentPath(
        userId,
        requestType,
        requestId,
        documentId,
        originalName,
      )

      if (storagePath !== expectedPath) {
        throw new Error('Document storage path is invalid.')
      }

      rows.push({
        id: documentId,
        request_id: requestId,
        request_type: requestType,
        uploader_id: userId,
        uploader_role: 'client',
        category: 'client_attachment',
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
    .select('id, original_name, content_type, size_bytes, category, uploader_role, created_at')

  if (error) {
    console.error('Workspace document registration failed:', error)
    return Response.json({ ok: false, error: 'Uploaded documents could not be registered.' }, { status: 500 })
  }

  let reply: ReplyRecord | null = null
  try {
    const uploadedNames = (data ?? []).map((row: Record<string, any>) => row.original_name).filter(Boolean)
    const label = uploadedNames.length === 1 ? 'supporting document' : 'supporting documents'
    reply = await insertClientReply(
      ctx,
      userId,
      requestType,
      requestId,
      `DOCUMENT UPDATE — Added ${label}: ${uploadedNames.join(', ')}`,
    )
  } catch (replyError) {
    console.error('Workspace document conversation entry failed:', replyError)
  }

  await touchRequest(ctx, requestType, requestId)

  return Response.json({
    ok: true,
    documents: (data ?? []).map((row: Record<string, any>) => mapWorkspaceDocument(row)),
    reply,
  })
}

async function createWorkspaceDocumentUrl(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const documentId = typeof body.documentId === 'string' ? body.documentId : ''

  if (
    !REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] ||
    !isUuid(requestId) ||
    !isUuid(documentId)
  ) {
    return Response.json({ ok: false, error: 'Invalid document request.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
  )

  if (requestError) {
    console.error('Workspace document ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  const { data: document, error: documentError } = await ctx.supabaseAdmin
    .from('request_documents')
    .select('id, storage_path, original_name')
    .eq('id', documentId)
    .eq('request_type', requestType)
    .eq('request_id', requestId)
    .eq('visible_to_client', true)
    .maybeSingle()

  if (documentError) {
    console.error('Workspace document lookup failed:', documentError)
    return Response.json({ ok: false, error: 'Document could not be verified.' }, { status: 500 })
  }

  if (!document) {
    return Response.json({ ok: false, error: 'Document was not found.' }, { status: 404 })
  }

  return createScannedDocumentUrl(ctx, WORKSPACE_BUCKET, document.storage_path)
}

async function createOriginalDocumentUrl(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const storagePath = textOrNull(body.storagePath)
  const config = ORIGINAL_DOCUMENT_CONFIG[requestType as keyof typeof ORIGINAL_DOCUMENT_CONFIG]

  if (!config || !isUuid(requestId) || !storagePath) {
    return Response.json({ ok: false, error: 'Invalid original-document request.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
    'id, supporting_documents',
  )

  if (requestError) {
    console.error('Original document ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  const documents = Array.isArray(requestRecord.supporting_documents)
    ? requestRecord.supporting_documents
    : []

  const belongsToRequest = documents.some(
    (document: Record<string, unknown>) => textOrNull(document?.storage_path) === storagePath,
  )

  if (!belongsToRequest) {
    return Response.json({ ok: false, error: 'Document does not belong to this request.' }, { status: 403 })
  }

  return createScannedDocumentUrl(ctx, config.bucket, storagePath)
}

async function submitAmendment(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const category = typeof body.category === 'string' ? body.category : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''

  if (
    !REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG] ||
    !isUuid(requestId) ||
    !AMENDMENT_CATEGORIES[category] ||
    !description ||
    description.length > 5000
  ) {
    return Response.json({ ok: false, error: 'Enter a valid amendment request.' }, { status: 400 })
  }

  const { data: requestRecord, error: requestError } = await getOwnedRequest(
    ctx,
    userId,
    requestType,
    requestId,
    'id, status',
  )

  if (requestError) {
    console.error('Amendment ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

  if (FINAL_STATUSES.has(requestRecord.status)) {
    return Response.json(
      { ok: false, error: 'This request is closed to amendments. Send a follow-up message instead.' },
      { status: 409 },
    )
  }

  const message = `AMENDMENT REQUEST — ${AMENDMENT_CATEGORIES[category]}\n\n${description}`

  try {
    const reply = await insertClientReply(ctx, userId, requestType, requestId, message)
    await touchRequest(ctx, requestType, requestId)
    return Response.json({ ok: true, reply, category })
  } catch (error) {
    console.error('Amendment request insert failed:', error)
    return Response.json({ ok: false, error: 'The amendment request could not be submitted.' }, { status: 500 })
  }
}

async function quoteDecision(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const decision = body.decision === 'accept' || body.decision === 'decline'
    ? body.decision
    : null

  if (!isUuid(requestId) || !decision) {
    return Response.json({ ok: false, error: 'Invalid quotation decision.' }, { status: 400 })
  }

  const { data: quote, error: quoteError } = await getOwnedRequest(
    ctx,
    userId,
    'quote',
    requestId,
    'id, status, status_version',
  )

  if (quoteError) {
    console.error('Quote decision ownership lookup failed:', quoteError)
    return Response.json({ ok: false, error: 'Quotation request could not be verified.' }, { status: 500 })
  }

  if (!quote) {
    return Response.json({ ok: false, error: 'Quotation request was not found.' }, { status: 404 })
  }

  const nextStatus = decision === 'accept' ? 'accepted' : 'declined'

  if (quote.status === nextStatus) {
    return Response.json({
      ok: true,
      status: quote.status,
      statusVersion: integerOrDefault(quote.status_version),
      alreadyRecorded: true,
    })
  }

  if (quote.status !== 'quote_sent') {
    return Response.json(
      { ok: false, error: 'This quotation is not currently awaiting a client decision.' },
      { status: 409 },
    )
  }

  const updatedAt = new Date().toISOString()
  const { data: updatedQuote, error: updateError } = await ctx.supabaseAdmin
    .from('quote_requests')
    .update({ status: nextStatus, updated_at: updatedAt })
    .eq('id', requestId)
    .eq('user_id', userId)
    .eq('status', 'quote_sent')
    .select('id, status, status_updated_at, status_version, updated_at')
    .maybeSingle()

  if (updateError) {
    console.error('Quote decision status update failed:', updateError)
    return Response.json({ ok: false, error: 'Quotation decision could not be recorded.' }, { status: 500 })
  }

  if (!updatedQuote) {
    return Response.json(
      { ok: false, error: 'The quotation changed before your decision was recorded. Refresh and try again.' },
      { status: 409 },
    )
  }

  const message = decision === 'accept'
    ? 'QUOTATION DECISION — Accepted by client.'
    : 'QUOTATION DECISION — Declined by client.'

  let reply: ReplyRecord | null = null
  try {
    reply = await insertClientReply(ctx, userId, 'quote', requestId, message)
  } catch (error) {
    console.error('Quote decision conversation entry failed:', error)
  }

  const statusVersion = integerOrDefault(updatedQuote.status_version)
  try {
    await acknowledgeStatusVersion(ctx, userId, 'quote', requestId, statusVersion)
  } catch (error) {
    console.error('Quote decision seen-status update failed:', error)
  }

  return Response.json({
    ok: true,
    status: updatedQuote.status,
    statusUpdatedAt: textOrNull(updatedQuote.status_updated_at),
    statusVersion,
    updatedAt: textOrNull(updatedQuote.updated_at),
    reply,
  })
}

export default {
  fetch: withSupabase(
    { auth: 'user' },
    withRequestRateLimit(async (req, ctx) => {
      if (req.method !== 'POST') {
        return Response.json(
          { ok: false, error: 'Method not allowed.' },
          { status: 405 },
        )
      }

      const userId = ctx.userClaims?.id
      if (typeof userId !== 'string' || !userId) {
        return Response.json(
          { ok: false, error: 'Authentication is required.' },
          { status: 401 },
        )
      }

      try {
        let body: Record<string, unknown> = {}
        try {
          body = await req.json()
        } catch {
          body = {}
        }

        const limitedAction = body.action === 'create-document-upload'
          ? 'upload_authorization'
          : ['send-reply', 'submit-amendment', 'quote-decision', 'register-documents'].includes(String(body.action))
            ? 'client_reply' : null
        if (limitedAction) {
          const blocked = await enforceRateLimit(ctx, userId, limitedAction)
          if (blocked) return blocked
        }

        if (body.action === 'send-reply') {
          return sendClientReply(ctx, userId, body)
        }

        if (body.action === 'mark-status-seen') {
          return markStatusSeen(ctx, userId, body)
        }

        if (body.action === 'mark-messages-seen') {
          return markMessagesSeen(ctx, userId, body)
        }

        if (body.action === 'create-document-upload') {
          return createDocumentUploads(ctx, userId, body)
        }

        if (body.action === 'register-documents') {
          return registerDocuments(ctx, userId, body)
        }

        if (body.action === 'document-url') {
          return createWorkspaceDocumentUrl(ctx, userId, body)
        }

        if (body.action === 'original-document-url') {
          return createOriginalDocumentUrl(ctx, userId, body)
        }

        if (body.action === 'submit-amendment') {
          return submitAmendment(ctx, userId, body)
        }

        if (body.action === 'quote-decision') {
          return quoteDecision(ctx, userId, body)
        }

        const [discussionsResult, quotesResult, ordersResult] = await Promise.all([
          ctx.supabaseAdmin
            .from('project_discussions')
            .select(
              'id, discussion_reference, client_name, organization, email, project_type, objective, technology_description, timing, known_patent_documents, additional_information, scope_review_acknowledged, status, status_updated_at, status_version, created_at, updated_at',
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),

          ctx.supabaseAdmin
            .from('quote_requests')
            .select(
              'id, quote_reference, client_name, organization, email, country, search_service, technical_subject, project_description, search_objective, relevant_jurisdictions, relevant_dates, known_patent_documents, known_competitors_or_assignees, desired_completion_date, preferred_deliverable, budget_considerations, additional_information, supporting_documents, quote_request_acknowledged, status, status_updated_at, status_version, created_at, updated_at',
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),

          ctx.supabaseAdmin
            .from('order_requests')
            .select(
              'id, order_reference, client_name, organization, email, country, billing_organization, search_service, technical_subject, search_objective, relevant_jurisdictions, relevant_dates, known_patent_documents, known_competitors_or_assignees, requested_completion_date, preferred_deliverable, additional_instructions, supporting_documents, scope_review_acknowledged, status, status_updated_at, status_version, created_at, updated_at',
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),
        ])

        const queryError =
          discussionsResult.error ||
          quotesResult.error ||
          ordersResult.error

        if (queryError) {
          console.error('My Requests query failed:', {
            discussions: discussionsResult.error,
            quotes: quotesResult.error,
            orders: ordersResult.error,
          })

          return Response.json(
            { ok: false, error: 'Your requests could not be loaded.' },
            { status: 500 },
          )
        }

        const discussions: RequestRecord[] = (discussionsResult.data ?? []).map((item: Record<string, any>) => ({
          id: item.id,
          type: 'discussion',
          typeLabel: 'Discuss a Project',
          reference: textOrNull(item.discussion_reference),
          subject:
            textOrNull(item.technology_description) ||
            textOrNull(item.project_type) ||
            'Project discussion',
          service: textOrNull(item.project_type),
          summary: textOrNull(item.objective),
          status: textOrNull(item.status),
          statusUpdatedAt: textOrNull(item.status_updated_at),
          statusVersion: integerOrDefault(item.status_version),
          seenStatusVersion: 1,
          hasStatusUpdate: false,
          statusHistory: [],
          createdAt: textOrNull(item.created_at),
          updatedAt: textOrNull(item.updated_at),
          requestedCompletionDate: null,
          replies: [],
          unreadMessageIds: [],
          unreadMessageCount: 0,
          hasUnreadMessage: false,
          details: {
            clientName: textOrNull(item.client_name),
            organization: textOrNull(item.organization),
            email: textOrNull(item.email),
            projectType: textOrNull(item.project_type),
            objective: textOrNull(item.objective),
            technologyDescription: textOrNull(item.technology_description),
            timing: textOrNull(item.timing),
            knownPatentDocuments: textOrNull(item.known_patent_documents),
            additionalInformation: textOrNull(item.additional_information),
            scopeReviewAcknowledged: item.scope_review_acknowledged === true,
          },
          originalDocuments: [],
          documents: [],
        }))

        const quotes: RequestRecord[] = (quotesResult.data ?? []).map((item: Record<string, any>) => ({
          id: item.id,
          type: 'quote',
          typeLabel: 'Request a Custom Quote',
          reference: textOrNull(item.quote_reference),
          subject:
            textOrNull(item.technical_subject) ||
            textOrNull(item.search_service) ||
            'Custom quote request',
          service: textOrNull(item.search_service),
          summary: textOrNull(item.search_objective),
          status: textOrNull(item.status),
          statusUpdatedAt: textOrNull(item.status_updated_at),
          statusVersion: integerOrDefault(item.status_version),
          seenStatusVersion: 1,
          hasStatusUpdate: false,
          statusHistory: [],
          createdAt: textOrNull(item.created_at),
          updatedAt: textOrNull(item.updated_at),
          requestedCompletionDate: textOrNull(item.desired_completion_date),
          replies: [],
          unreadMessageIds: [],
          unreadMessageCount: 0,
          hasUnreadMessage: false,
          details: {
            clientName: textOrNull(item.client_name),
            organization: textOrNull(item.organization),
            email: textOrNull(item.email),
            country: textOrNull(item.country),
            searchService: textOrNull(item.search_service),
            technicalSubject: textOrNull(item.technical_subject),
            projectDescription: textOrNull(item.project_description),
            searchObjective: textOrNull(item.search_objective),
            relevantJurisdictions: textOrNull(item.relevant_jurisdictions),
            relevantDates: textOrNull(item.relevant_dates),
            knownPatentDocuments: textOrNull(item.known_patent_documents),
            knownCompetitorsOrAssignees: textOrNull(item.known_competitors_or_assignees),
            desiredCompletionDate: textOrNull(item.desired_completion_date),
            preferredDeliverable: textOrNull(item.preferred_deliverable),
            budgetConsiderations: textOrNull(item.budget_considerations),
            additionalInformation: textOrNull(item.additional_information),
            quoteRequestAcknowledged: item.quote_request_acknowledged === true,
          },
          originalDocuments: normalizeOriginalDocuments(item.supporting_documents),
          documents: [],
        }))

        const orders: RequestRecord[] = (ordersResult.data ?? []).map((item: Record<string, any>) => ({
          id: item.id,
          type: 'search',
          typeLabel: 'Request a Search',
          reference: textOrNull(item.order_reference),
          subject:
            textOrNull(item.technical_subject) ||
            textOrNull(item.search_service) ||
            'Search request',
          service: textOrNull(item.search_service),
          summary: textOrNull(item.search_objective),
          status: textOrNull(item.status),
          statusUpdatedAt: textOrNull(item.status_updated_at),
          statusVersion: integerOrDefault(item.status_version),
          seenStatusVersion: 1,
          hasStatusUpdate: false,
          statusHistory: [],
          createdAt: textOrNull(item.created_at),
          updatedAt: textOrNull(item.updated_at),
          requestedCompletionDate: textOrNull(item.requested_completion_date),
          replies: [],
          unreadMessageIds: [],
          unreadMessageCount: 0,
          hasUnreadMessage: false,
          details: {
            clientName: textOrNull(item.client_name),
            organization: textOrNull(item.organization),
            email: textOrNull(item.email),
            country: textOrNull(item.country),
            billingOrganization: textOrNull(item.billing_organization),
            searchService: textOrNull(item.search_service),
            technicalSubject: textOrNull(item.technical_subject),
            searchObjective: textOrNull(item.search_objective),
            relevantJurisdictions: textOrNull(item.relevant_jurisdictions),
            relevantDates: textOrNull(item.relevant_dates),
            knownPatentDocuments: textOrNull(item.known_patent_documents),
            knownCompetitorsOrAssignees: textOrNull(item.known_competitors_or_assignees),
            requestedCompletionDate: textOrNull(item.requested_completion_date),
            preferredDeliverable: textOrNull(item.preferred_deliverable),
            additionalInstructions: textOrNull(item.additional_instructions),
            scopeReviewAcknowledged: item.scope_review_acknowledged === true,
          },
          originalDocuments: normalizeOriginalDocuments(item.supporting_documents),
          documents: [],
        }))

        const requests = [...discussions, ...quotes, ...orders]

        const requestKeys = new Set(
          requests.map((request) => {
            const databaseType = request.type === 'search' ? 'order' : request.type
            return `${databaseType}:${request.id}`
          }),
        )
        const requestIds = requests.map((request) => request.id)

        if (requestIds.length > 0) {
          const [replyResult, historyResult, viewResult, documentResult] = await Promise.all([
            ctx.supabaseAdmin
              .from('request_replies')
              .select('id, request_id, request_type, sender_role, message, read_at, created_at')
              .in('request_id', requestIds)
              .eq('is_draft', false)
              .order('created_at', { ascending: true }),

            ctx.supabaseAdmin
              .from('request_status_history')
              .select('id, request_id, request_type, from_status, to_status, status_version, changed_at')
              .in('request_id', requestIds)
              .order('status_version', { ascending: true }),

            ctx.supabaseAdmin
              .from('request_status_views')
              .select('request_id, request_type, seen_status_version')
              .eq('user_id', userId),

            ctx.supabaseAdmin
              .from('request_documents')
              .select('id, request_id, request_type, original_name, content_type, size_bytes, category, uploader_role, created_at')
              .in('request_id', requestIds)
              .eq('visible_to_client', true)
              .order('created_at', { ascending: true }),
          ])

          if (replyResult.error || historyResult.error || viewResult.error || documentResult.error) {
            console.error('My Requests related-data query failed:', {
              replies: replyResult.error,
              history: historyResult.error,
              views: viewResult.error,
              documents: documentResult.error,
            })
            return Response.json(
              { ok: false, error: 'Your request updates could not be loaded.' },
              { status: 500 },
            )
          }

          const repliesByRequest = new Map<string, ReplyRecord[]>()
          for (const row of replyResult.data ?? []) {
            const key = `${row.request_type}:${row.request_id}`
            if (!requestKeys.has(key)) continue
            const current = repliesByRequest.get(key) ?? []
            current.push({
              id: row.id,
              senderRole: row.sender_role,
              message: row.message,
              createdAt: textOrNull(row.created_at),
              readAt: textOrNull(row.read_at),
              isUnread: row.sender_role === 'admin' && !row.read_at,
            })
            repliesByRequest.set(key, current)
          }

          const historyByRequest = new Map<string, StatusHistoryRecord[]>()
          for (const row of historyResult.data ?? []) {
            const key = `${row.request_type}:${row.request_id}`
            if (!requestKeys.has(key)) continue
            const current = historyByRequest.get(key) ?? []
            current.push({
              id: row.id,
              fromStatus: textOrNull(row.from_status),
              toStatus: textOrNull(row.to_status) || 'pending',
              statusVersion: integerOrDefault(row.status_version),
              changedAt: textOrNull(row.changed_at),
            })
            historyByRequest.set(key, current)
          }

          const seenVersionByRequest = new Map<string, number>()
          for (const row of viewResult.data ?? []) {
            const key = `${row.request_type}:${row.request_id}`
            if (!requestKeys.has(key)) continue
            seenVersionByRequest.set(key, integerOrDefault(row.seen_status_version))
          }

          const documentsByRequest = new Map<string, DocumentRecord[]>()
          for (const row of documentResult.data ?? []) {
            const key = `${row.request_type}:${row.request_id}`
            if (!requestKeys.has(key)) continue
            const current = documentsByRequest.get(key) ?? []
            current.push(mapWorkspaceDocument(row))
            documentsByRequest.set(key, current)
          }

          for (const request of requests) {
            const databaseType = request.type === 'search' ? 'order' : request.type
            const key = `${databaseType}:${request.id}`
            const seenVersion = Math.max(seenVersionByRequest.get(key) ?? 1, 1)
            const replies = repliesByRequest.get(key) ?? []
            const unreadMessageIds = replies
              .filter((reply) => reply.senderRole === 'admin' && reply.isUnread)
              .map((reply) => reply.id)

            request.replies = replies
            request.statusHistory = historyByRequest.get(key) ?? []
            request.seenStatusVersion = seenVersion
            request.hasStatusUpdate = request.statusVersion > seenVersion
            request.unreadMessageIds = unreadMessageIds
            request.unreadMessageCount = unreadMessageIds.length
            request.hasUnreadMessage = unreadMessageIds.length > 0
            request.documents = documentsByRequest.get(key) ?? []
          }
        }

        requests.sort((left, right) => {
          const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : left.createdAt ? Date.parse(left.createdAt) : 0
          const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : right.createdAt ? Date.parse(right.createdAt) : 0
          return rightTime - leftTime
        })

        return Response.json({ ok: true, requests })
      } catch (error) {
        console.error('My Requests function error:', error)
        return Response.json(
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Your requests could not be loaded.',
          },
          { status: 500 },
        )
      }
    }),
  ),
}
