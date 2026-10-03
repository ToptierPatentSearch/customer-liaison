import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const authShellSource = await readFile(new URL('../src/AuthShell.jsx', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8')

test('application entry point uses the authentication recovery shell', () => {
  assert.match(mainSource, /import AuthShell from ['"]\.\/AuthShell\.jsx['"]/)
  assert.match(mainSource, /<AuthShell \/>/)
})

test('sign-in UI exposes forgot-password recovery code flow', () => {
  assert.match(authShellSource, /Forgot password\?/)
  assert.match(authShellSource, /resetPasswordForEmail\(email\)/)
  assert.match(authShellSource, /Send Recovery Code/)
  assert.match(authShellSource, /recovery code/)
})

test('recovery code is verified as a recovery OTP', () => {
  assert.match(authShellSource, /verifyOtp\(\{/)
  assert.match(authShellSource, /email: recoveryEmail/)
  assert.match(authShellSource, /type: ['"]recovery['"]/)
  assert.match(authShellSource, /\^\\d\{6,10\}\$/)
})

test('verified recovery session opens the password reset form', () => {
  assert.match(authShellSource, /setPasswordRecovery\(true\)/)
  assert.match(authShellSource, /passwordRecovery && session/)
  assert.match(authShellSource, /updateUser\(\{ password \}\)/)
})

test('valid recovery links remain supported as a fallback', () => {
  assert.match(authShellSource, /event === ['"]PASSWORD_RECOVERY['"]/)
})

test('password recovery validates minimum length and confirmation', () => {
  assert.match(authShellSource, /password\.length < 12/)
  assert.match(authShellSource, /password !== confirmPassword/)
  assert.match(authShellSource, /Your password has been updated successfully/)
})

test('rate-limited recovery requests receive a specific message', () => {
  assert.match(authShellSource, /over_email_send_rate_limit/)
  assert.match(authShellSource, /Too many recovery emails have been requested\. Please wait and try again later\./)
  assert.doesNotMatch(authShellSource, /wait about 60 seconds/)
})
