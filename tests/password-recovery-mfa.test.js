import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadRecoveryMfaRequirement, verifyRecoveryMfaFactor } from '../src/lib/recoveryMfa.js'

const authShellSource = await readFile(new URL('../src/AuthShell.jsx', import.meta.url), 'utf8')
const recoveryPanelSource = await readFile(new URL('../src/RecoveryPasswordReset.jsx', import.meta.url), 'utf8')
const recoveryMfaSource = await readFile(new URL('../src/lib/recoveryMfa.js', import.meta.url), 'utf8')

test('password recovery uses the MFA-aware reset panel', () => {
  assert.match(authShellSource, /import RecoveryPasswordReset from ['"]\.\/RecoveryPasswordReset\.jsx['"]/)
  assert.match(authShellSource, /<RecoveryPasswordReset onContinue=\{continueAfterPasswordReset\} \/>/)
})

test('AAL2 sessions can update the password without another challenge', async () => {
  let listFactorsCalled = false
  const result = await loadRecoveryMfaRequirement({
    async getAuthenticatorAssuranceLevel() {
      return { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }
    },
    async listFactors() {
      listFactorsCalled = true
      return { data: { all: [] }, error: null }
    },
  })

  assert.equal(result.required, false)
  assert.equal(listFactorsCalled, false)
})

test('verified TOTP factor requires an MFA challenge during recovery', async () => {
  const result = await loadRecoveryMfaRequirement({
    async getAuthenticatorAssuranceLevel() {
      return { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null }
    },
    async listFactors() {
      return {
        data: {
          all: [
            { id: 'factor-1', status: 'verified', factor_type: 'totp', friendly_name: 'Authenticator' },
          ],
        },
        error: null,
      }
    },
  })

  assert.equal(result.required, true)
  assert.equal(result.factors.length, 1)
  assert.equal(result.factors[0].id, 'factor-1')
  assert.equal(result.unsupported, false)
})

test('recovery MFA challenge must upgrade the session to AAL2', async () => {
  let challenged = false
  await verifyRecoveryMfaFactor({
    async challengeAndVerify({ factorId, code }) {
      challenged = true
      assert.equal(factorId, 'factor-1')
      assert.equal(code, '123456')
      return { data: { access_token: 'token' }, error: null }
    },
    async getAuthenticatorAssuranceLevel() {
      return { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }
    },
  }, 'factor-1', '123456')

  assert.equal(challenged, true)
})

test('recovery UI handles Supabase insufficient_aal as an MFA step', () => {
  assert.match(recoveryPanelSource, /insufficient_aal/)
  assert.match(recoveryMfaSource, /challengeAndVerify/)
  assert.match(recoveryPanelSource, /Verify your authenticator/)
  assert.match(recoveryPanelSource, /Verify and Continue/)
  assert.match(recoveryPanelSource, /updateUser\(\{ password \}\)/)
})

test('MFA screen clearly distinguishes authenticator code from email recovery code', () => {
  assert.match(recoveryPanelSource, /Do not enter the recovery code from the email here/)
  assert.match(recoveryPanelSource, /authenticator app previously registered with this account/)
  assert.match(recoveryPanelSource, /The email recovery code is not used on this screen/)
  assert.match(recoveryPanelSource, /Authenticator app code/)
  assert.match(recoveryPanelSource, /slice\(0, 10\)/)
  assert.match(recoveryPanelSource, /maxLength="10"/)
})
