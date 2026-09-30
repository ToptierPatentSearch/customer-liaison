import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'

const requestId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const documentId = '55555555-5555-4555-8555-555555555555'

async function importTypescriptModule(path, exportsList) {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8'))
    .replace("import { withSupabase } from 'npm:@supabase/server@^1'", 'const withSupabase = (_options, handler) => handler')
  const compiled = await transform(
    `${source}\nexport { ${exportsList.join(', ')} }`,
    { loader: 'ts', format: 'esm' },
  )
  return import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`)
}

const myRequestsModule = await importTypescriptModule(
  '../supabase/functions/my-requests/index.ts',
  ['createDocumentUploads', 'registerDocuments'],
)
const adminOrdersModule = await importTypescriptModule(
  '../supabase/functions/admin-orders/index.ts',
  ['registerWorkspaceDocuments', 'adminWorkspacePath'],
)

function finalRequestContext(status) {
  let storageCalls = 0
  let documentTableCalls = 0

  return {
    get storageCalls() { return storageCalls },
    get documentTableCalls() { return documentTableCalls },
    ctx: {
      supabaseAdmin: {
        from(table) {
          if (table === 'project_discussions') {
            const query = {
              select() { return query },
              eq() { return query },
              async maybeSingle() {
                return { data: { id: requestId, status }, error: null }
              },
            }
            return query
          }

          if (table === 'request_documents') {
            documentTableCalls += 1
          }

          throw new Error(`Unexpected table ${table}`)
        },
        storage: {
          from() {
            storageCalls += 1
            throw new Error('Storage must not be reached for a final request.')
          },
        },
      },
    },
  }
}

test('client upload-link creation is rejected after a request becomes final', async () => {
  const db = finalRequestContext('completed')
  const response = await myRequestsModule.createDocumentUploads(db.ctx, userId, {
    requestType: 'discussion',
    requestId,
    files: [{ name: 'claims.pdf', size: 2048, type: 'application/pdf' }],
  })

  assert.equal(response.status, 409)
  assert.equal(db.storageCalls, 0)
  assert.equal(db.documentTableCalls, 0)
})

test('client document registration re-checks final status after upload-link creation', async () => {
  const db = finalRequestContext('closed')
  const response = await myRequestsModule.registerDocuments(db.ctx, userId, {
    requestType: 'discussion',
    requestId,
    documents: [{
      documentId,
      storagePath: `${userId}/discussion/${requestId}/${documentId}-claims.pdf`,
      originalName: 'claims.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    }],
  })

  assert.equal(response.status, 409)
  assert.equal(db.documentTableCalls, 0)
})

test('administrator discussion view exposes workspace documents', async () => {
  const source = await readFile(new URL('../src/AdminDashboard.jsx', import.meta.url), 'utf8')
  const start = source.indexOf('function DiscussionList')
  const end = source.indexOf('function QuoteList')
  assert.ok(start >= 0 && end > start)
  const discussionList = source.slice(start, end)
  assert.match(
    discussionList,
    /<WorkspaceDocuments recordType="discussion" recordId=\{discussion\.id\} \/>/,
  )
})

test('administrator publication reports notification insertion failures', async () => {
  let touched = false
  const originalName = 'report.pdf'
  const storagePath = adminOrdersModule.adminWorkspacePath(
    'discussion',
    requestId,
    documentId,
    originalName,
  )

  const ctx = {
    supabaseAdmin: {
      from(table) {
        if (table === 'project_discussions') {
          const lookup = {
            select() { return lookup },
            eq() { return lookup },
            async maybeSingle() {
              return { data: { id: requestId, user_id: userId }, error: null }
            },
            update() {
              touched = true
              return { eq: async () => ({ error: null }) }
            },
          }
          return lookup
        }

        if (table === 'request_documents') {
          return {
            upsert() {
              return {
                async select() {
                  return {
                    data: [{
                      id: documentId,
                      original_name: originalName,
                      content_type: 'application/pdf',
                      size_bytes: 2048,
                      category: 'report',
                      uploader_role: 'admin',
                      visible_to_client: true,
                      created_at: new Date().toISOString(),
                    }],
                    error: null,
                  }
                },
              }
            },
          }
        }

        if (table === 'request_replies') {
          return {
            async insert() {
              return { error: new Error('notification insert failed') }
            },
          }
        }

        throw new Error(`Unexpected table ${table}`)
      },
    },
  }

  const response = await adminOrdersModule.registerWorkspaceDocuments(ctx, userId, {
    recordType: 'discussion',
    recordId: requestId,
    category: 'report',
    documents: [{
      documentId,
      storagePath,
      originalName,
      contentType: 'application/pdf',
      sizeBytes: 2048,
    }],
  })
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error, /notification could not be created/i)
  assert.equal(touched, false)
})
