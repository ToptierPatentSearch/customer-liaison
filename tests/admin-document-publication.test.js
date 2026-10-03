import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'

// Exercise the actual component callbacks without a browser or a second React runtime.
const source = await readFile(new URL('../src/AdminDashboard.jsx', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function WorkspaceDocuments('), source.indexOf('function DiscussionList('))
const compiled = await transform(`${component}\nreturn WorkspaceDocuments`, {
  loader: 'jsx', jsxFactory: 'h', format: 'cjs',
})

function elements(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...(node.children || []).flat(Infinity).flatMap(elements)]
}

for (const outcome of ['notification-failure', 'success', 'refresh-failure', 'registration-failure']) {
  test(`document publisher clears/reloads only committed uploads: ${outcome}`, async () => {
    const file = { name: 'report.pdf', size: 2048, type: 'application/pdf' }
    const state = [true, [], { type: 'idle', message: '' }, '', [file], 'report']
    let cursor = 0
    const input = { current: { value: 'report.pdf' } }
    const calls = []
    const warning = 'Documents published; client notification failed. Do not upload again.'
    const saved = { id: 'document-id', original_name: file.name }
    const supabase = {
      functions: {
        async invoke(_name, { body }) {
          calls.push(body.action)
          if (body.action === 'create-workspace-upload') return {
            data: { ok: true, bucket: 'workspace', uploads: [{ storagePath: 'path', token: 'token' }] }, error: null,
          }
          if (body.action === 'register-workspace-documents') return outcome === 'registration-failure'
            ? { data: null, error: new Error('Registration failed') }
            : { data: { ok: true, documents: [saved], notificationCreated: outcome === 'success', warning }, error: null }
          if (body.action === 'list-workspace-documents') return outcome === 'refresh-failure'
            ? { data: null, error: new Error('Refresh failed') }
            : { data: { ok: true, documents: [saved] }, error: null }
          throw new Error(`Unexpected action ${body.action}`)
        },
      },
      storage: { from: () => ({ uploadToSignedUrl: async () => ({ error: null }) }) },
    }
    const useState = () => {
      const index = cursor++
      return [state[index], value => { state[index] = value }]
    }
    const h = (type, props, ...children) => ({ type, props: props || {}, children })
    const render = new Function('useState', 'useRef', 'supabase', 'invokeFunction', 'h', 'textOrDash', 'fileSize', 'formatDateTime', compiled.code)(
      useState, () => input, supabase, (...args) => supabase.functions.invoke(...args), h, value => value, () => '2 KB', () => 'today',
    )
    let tree = render({ recordType: 'discussion', recordId: 'request-id' })
    const publish = elements(tree).find(el => el.type === 'button' && el.children.includes('Publish Documents'))
    await publish.props.onClick()
    if (outcome === 'registration-failure') {
      assert.deepEqual(state[4], [file])
      assert.equal(input.current.value, 'report.pdf')
      assert.equal(state[2].type, 'error')
      assert.equal(calls.includes('list-workspace-documents'), false)
      return
    }
    assert.deepEqual(state[4], [])
    assert.equal(input.current.value, '')
    assert.equal(calls.filter(action => action === 'create-workspace-upload').length, 1)
    assert.equal(calls.at(-1), 'list-workspace-documents')
    assert.equal(state[2].type, outcome === 'success' ? 'success' : 'warning')
    if (outcome !== 'success') assert.ok(state[2].message.includes(warning))
    if (outcome === 'refresh-failure') assert.match(state[2].message, /could not be refreshed/)
    else assert.deepEqual(state[1], [saved])
    cursor = 0
    tree = render({ recordType: 'discussion', recordId: 'request-id' })
    const updatedPublish = elements(tree).find(el => el.type === 'button' && el.children.includes('Publish Documents'))
    assert.equal(updatedPublish.props.disabled, true)
    const feedback = elements(tree).find(el => el.props.className === `conversation-feedback ${state[2].type}`)
    assert.equal(feedback.children[0], state[2].message)
  })
}
