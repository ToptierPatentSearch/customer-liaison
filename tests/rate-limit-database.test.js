import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, beforeEach, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../supabase/migrations/20261003004546_customer_liaison_rate_limits.sql', import.meta.url), 'utf8')
const db = new PGlite()
const userA = '11111111-1111-4111-8111-111111111111'
const userB = '22222222-2222-4222-8222-222222222222'

before(async () => {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;')
  await db.exec(migration)
})
beforeEach(async () => { await db.exec('reset role; truncate public.app_rate_limits;') })
after(async () => { await db.close() })

test('fresh-project schema includes the identical quota migration', async () => {
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
  assert.ok(schema.includes(migration))
})

async function consume(user = userA, action = 'submit_order') {
  return (await db.query('select * from public.consume_app_rate_limit($1::uuid, $2::text)', [user, action])).rows[0]
}

test('actual PostgreSQL function admits exactly the quota from a burst of parallel requests', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => consume()))
  assert.equal(results.filter((row) => row.allowed).length, 5)
  for (const row of results.filter((row) => !row.allowed)) {
    assert.ok(row.retry_after_seconds >= 1 && row.retry_after_seconds <= 3600)
  }
  assert.equal((await db.query('select requests from public.app_rate_limits')).rows[0].requests, 5)
})

test('accounts and submission types have independent quotas', async () => {
  for (let index = 0; index < 5; index++) await consume()
  assert.equal((await consume()).allowed, false)
  assert.equal((await consume(userB)).allowed, true)
  assert.equal((await consume(userA, 'submit_quote')).allowed, true)
  assert.equal((await consume(userA, 'submit_discussion')).allowed, true)
})

test('expired windows reset in the existing row without retaining unlimited history', async () => {
  await consume()
  await db.exec("update public.app_rate_limits set requests = 5, window_started_at = window_started_at - interval '1 hour'")
  assert.equal((await consume()).allowed, true)
  assert.deepEqual((await db.query('select requests from public.app_rate_limits')).rows, [{ requests: 1 }])
})

test('a delayed old-window request cannot reset or increment a newer window', async () => {
  await consume()
  await db.exec("update public.app_rate_limits set requests = 2, window_started_at = window_started_at + interval '1 hour'")
  const before = (await db.query('select * from public.app_rate_limits')).rows
  assert.equal((await consume()).allowed, false)
  assert.deepEqual((await db.query('select * from public.app_rate_limits')).rows, before)
})

test('all business policies use their declared limits', async () => {
  for (const [action, limit] of [
    ['submit_discussion', 5], ['submit_quote', 5], ['submit_order', 5],
    ['upload_authorization', 20], ['client_reply', 30], ['admin_operation', 120],
    ['admin_status', 120], ['failed_authorization', 10], ['api', 120],
  ]) {
    await consume(userA, action)
    await db.query('update public.app_rate_limits set requests = $1 where action = $2', [limit, action])
    assert.equal((await consume(userA, action)).allowed, false, action)
  }
})

test('unknown policies and missing identities cannot create counters', async () => {
  await assert.rejects(consume(userA, 'client-supplied-unlimited-action'), /Unknown rate-limit action/)
  await assert.rejects(consume(null), /authenticated user/)
  assert.equal((await db.query('select count(*)::integer as count from public.app_rate_limits')).rows[0].count, 0)
})

test('browser roles cannot read, reset, or consume quotas; service role can', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`)
    await assert.rejects(db.query('select * from public.app_rate_limits'), /permission denied/)
    await assert.rejects(db.query('delete from public.app_rate_limits'), /permission denied/)
    await assert.rejects(consume(), /permission denied/)
    await db.exec('reset role')
  }
  await db.exec('set role service_role')
  assert.equal((await consume()).allowed, true)
  await db.exec('reset role')
  const functionSettings = (await db.query("select prosecdef, proconfig from pg_proc where oid = 'public.consume_app_rate_limit(uuid,text)'::regprocedure")).rows[0]
  assert.equal(functionSettings.prosecdef, false)
  assert.ok(functionSettings.proconfig.some((setting) => setting.startsWith('search_path=')))
})
