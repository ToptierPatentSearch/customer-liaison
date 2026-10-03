// Preserve Supabase's normal success/error contract while showing actionable quota errors.
export function createFunctionInvoker(functions) {
  return async (name, options) => {
    const result = await functions.invoke(name, options)
    const response = result.error?.context
    if (!response || ![429, 503].includes(response.status) || typeof response.clone !== 'function') return result
    try {
      const body = await response.clone().json()
      if (!['RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE'].includes(body?.code) || typeof body.error !== 'string') return result
      const error = new Error(body.error)
      error.name = 'FunctionRequestError'
      error.status = response.status
      error.retryAfter = body.retryAfter
      return { ...result, data: body, error }
    } catch {
      return result
    }
  }
}
