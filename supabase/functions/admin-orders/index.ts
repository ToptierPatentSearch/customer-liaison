import { withSupabase } from 'npm:@supabase/server@^1'

const BUCKET = 'order-supporting-documents'
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
          const requestedOffset = Number(body.offset ?? 0)
          const requestedLimit = Number(body.limit ?? 100)

          const offset =
            Number.isInteger(requestedOffset) && requestedOffset >= 0
              ? requestedOffset
              : 0

          const limit =
            Number.isInteger(requestedLimit) && requestedLimit > 0
              ? Math.min(requestedLimit, MAX_PAGE_SIZE)
              : 100

          const { data, error, count } = await ctx.supabaseAdmin
            .from('order_requests')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

          if (error) {
            console.error('Administrator order query failed:', error)
            return Response.json(
              { ok: false, error: 'Orders could not be loaded.' },
              { status: 500 },
            )
          }

          return Response.json({
            ok: true,
            orders: data ?? [],
            total: count ?? data?.length ?? 0,
          })
        }

        if (body.action === 'document-url') {
          const orderId = body.orderId
          const storagePath = body.storagePath

          if (!isUuid(orderId) || typeof storagePath !== 'string' || !storagePath.trim()) {
            return Response.json(
              { ok: false, error: 'Invalid supporting-document request.' },
              { status: 400 },
            )
          }

          const { data: order, error: orderError } = await ctx.supabaseAdmin
            .from('order_requests')
            .select('supporting_documents')
            .eq('id', orderId)
            .single()

          if (orderError || !order) {
            return Response.json({ ok: false, error: 'Order not found.' }, { status: 404 })
          }

          const documents = Array.isArray(order.supporting_documents)
            ? order.supporting_documents
            : []

          const belongsToOrder = documents.some(
            (document: Record<string, unknown>) =>
              document?.storage_path === storagePath,
          )

          if (!belongsToOrder) {
            return Response.json(
              { ok: false, error: 'Supporting document does not belong to this order.' },
              { status: 403 },
            )
          }

          const { data, error } = await ctx.supabaseAdmin.storage
            .from(BUCKET)
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
