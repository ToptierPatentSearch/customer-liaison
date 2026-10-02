import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'
import { ADMIN_FACTOR_NAME, authenticatorQrSource, loadAdminFactors, startAdminEnrollment, verifyAdminFactor } from '../src/lib/adminMfa.js'

const source = (await readFile(new URL('../supabase/functions/admin-orders/index.ts', import.meta.url), 'utf8'))
  .replace("import { withSupabase } from 'npm:@supabase/server@^1'", 'const withSupabase = (_options, handler) => handler')
const compiled = await transform(source, { loader: 'ts', format: 'esm' })
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)

function context({ admin = true, aal = 'aal1', metadata = {} } = {}) {
  const touched = []
  const ctx = {
    userClaims: { id: 'admin-user', userMetadata: metadata },
    jwtClaims: { aal, user_metadata: metadata },
    supabaseAdmin: {
      from(table) {
        touched.push(table)
        const query = {
          select() { return query }, eq() { return query }, order() { return query },
          async maybeSingle() { return { data: admin ? { user_id: 'admin-user' } : null, error: null } },
          async range() { return { data: [], count: 0, error: null } },
        }
        return query
      },
      storage: { from() { throw new Error('Storage must not be accessed before MFA verification.') } },
    },
  }
  return { ctx, touched }
}

async function invoke(ctx, body) {
  const response = await handler.fetch(new Request('https://example.test/admin-orders', { method: 'POST', body: JSON.stringify(body) }), ctx)
  return { status: response.status, body: await response.json() }
}

test('own administrator membership status is available before MFA without records', async () => {
  const { ctx, touched } = context()
  assert.deepEqual(await invoke(ctx, { action: 'status' }), { status: 200, body: { ok: true, isAdmin: true, mfaVerified: false } })
  assert.deepEqual(touched, ['admin_users'])
})

test('all administrator data and mutation routes deny AAL1 before touching records or storage', async () => {
  const actions = ['list', 'list-discussions', 'list-quotes', 'update-status', 'list-replies', 'save-reply', 'create-workspace-upload', 'register-workspace-documents', 'list-workspace-documents', 'workspace-document-url', 'document-url', 'quote-document-url']
  for (const action of actions) {
    const { ctx, touched } = context()
    const result = await invoke(ctx, { action })
    assert.equal(result.status, 403, action)
    assert.equal(result.body.code, 'ADMIN_MFA_REQUIRED', action)
    assert.deepEqual(touched, ['admin_users'], action)
  }
})

test('missing, unexpected, and forged MFA claims fail closed', async () => {
  for (const aal of [null, '', 'aal3', 2]) {
    const { ctx, touched } = context({ aal, metadata: { aal: 'aal2' } })
    const result = await invoke(ctx, { action: 'list', aal: 'aal2', mfaVerified: true })
    assert.equal(result.status, 403)
    assert.deepEqual(touched, ['admin_users'])
  }
  const { ctx } = context()
  delete ctx.jwtClaims
  assert.equal((await invoke(ctx, { action: 'list' })).status, 403)
})

test('AAL2 does not grant administrator membership', async () => {
  const { ctx, touched } = context({ admin: false, aal: 'aal2' })
  assert.equal((await invoke(ctx, { action: 'list' })).status, 403)
  assert.deepEqual((await invoke(ctx, { action: 'status' })).body, { ok: true, isAdmin: false, mfaVerified: false })
  assert.deepEqual(touched, ['admin_users', 'admin_users'])
})

test('verified administrator reaches real record handler and receives MFA status', async () => {
  const { ctx, touched } = context({ aal: 'aal2' })
  assert.deepEqual(await invoke(ctx, { action: 'list' }), { status: 200, body: { ok: true, orders: [], total: 0 } })
  assert.deepEqual(touched, ['admin_users', 'order_requests'])
  assert.equal((await invoke(ctx, { action: 'status' })).body.mfaVerified, true)
})

const ok = (data) => ({ data, error: null })
const existing = { id: 'existing-factor', factor_type: 'totp', status: 'verified' }

test('existing factors are offered for challenge and never replaced during setup', async () => {
  const mfa = { listFactors: async () => ok({ all: [existing] }), enroll() { assert.fail('must not enroll') } }
  assert.deepEqual((await loadAdminFactors(mfa)).verified, [existing])
  await assert.rejects(startAdminEnrollment(mfa), /already registered/)
})

test('unsupported verified factors cannot be replaced with fresh TOTP at AAL1', async () => {
  await assert.rejects(startAdminEnrollment({ listFactors: async () => ok({ all: [{ ...existing, factor_type: 'phone' }] }) }), /already registered/)
})

test('resuming interrupted enrollment removes only this app’s unfinished factor', async () => {
  const pending = { id: 'unfinished', factor_type: 'totp', status: 'unverified', friendly_name: ADMIN_FACTOR_NAME }
  const calls = []
  const mfa = {
    listFactors: async () => ok({ all: [pending, { ...pending, id: 'other', friendly_name: 'Another app' }] }),
    unenroll: async (params) => { calls.push(['unenroll', params]); return ok({}) },
    enroll: async (params) => { calls.push(['enroll', params]); return ok({ id: 'new-factor', totp: { secret: 'fake-test-key' } }) },
  }
  assert.equal((await startAdminEnrollment(mfa)).id, 'new-factor')
  assert.deepEqual(calls, [['unenroll', { factorId: 'unfinished' }], ['enroll', { factorType: 'totp', friendlyName: ADMIN_FACTOR_NAME }]])
})

test('factor lookup and cleanup failures stop enrollment', async () => {
  await assert.rejects(startAdminEnrollment({ listFactors: async () => ({ error: new Error('offline') }) }), /offline/)
  await assert.rejects(startAdminEnrollment({
    listFactors: async () => ok({ all: [{ id: 'pending', factor_type: 'totp', status: 'unverified', friendly_name: ADMIN_FACTOR_NAME }] }),
    unenroll: async () => ({ error: new Error('cleanup denied') }),
  }), /cleanup denied/)
})

test('invalid codes never reach Auth and wrong codes can be retried', async () => {
  await assert.rejects(verifyAdminFactor({}, 'factor', '12345'), /six-digit/)
  let tries = 0
  const mfa = {
    challengeAndVerify: async ({ factorId, code }) => {
      assert.equal(factorId, 'factor'); assert.equal(code, '123456'); tries++
      return tries === 1 ? { error: new Error('Incorrect code') } : ok({})
    },
    getAuthenticatorAssuranceLevel: async () => ok({ currentLevel: 'aal2' }),
  }
  await assert.rejects(verifyAdminFactor(mfa, 'factor', '123456'), /Incorrect code/)
  await verifyAdminFactor(mfa, 'factor', '123456')
  assert.equal(tries, 2)
})

test('verification must yield a confirmed AAL2 session', async () => {
  const mfa = { challengeAndVerify: async () => ok({}), getAuthenticatorAssuranceLevel: async () => ok({ currentLevel: 'aal1' }) }
  await assert.rejects(verifyAdminFactor(mfa, 'factor', '123456'), /could not be confirmed/)
  mfa.getAuthenticatorAssuranceLevel = async () => ({ error: new Error('session unavailable') })
  await assert.rejects(verifyAdminFactor(mfa, 'factor', '123456'), /session unavailable/)
})

test('QR renders only local SVG data and never a remote secret-bearing URL', () => {
  assert.equal(authenticatorQrSource('https://example.test/secret'), '')
  assert.equal(authenticatorQrSource('<svg></svg>'), 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E')
  assert.equal(authenticatorQrSource('data:image/svg+xml;base64,fake'), 'data:image/svg+xml;base64,fake')
})
