import assert from 'node:assert/strict'
import test from 'node:test'
import { importEdgeFunction } from './helpers/importEdgeFunction.js'

const { markStatusSeen } = await importEdgeFunction(new URL('../supabase/functions/my-requests/index.ts', import.meta.url), ['markStatusSeen'])

const requestId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

function database(currentVersion, initialSeen = null) {
  let seen = initialSeen
  const writes = []
  return {
    get seen() { return seen },
    writes,
    ctx: {
      supabaseAdmin: {
        from(table) {
          if (table !== 'request_status_views') {
            const query = {
              select() { return query },
              eq() { return query },
              async maybeSingle() { return { data: { id: requestId, status_version: currentVersion }, error: null } },
            }
            return query
          }
          return {
            async upsert(row, options) {
              writes.push({ operation: 'insert', row, options })
              if (seen === null) seen = row.seen_status_version
              return { error: null }
            },
            update(row) {
              const query = {
                eq() { return query },
                async lt(column, version) {
                  writes.push({ operation: 'conditional update', column, version })
                  if (seen < version) seen = row.seen_status_version
                  return { error: null }
                },
              }
              return query
            },
          }
        },
      },
    },
  }
}

async function acknowledge(db, statusVersion) {
  const response = await markStatusSeen(db.ctx, userId, {
    requestType: 'discussion', requestId, statusVersion,
  })
  return { status: response.status, body: await response.json() }
}

test('stale card acknowledges only its rendered version', async () => {
  const db = database(3, 1)
  const result = await acknowledge(db, 2)
  assert.equal(result.status, 200)
  assert.equal(result.body.seenStatusVersion, 2)
  assert.equal(db.seen, 2)
  assert.equal(db.writes[0].options.ignoreDuplicates, true)
  assert.deepEqual(db.writes[1], { operation: 'conditional update', column: 'seen_status_version', version: 2 })
})

test('a stale acknowledgment cannot lower a version seen in another tab', async () => {
  const db = database(3, 3)
  await acknowledge(db, 2)
  assert.equal(db.seen, 3)
})

test('first acknowledgment inserts and later versions advance', async () => {
  const db = database(3)
  await acknowledge(db, 2)
  assert.equal(db.seen, 2)
  await acknowledge(db, 3)
  assert.equal(db.seen, 3)
})

test('missing, fractional, and future versions are rejected before writing', async () => {
  for (const version of [undefined, 1.5, 4, '2']) {
    const db = database(3, 1)
    const result = await acknowledge(db, version)
    assert.equal(result.status, 400)
    assert.equal(db.writes.length, 0)
  }
})
