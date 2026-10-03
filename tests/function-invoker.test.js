import assert from 'node:assert/strict'
import test from 'node:test'
import { createFunctionInvoker } from '../src/lib/functionInvoker.js'

test('quota responses give all calling forms the readable server message and retry interval', async () => {
  for (const [status, code] of [[429, 'RATE_LIMITED'], [503, 'RATE_LIMIT_UNAVAILABLE']]) {
    const context = Response.json({ ok: false, code, error: 'Please try again in 3 minutes.', retryAfter: 123 }, { status })
    const invoke = createFunctionInvoker({ invoke: async () => ({ data: null, error: { context, message: 'Non-2xx response' } }) })
    const result = await invoke('submit-order', { body: {} })
    assert.equal(result.error.message, 'Please try again in 3 minutes.')
    assert.equal(result.error.retryAfter, 123)
    assert.equal(result.data.ok, false)
    assert.equal(context.bodyUsed, false)
  }
})

test('successes, network failures, and unrelated errors retain their original contract', async () => {
  for (const result of [
    { data: { ok: true }, error: null },
    { data: null, error: new Error('Network failed') },
    { data: null, error: { context: Response.json({ code: 'OTHER_ERROR' }, { status: 429 }), message: 'Other failure' } },
    { data: null, error: { context: new Response('invalid JSON', { status: 503 }), message: 'Gateway unavailable' } },
  ]) {
    const invoke = createFunctionInvoker({ invoke: async () => result })
    assert.equal(await invoke('my-requests'), result)
  }
})
