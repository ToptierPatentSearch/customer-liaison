import { withSupabase } from 'npm:@supabase/server@^1'

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
}

function textOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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
              'id, order_reference, search_service, technical_subject, search_objective, status, created_at, requested_completion_date',
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
          updatedAt: textOrNull(item.created_at),
          requestedCompletionDate: textOrNull(item.requested_completion_date),
        }))

        const requests = [...discussions, ...quotes, ...orders].sort((left, right) => {
          const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0
          const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0
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
