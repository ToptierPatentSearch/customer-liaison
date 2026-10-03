import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importEdgeFunction } from './helpers/importEdgeFunction.js'

const names = ['submit-order', 'submit-quote', 'submit-discussion', 'create-upload-url', 'create-quote-upload-url', 'my-requests', 'admin-orders']
const handlers = Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await importEdgeFunction(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url))).default])))
const { enforceRateLimit } = await importEdgeFunction(new URL('../supabase/functions/_shared/rate-limit.ts', import.meta.url))
const userId = '11111111-1111-4111-8111-111111111111'
const recordId = '22222222-2222-4222-8222-222222222222'

function fixture({ blocked = null, missingUser = false, administrator = true, aal = 'aal2', unavailable = false } = {}) {
  const actions = []
  const touched = []
  const ctx = {
    userClaims: missingUser ? null : { id: userId, email: 'user@example.test' },
    jwtClaims: { aal },
    supabaseAdmin: {
      async rpc(name, params) {
        assert.equal(name, 'consume_app_rate_limit')
        assert.equal(params.p_user_id, userId)
        actions.push(params.p_action)
        if (unavailable) throw new Error('database unavailable')
        return { data: [{ allowed: params.p_action !== blocked, retry_after_seconds: params.p_action === blocked ? 123 : 0 }], error: null }
      },
      from(table) {
        touched.push(table)
        assert.equal(table, 'admin_users', 'records must not be touched when blocked')
        const query = { select() { return query }, eq() { return query }, async maybeSingle() { return { data: administrator ? { user_id: userId } : null, error: null } } }
        return query
      },
      storage: { from() { assert.fail('signed links must not be created when blocked') } },
    },
  }
  return { ctx, actions, touched }
}

function invoke(name, ctx, body = {}, method = 'POST') {
  return handlers[name].fetch(new Request('https://example.test/functions', { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), ctx)
}

test('all seven authenticated endpoints share the account burst quota before any work', async () => {
  for (const name of names) {
    const { ctx, actions, touched } = fixture({ blocked: 'api' })
    const result = await invoke(name, ctx, { userId: 'forged-user', action: 'list', aal: 'aal2' })
    assert.equal(result.status, 429, name)
    assert.equal(result.headers.get('Retry-After'), '123')
    assert.equal((await result.json()).code, 'RATE_LIMITED')
    assert.deepEqual(actions, ['api'])
    assert.deepEqual(touched, [])
  }
})

test('submissions enforce independent five-per-hour policies before inserting', async () => {
  for (const [name, policy] of [['submit-order', 'submit_order'], ['submit-quote', 'submit_quote'], ['submit-discussion', 'submit_discussion']]) {
    const { ctx, actions, touched } = fixture({ blocked: policy })
    assert.equal((await invoke(name, ctx)).status, 429)
    assert.deepEqual(actions, ['api', policy])
    assert.deepEqual(touched, [])
  }
})

test('initial order, quote, and workspace uploads share one authorization quota', async () => {
  for (const name of ['create-upload-url', 'create-quote-upload-url', 'my-requests']) {
    const { ctx, actions } = fixture({ blocked: 'upload_authorization' })
    const response = await invoke(name, ctx, { orderId: recordId, quoteId: recordId, action: 'create-document-upload', files: [{ originalName: 'safe.txt', sizeBytes: 10 }] })
    assert.equal(response.status, 429, name)
    assert.deepEqual(actions, ['api', 'upload_authorization'])
  }
})

test('message-producing workspace actions cannot bypass the shared reply quota', async () => {
  for (const action of ['send-reply', 'submit-amendment', 'quote-decision', 'register-documents']) {
    const { ctx, actions, touched } = fixture({ blocked: 'client_reply' })
    assert.equal((await invoke('my-requests', ctx, { action })).status, 429, action)
    assert.deepEqual(actions, ['api', 'client_reply'])
    assert.deepEqual(touched, [])
  }
})

test('administrator data and mutations share one quota after membership and MFA checks', async () => {
  const actions = ['list', 'list-discussions', 'list-quotes', 'update-status', 'list-replies', 'save-reply', 'create-workspace-upload', 'register-workspace-documents', 'list-workspace-documents', 'workspace-document-url', 'document-url', 'quote-document-url']
  for (const action of actions) {
    const f = fixture({ blocked: 'admin_operation' })
    assert.equal((await invoke('admin-orders', f.ctx, { action })).status, 429)
    assert.deepEqual(f.actions, ['api', 'admin_operation'])
    assert.deepEqual(f.touched, ['admin_users'])
  }
  for (const options of [{ administrator: false }, { aal: 'aal1' }]) {
    const f = fixture({ ...options, blocked: 'admin_operation' })
    assert.equal((await invoke('admin-orders', f.ctx, { action: 'list' })).status, 403)
    assert.deepEqual(f.actions, ['api', 'failed_authorization'])
  }
})

test('own membership status has its own quota and remains available before MFA', async () => {
  const f = fixture({ aal: 'aal1' })
  const response = await invoke('admin-orders', f.ctx, { action: 'status' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).mfaVerified, false)
  assert.deepEqual(f.actions, ['api', 'admin_status'])
})

test('repeated authenticated authorization failures receive their stricter quota', async () => {
  const f = fixture({ administrator: false, blocked: 'failed_authorization' })
  assert.equal((await invoke('admin-orders', f.ctx, { action: 'list' })).status, 429)
  assert.deepEqual(f.actions, ['api', 'failed_authorization'])
})

test('quota-store failures stop every endpoint before records or storage', async () => {
  for (const name of names) {
    const f = fixture({ unavailable: true })
    const response = await invoke(name, f.ctx)
    assert.equal(response.status, 503, name)
    assert.equal((await response.json()).code, 'RATE_LIMIT_UNAVAILABLE')
    assert.deepEqual(f.touched, [])
  }
})

test('errors and malformed quota responses fail closed at action-level checks too', async () => {
  for (const result of [
    { data: null, error: new Error('RPC failed') },
    { data: [] },
    { data: { allowed: true, retry_after_seconds: 0 } },
    { data: [{ allowed: 'true', retry_after_seconds: 0 }] },
    { data: [{ allowed: true, retry_after_seconds: 1 }] },
    { data: [{ allowed: false, retry_after_seconds: 0 }] },
    { data: [{ allowed: false, retry_after_seconds: 1.5 }] },
  ]) {
    const response = await enforceRateLimit({ supabaseAdmin: { rpc: async () => result } }, userId, 'client_reply')
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('Retry-After'), '60')
  }
})

test('missing identity and unsupported HTTP methods do not invoke the quota store', async () => {
  for (const name of names) {
    const f = fixture({ missingUser: true })
    assert.equal((await invoke(name, f.ctx)).status, 401, name)
    assert.equal((await invoke(name, f.ctx, {}, 'GET')).status, 405, name)
    assert.deepEqual(f.actions, [])
  }
})
