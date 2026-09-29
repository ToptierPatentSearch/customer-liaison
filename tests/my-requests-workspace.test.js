import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'

const source = (await readFile(new URL('../supabase/functions/my-requests/index.ts', import.meta.url), 'utf8'))
  .replace("import { withSupabase } from 'npm:@supabase/server@^1'", 'const withSupabase = (_options, handler) => handler')
const compiled = await transform(
  `${source}\nexport { markMessagesSeen, normalizeUploadFiles, workspaceDocumentPath }`,
  { loader: 'ts', format: 'esm' },
)
const { markMessagesSeen, normalizeUploadFiles, workspaceDocumentPath } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
)

const requestId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const message1 = '33333333-3333-4333-8333-333333333333'
const message2 = '44444444-4444-4444-8444-444444444444'

function messageDatabase() {
  const updates = []
  return {
    updates,
    ctx: {
      supabaseAdmin: {
        from(table) {
          if (table === 'project_discussions') {
            const query = {
              select() { return query },
              eq() { return query },
              async maybeSingle() {
                return { data: { id: requestId }, error: null }
              },
            }
            return query
          }

          if (table === 'request_replies') {
            return {
              update(values) {
                const query = {
                  eq() { return query },
                  in(_column, ids) {
                    updates.push({ values, ids })
                    return query
                  },
                  async is() { return { error: null } },
                }
                return query
              },
            }
          }

          throw new Error(`Unexpected table ${table}`)
        },
      },
    },
  }
}

test('message acknowledgment marks only the exact rendered administrator message IDs', async () => {
  const db = messageDatabase()
  const response = await markMessagesSeen(db.ctx, userId, {
    requestType: 'discussion',
    requestId,
    messageIds: [message1, message2],
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(body.messageIds, [message1, message2])
  assert.deepEqual(db.updates[0].ids, [message1, message2])
})

test('message acknowledgment rejects missing and invalid message IDs', async () => {
  for (const messageIds of [[], ['not-a-uuid']]) {
    const db = messageDatabase()
    const response = await markMessagesSeen(db.ctx, userId, {
      requestType: 'discussion',
      requestId,
      messageIds,
    })
    assert.equal(response.status, 400)
    assert.equal(db.updates.length, 0)
  }
})

test('workspace uploads enforce supported file types and 10 MB limit', () => {
  const files = normalizeUploadFiles([
    { name: 'claims.pdf', size: 2048, type: 'application/pdf' },
    { name: 'results.xlsx', size: 4096, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ])
  assert.equal(files.length, 2)

  assert.throws(
    () => normalizeUploadFiles([{ name: 'archive.exe', size: 12, type: 'application/octet-stream' }]),
    /unsupported file type/,
  )
  assert.throws(
    () => normalizeUploadFiles([{ name: 'large.pdf', size: 10 * 1024 * 1024 + 1, type: 'application/pdf' }]),
    /10 MB or smaller/,
  )
})

test('workspace paths are deterministic and scoped to user and request', () => {
  const documentId = '55555555-5555-4555-8555-555555555555'
  assert.equal(
    workspaceDocumentPath(userId, 'discussion', requestId, documentId, 'claim chart (final).pdf'),
    `${userId}/discussion/${requestId}/${documentId}-claim_chart_final_.pdf`,
  )
})
