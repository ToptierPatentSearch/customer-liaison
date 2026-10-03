export type RateLimitAction =
  | 'api' | 'submit_discussion' | 'submit_quote' | 'submit_order'
  | 'upload_authorization' | 'client_reply' | 'admin_operation'
  | 'admin_status' | 'failed_authorization'

function unavailable() {
  return Response.json(
    { ok: false, code: 'RATE_LIMIT_UNAVAILABLE', error: 'Request protection is temporarily unavailable. Please try again in one minute.', retryAfter: 60 },
    { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
  )
}

export async function enforceRateLimit(ctx: any, userId: string, action: RateLimitAction): Promise<Response | null> {
  try {
    const { data, error } = await ctx.supabaseAdmin.rpc('consume_app_rate_limit', {
      p_user_id: userId,
      p_action: action,
    })
    const result = Array.isArray(data) && data.length === 1 ? data[0] : null
    if (error || !result || typeof result.allowed !== 'boolean' ||
        !Number.isInteger(result.retry_after_seconds) || result.retry_after_seconds < 0 ||
        (result.allowed && result.retry_after_seconds !== 0) ||
        (!result.allowed && result.retry_after_seconds < 1)) {
      return unavailable()
    }
    if (result.allowed) return null
    const retryAfter = result.retry_after_seconds
    const minutes = Math.ceil(retryAfter / 60)
    return Response.json(
      { ok: false, code: 'RATE_LIMITED', error: `Too many requests. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retryAfter },
      { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } },
    )
  } catch {
    // A quota-store outage must not silently permit unbounded privileged operations.
    return unavailable()
  }
}

export function withRequestRateLimit(handler: (req: Request, ctx: any) => Promise<Response>) {
  return async (req: Request, ctx: any): Promise<Response> => {
    const userId = ctx.userClaims?.id
    if (req.method !== 'POST' || typeof userId !== 'string' || !userId) return handler(req, ctx)
    const blocked = await enforceRateLimit(ctx, userId, 'api')
    if (blocked) return blocked
    const response = await handler(req, ctx)
    if (response.status === 403) {
      const denied = await enforceRateLimit(ctx, userId, 'failed_authorization')
      if (denied) return denied
    }
    return response
  }
}
