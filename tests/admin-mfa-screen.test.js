import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'
import { authenticatorQrSource, loadAdminFactors, startAdminEnrollment, verifyAdminFactor } from '../src/lib/adminMfa.js'

const h = (type, props, ...children) => ({ type, props: props || {}, children })
const elements = (node) => !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flat(Infinity).flatMap(elements)]
const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const gate = appSource.slice(appSource.indexOf('  if (\n    authReady &&'), appSource.indexOf('  if (!authReady)'))
const gateCode = await transform(`${gate}\nreturn null`, { loader: 'jsx', jsxFactory: 'h', format: 'cjs' })
const renderGate = new Function('authReady', 'session', 'view', 'adminAccess', 'AdminMfa', 'AdminDashboard', 'setAdminCheckVersion', 'navigateView', 'handleSignOut', 'h', gateCode.code)

test('dashboard stays hidden until MFA and account checks match the current session', () => {
  const session = { user: { id: 'admin-user', email: 'admin@example.test' }, access_token: 'current' }
  for (const access of [
    { checked: false },
    { checked: true, isAdmin: true, mfaVerified: true, token: 'previous' },
    { checked: true, isAdmin: false, mfaVerified: true, token: 'current' },
  ]) {
    const tree = renderGate(true, session, 'admin', access, 'Mfa', 'Dashboard', () => {}, () => {}, () => {}, h)
    assert.equal(elements(tree).some((element) => element.type === 'Dashboard'), false)
  }
  const access = { checked: true, isAdmin: true, token: 'current', mfaVerified: false }
  assert.equal(renderGate(true, session, 'admin', access, 'Mfa', 'Dashboard', () => {}, () => {}, () => {}, h).type, 'Mfa')
  access.mfaVerified = true
  assert.equal(renderGate(true, session, 'admin', access, 'Mfa', 'Dashboard', () => {}, () => {}, () => {}, h).type, 'Dashboard')
  assert.equal(renderGate(true, session, 'order', access, 'Mfa', 'Dashboard', () => {}, () => {}, () => {}, h), null)
})

const screenSource = await readFile(new URL('../src/AdminMfa.jsx', import.meta.url), 'utf8')
const component = screenSource.slice(screenSource.indexOf('export default function')).replace('export default ', '')
const compiled = await transform(`${component}\nreturn AdminMfa`, { loader: 'jsx', jsxFactory: 'h', jsxFragment: 'Fragment', format: 'cjs' })

for (const cleanupFailure of [false, true]) {
  test(`cancel and sign-out remain available during unfinished setup: cleanup failure=${cleanupFailure}`, async () => {
    for (const label of ['Back to client view', 'Sign out']) {
      const enrollment = { id: 'new-unverified-factor', totp: { qr_code: '<svg></svg>', secret: 'fake-test-key' } }
      const state = [{ verified: [], unsupported: false }, enrollment.id, enrollment, '', false, '', 0]
      const refs = [{ current: true }, { current: false }]
      const calls = []
      let cursor = 0
      let refCursor = 0
      const useState = () => {
        const index = cursor++
        return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
      }
      const supabase = { auth: { mfa: { unenroll: async ({ factorId }) => {
        calls.push(factorId)
        return { error: cleanupFailure ? new Error('offline') : null }
      } } } }
      const render = new Function('useEffect', 'useRef', 'useState', 'supabase', 'authenticatorQrSource', 'loadAdminFactors', 'startAdminEnrollment', 'verifyAdminFactor', 'h', 'Fragment', compiled.code)(
        () => {}, () => refs[refCursor++], useState, supabase, authenticatorQrSource, loadAdminFactors, startAdminEnrollment, verifyAdminFactor, h, 'Fragment',
      )
      const tree = render({ adminEmail: 'admin@example.test', onVerified: () => assert.fail('must not open dashboard'), onBack: () => calls.push('back'), onSignOut: () => calls.push('signout') })
      const button = elements(tree).find((element) => element.type === 'button' && element.children.includes(label))
      await button.props.onClick()
      assert.deepEqual(calls, ['new-unverified-factor', label === 'Sign out' ? 'signout' : 'back'])
      if (!cleanupFailure) assert.equal(state[2], null)
    }
  })
}
