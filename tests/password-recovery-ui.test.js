import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const authShellSource = await readFile(new URL('../src/AuthShell.jsx', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8')

test('application entry point uses the authentication recovery shell', () => {
  assert.match(mainSource, /import AuthShell from ['"]\.\/AuthShell\.jsx['"]/)
  assert.match(mainSource, /<AuthShell \/>/)
})

test('sign-in UI exposes forgot-password recovery', () => {
  assert.match(authShellSource, /Forgot password\?/)
  assert.match(authShellSource, /resetPasswordForEmail\(email/)
  assert.match(authShellSource, /redirectTo: getAuthRedirectUrl\(\)/)
})

test('password recovery link is handled before the application is shown', () => {
  assert.match(authShellSource, /event === ['"]PASSWORD_RECOVERY['"]/)
  assert.match(authShellSource, /passwordRecovery && session/)
  assert.match(authShellSource, /updateUser\(\{ password \}\)/)
})

test('password recovery validates minimum length and confirmation', () => {
  assert.match(authShellSource, /password\.length < 8/)
  assert.match(authShellSource, /password !== confirmPassword/)
  assert.match(authShellSource, /Your password has been updated successfully/)
})

test('forgot-password response does not disclose whether an account exists', () => {
  assert.match(authShellSource, /If an account exists for this email address/)
})
