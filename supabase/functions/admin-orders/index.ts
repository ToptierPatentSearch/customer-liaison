import { withSupabase } from 'npm:@supabase/server@^1'

const ORDER_BUCKET = 'order-supporting-documents'
const QUOTE_BUCKET = 'quote-supporting-documents'
const MAX_PAGE_SIZE = 200

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
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

  const { data, error } = await ctx.supabaseAdmin.storage
    .from(options.bucket)
    .createSignedUrl(storagePath, 60)

  if (error || !data?.signedUrl) {
    console.error('Administrator signed URL error:', error)
    return Response.json(
      { ok: false, error: 'A secure document link could not be created.' },
      { status: 500 },
    )
  }

  return Response.json({
    ok: true,
    signedUrl: data.signedUrl,
    expiresIn: 60,
  })
}

export default {
  fetch: withSupabase(
    { auth: 'user' },
    async (req, ctx) => {
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
          return Response.json({ ok: true, isAdmin: administrator })
        }

        if (!administrator) {
          return Response.json({ ok: false, error: 'Administrator access is required.' }, { status: 403 })
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
    },
  ),
}
