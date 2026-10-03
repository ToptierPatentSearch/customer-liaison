import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../supabase/migrations/20261003021321_customer_liaison_database_privileges.sql', import.meta.url), 'utf8')
const quotaMigration = await readFile(new URL('../supabase/migrations/20261003004546_customer_liaison_rate_limits.sql', import.meta.url), 'utf8')
const tables = ['order_requests', 'project_discussions', 'quote_requests', 'admin_users', 'request_replies', 'request_status_history', 'request_status_views', 'request_documents', 'app_rate_limits']
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

async function fixture({ maintenance = true, quotas = false } = {}) {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema storage;
    create table storage.objects (id integer primary key);
    grant all on table storage.objects to authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to public, anon, authenticated;
    alter default privileges for role postgres in schema public grant all on sequences to public, anon, authenticated;
  `)
  for (const table of tables.filter(name => !quotas || name !== 'app_rate_limits')) {
    await db.exec(`create table public.${table} (id integer primary key, payload text); alter table public.${table} enable row level security;`)
  }
  // Even a permissive row policy cannot compensate for revoked table privileges.
  await db.exec('create policy fixture_read on public.order_requests for select to authenticated using (true);')
  if (maintenance) await db.exec('create table public.project_maintenance (id bigserial primary key, payload text);')
  if (quotas) await db.exec(quotaMigration)
  await db.exec(migration)
  return db
}

async function permissionDenied(db, sql) {
  await assert.rejects(db.query(sql), error => error.code === '42501', sql)
}

test('fresh-project schema includes the identical least-privilege migration', async () => {
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
  assert.ok(schema.endsWith(migration))
})

test('all browser table privileges are removed, including inherited PUBLIC grants', async () => {
  const db = await fixture()
  try {
    for (const role of ['anon', 'authenticated']) {
      for (const table of [...tables, 'project_maintenance']) {
        for (const privilege of privileges) {
          const result = await db.query('select has_table_privilege($1, $2, $3) as allowed', [role, `public.${table}`, privilege])
          assert.equal(result.rows[0].allowed, false, `${role} ${table} ${privilege}`)
        }
        const column = await db.query('select has_column_privilege($1, $2, $3, $4) as allowed', [role, `public.${table}`, 'payload', 'SELECT'])
        assert.equal(column.rows[0].allowed, false)
      }
    }
    const rls = await db.query("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity")
    assert.deepEqual(rls.rows, [])
  } finally { await db.close() }
})

test('anonymous and signed-in database roles cannot read, mutate, or truncate private tables', async () => {
  const db = await fixture()
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      for (const table of [...tables, 'project_maintenance']) {
        for (const sql of [
          `select * from public.${table}`,
          `insert into public.${table} (id, payload) values (1, 'attempt')`,
          `update public.${table} set payload='attempt' where id=1`,
          `delete from public.${table} where id=1`,
          `truncate public.${table}`,
        ]) await permissionDenied(db, sql)
      }
      await permissionDenied(db, "select nextval('public.project_maintenance_id_seq')")
      await permissionDenied(db, "select setval('public.project_maintenance_id_seq', 999)")
      await db.exec('reset role')
    }
  } finally { await db.close() }
})

test('server role keeps real CRUD access and maintenance sequence access without default grants', async () => {
  const db = await fixture()
  try {
    await db.exec('set role service_role')
    for (const table of [...tables, 'project_maintenance']) {
      await db.query(`insert into public.${table} (id, payload) values (1, 'before')`)
      assert.equal((await db.query(`select payload from public.${table} where id=1`)).rows[0].payload, 'before')
      await db.query(`update public.${table} set payload='after' where id=1`)
      assert.equal((await db.query(`delete from public.${table} where id=1 returning payload`)).rows[0].payload, 'after')
    }
    await db.query("insert into public.project_maintenance (payload) values ('sequence works')")
    assert.equal((await db.query('select id from public.project_maintenance')).rows[0].id, 1)
  } finally { await db.close() }
})

test('future postgres public tables and sequences require deliberate browser grants', async () => {
  const db = await fixture()
  try {
    await db.exec('create table public.future_private (id bigserial primary key); create table storage.future_object (id integer); grant select on storage.future_object to authenticated;')
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of privileges) assert.equal((await db.query('select has_table_privilege($1, $2, $3) as allowed', [role, 'public.future_private', privilege])).rows[0].allowed, false)
      for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) assert.equal((await db.query('select has_sequence_privilege($1, $2, $3) as allowed', [role, 'public.future_private_id_seq', privilege])).rows[0].allowed, false)
    }
    assert.equal((await db.query("select has_table_privilege('authenticated','storage.objects','INSERT') as allowed")).rows[0].allowed, true)
    assert.equal((await db.query("select has_table_privilege('authenticated','storage.future_object','SELECT') as allowed")).rows[0].allowed, true)
    await db.exec('create role separate_owner; grant create on schema public to separate_owner; alter default privileges for role separate_owner in schema public grant select on tables to anon; set role separate_owner; create table public.other_creator (id integer); reset role;')
    assert.equal((await db.query("select has_table_privilege('anon','public.other_creator','SELECT') as allowed")).rows[0].allowed, true)
  } finally { await db.close() }
})

test('permissions migration is repeatable without altering records, policies, or existing server grants', async () => {
  const db = await fixture()
  try {
    await db.exec("insert into public.order_requests values (1,'preserved'); grant truncate on public.order_requests to service_role;")
    const before = (await db.query("select * from pg_policies where schemaname='public'")).rows
    await db.exec(migration)
    assert.deepEqual((await db.query('select * from public.order_requests')).rows, [{ id: 1, payload: 'preserved' }])
    assert.deepEqual((await db.query("select * from pg_policies where schemaname='public'")).rows, before)
    assert.equal((await db.query("select has_table_privilege('service_role','public.order_requests','TRUNCATE') as allowed")).rows[0].allowed, true)
  } finally { await db.close() }
})

test('fresh installations without optional project-maintenance objects are supported', async () => {
  const db = await fixture({ maintenance: false })
  try {
    await db.exec(migration)
    assert.equal((await db.query("select to_regclass('public.project_maintenance') as relation")).rows[0].relation, null)
  } finally { await db.close() }
})

test('the actual Section 6 counter RPC remains usable exclusively by the server role', async () => {
  const db = await fixture({ quotas: true })
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await permissionDenied(db, "select * from public.consume_app_rate_limit('11111111-1111-4111-8111-111111111111','submit_order')")
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    const result = await db.query("select * from public.consume_app_rate_limit('11111111-1111-4111-8111-111111111111','submit_order')")
    assert.deepEqual(result.rows, [{ allowed: true, retry_after_seconds: 0 }])
  } finally { await db.close() }
})
