import { withSupabase } from 'npm:@supabase/server@^1'

type ReplyRecord = {
  id: string
  senderRole: 'admin' | 'client'
  message: string
  createdAt: string | null
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
  createdAt: string | null
  updatedAt: string | null
  requestedCompletionDate: string | null
  replies: ReplyRecord[]
}

function textOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

const REQUEST_CONFIG = {
  discussion: { table: 'project_discussions' },
  quote: { table: 'quote_requests' },
  order: { table: 'order_requests' },
} as const

async function sendClientReply(
  ctx: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const requestType = typeof body.requestType === 'string' ? body.requestType : ''
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  const config = REQUEST_CONFIG[requestType as keyof typeof REQUEST_CONFIG]
  if (!config || !isUuid(requestId) || !message || message.length > 10000) {
    return Response.json(
      { ok: false, error: 'Enter a message between 1 and 10,000 characters.' },
      { status: 400 },
    )
  }

  const { data: requestRecord, error: requestError } = await ctx.supabaseAdmin
    .from(config.table)
    .select('id')
    .eq('id', requestId)
    .eq('user_id', userId)
    .maybeSingle()

  if (requestError) {
    console.error('Client request ownership lookup failed:', requestError)
    return Response.json({ ok: false, error: 'Request could not be verified.' }, { status: 500 })
  }

  if (!requestRecord) {
    return Response.json({ ok: false, error: 'Request was not found.' }, { status: 404 })
  }

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
    .select('id, sender_role, message, created_at')
    .single()

  if (error) {
    console.error('Client reply insert failed:', error)
    return Response.json({ ok: false, error: 'Your message could not be sent.' }, { status: 500 })
  }

  await ctx.supabaseAdmin
    .from(config.table)
    .update({ updated_at: now })
    .eq('id', requestId)

  return Response.json({
    ok: true,
    reply: {
      id: data.id,
      senderRole: data.sender_role,
      message: data.message,
      createdAt: data.created_at,
    },
  })
}

export default {
  fetch: withSupabase(
    { auth: 'user' },
    async (req, ctx) => {
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

        if (body.action === 'send-reply') {
          return sendClientReply(ctx, userId, body)
        }

        const [discussionsResult, quotesResult, ordersResult] = await Promise.all([
          ctx.supabaseAdmin
            .from('project_discussions')
            .select(
              'id, discussion_reference, project_type, objective, technology_description, status, created_at, updated_at',
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),

          ctx.supabaseAdmin
            .from('quote_requests')
            .select(
              'id, quote_reference, search_service, technical_subject, search_objective, status, created_at, updated_at, desired_completion_date',
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),

          ctx.supabaseAdmin
            .from('order_requests')
            .select(
              'id, order_reference, search_service, technical_subject, search_objective, status, created_at, updated_at, requested_completion_date',
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

        const discussions: RequestRecord[] = (discussionsResult.data ?? []).map((item) => ({
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
          createdAt: textOrNull(item.created_at),
          updatedAt: textOrNull(item.updated_at),
          requestedCompletionDate: null,
          replies: [],
        }))

        const quotes: RequestRecord[] = (quotesResult.data ?? []).map((item) => ({
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
          createdAt: textOrNull(item.created_at),
          updatedAt: textOrNull(item.updated_at),
          requestedCompletionDate: textOrNull(item.desired_completion_date),
          replies: [],
        }))

        const orders: RequestRecord[] = (ordersResult.data ?? []).map((item) => ({
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
          createdAt: textOrNull(item.created_at),
          updatedAt: textOrNull(item.updated_at),
          requestedCompletionDate: textOrNull(item.requested_completion_date),
          replies: [],
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
          const { data: replyRows, error: replyError } = await ctx.supabaseAdmin
            .from('request_replies')
            .select('id, request_id, request_type, sender_role, message, created_at')
            .in('request_id', requestIds)
            .eq('is_draft', false)
            .order('created_at', { ascending: true })

          if (replyError) {
            console.error('My Requests reply query failed:', replyError)
            return Response.json(
              { ok: false, error: 'Your request conversations could not be loaded.' },
              { status: 500 },
            )
          }

          const repliesByRequest = new Map<string, ReplyRecord[]>()
          for (const row of replyRows ?? []) {
            const key = `${row.request_type}:${row.request_id}`
            if (!requestKeys.has(key)) continue
            const current = repliesByRequest.get(key) ?? []
            current.push({
              id: row.id,
              senderRole: row.sender_role,
              message: row.message,
              createdAt: textOrNull(row.created_at),
            })
            repliesByRequest.set(key, current)
          }

          for (const request of requests) {
            const databaseType = request.type === 'search' ? 'order' : request.type
            request.replies = repliesByRequest.get(`${databaseType}:${request.id}`) ?? []
          }

          const now = new Date().toISOString()
          await ctx.supabaseAdmin
            .from('request_replies')
            .update({ read_at: now, updated_at: now })
            .in('request_id', requestIds)
            .eq('sender_role', 'admin')
            .eq('is_draft', false)
            .is('read_at', null)
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
    },
  ),
}
