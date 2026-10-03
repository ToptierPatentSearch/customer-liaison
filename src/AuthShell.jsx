import { useEffect, useState } from 'react'
import App from './App.jsx'
import { supabase } from './lib/supabaseClient'

function getAuthRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString()
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function clearAuthHash() {
  if (!window.location.hash) return
  const cleanUrl = `${window.location.pathname}${window.location.search}`
  window.history.replaceState({}, document.title, cleanUrl)
}

export default function AuthShell() {
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [authMode, setAuthMode] = useState('signin')
  const [authForm, setAuthForm] = useState({ email: '', password: '' })
  const [authStatus, setAuthStatus] = useState({ type: 'idle', message: '' })
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [passwordResetForm, setPasswordResetForm] = useState({ password: '', confirmPassword: '' })
  const [passwordResetStatus, setPasswordResetStatus] = useState({ type: 'idle', message: '' })

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) {
        setAuthStatus({ type: 'error', message: error.message })
      }
      setSession(data?.session ?? null)
      setAuthReady(true)
    })

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return

      // Backward-compatible fallback for a valid recovery link.
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordRecovery(true)
        setPasswordResetStatus({ type: 'idle', message: '' })
        clearAuthHash()
      }

      setSession(nextSession)
      setAuthReady(true)
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  function updateAuthField(event) {
    const { name, value } = event.target
    setAuthForm((current) => ({ ...current, [name]: value }))
  }

  function updateRecoveryCode(event) {
    setRecoveryCode(event.target.value.replace(/\D/g, '').slice(0, 6))
  }

  function updatePasswordResetField(event) {
    const { name, value } = event.target
    setPasswordResetForm((current) => ({ ...current, [name]: value }))
  }

  function changeAuthMode(nextMode) {
    setAuthMode(nextMode)
    setAuthStatus({ type: 'idle', message: '' })
    setAuthForm((current) => ({ ...current, password: '' }))
    if (nextMode !== 'verify-recovery') {
      setRecoveryCode('')
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault()

    const email = authForm.email.trim().toLowerCase()
    if (!email) {
      setAuthStatus({ type: 'error', message: 'Please enter your email address.' })
      return
    }
    if (!isValidEmail(email)) {
      setAuthStatus({ type: 'error', message: 'Please enter a valid email address.' })
      return
    }

    if (authMode === 'forgot') {
      setAuthStatus({ type: 'loading', message: 'Sending recovery code…' })

      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email)
        if (error) throw error

        setRecoveryEmail(email)
        setRecoveryCode('')
        setAuthMode('verify-recovery')
        setAuthStatus({
          type: 'success',
          message: 'If an account exists for this email address, a 6-digit recovery code has been sent. Enter the newest code from the email below.',
        })
      } catch (error) {
        console.error('Password reset request failed:', error)
        const isRateLimited = error?.status === 429 || error?.code === 'over_email_send_rate_limit'
        setAuthStatus({
          type: 'error',
          message: isRateLimited
            ? 'Please wait about 60 seconds before requesting another recovery code.'
            : 'The recovery email could not be sent right now. Please wait and try again.',
        })
      }
      return
    }

    if (!authForm.password) {
      setAuthStatus({ type: 'error', message: 'Please enter your password.' })
      return
    }
    if (authMode === 'signup' && authForm.password.length < 8) {
      setAuthStatus({ type: 'error', message: 'Please use a password with at least 8 characters.' })
      return
    }

    setAuthStatus({ type: 'loading', message: authMode === 'signin' ? 'Signing in…' : 'Creating account…' })

    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password: authForm.password,
        })
        if (error) throw error

        setAuthStatus({ type: 'success', message: 'Signed in successfully.' })
        setAuthForm((current) => ({ ...current, password: '' }))
        return
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password: authForm.password,
        options: {
          emailRedirectTo: getAuthRedirectUrl(),
        },
      })
      if (error) throw error

      setAuthForm((current) => ({ ...current, password: '' }))
      if (data.session) {
        setAuthStatus({ type: 'success', message: 'Account created and signed in.' })
      } else {
        setAuthStatus({
          type: 'success',
          message: 'Account created. Please check your email and confirm the account before signing in.',
        })
        setAuthMode('signin')
      }
    } catch (error) {
      setAuthStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Authentication failed.',
      })
    }
  }

  async function handleRecoveryCodeSubmit(event) {
    event.preventDefault()

    const token = recoveryCode.trim()
    if (!recoveryEmail || !isValidEmail(recoveryEmail)) {
      setAuthStatus({ type: 'error', message: 'Please request a new recovery code.' })
      setAuthMode('forgot')
      return
    }
    if (!/^\d{6}$/.test(token)) {
      setAuthStatus({ type: 'error', message: 'Please enter the 6-digit recovery code from the email.' })
      return
    }

    setAuthStatus({ type: 'loading', message: 'Verifying recovery code…' })

    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: recoveryEmail,
        token,
        type: 'recovery',
      })
      if (error) throw error
      if (!data?.session) throw new Error('No recovery session was created.')

      setSession(data.session)
      setPasswordRecovery(true)
      setRecoveryCode('')
      setAuthStatus({ type: 'idle', message: '' })
      setPasswordResetStatus({ type: 'idle', message: '' })
    } catch (error) {
      console.error('Recovery code verification failed:', error)
      setAuthStatus({
        type: 'error',
        message: 'The recovery code is invalid or expired. Use the newest code, or request a new one.',
      })
    }
  }

  async function handlePasswordResetSubmit(event) {
    event.preventDefault()

    const { password, confirmPassword } = passwordResetForm
    if (!password) {
      setPasswordResetStatus({ type: 'error', message: 'Please enter a new password.' })
      return
    }
    if (password.length < 8) {
      setPasswordResetStatus({ type: 'error', message: 'Please use a password with at least 8 characters.' })
      return
    }
    if (password !== confirmPassword) {
      setPasswordResetStatus({ type: 'error', message: 'The two password entries do not match.' })
      return
    }

    setPasswordResetStatus({ type: 'loading', message: 'Updating your password…' })

    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error

      setPasswordResetForm({ password: '', confirmPassword: '' })
      setPasswordResetStatus({
        type: 'success',
        message: 'Your password has been updated successfully. You can continue to Customer Liaison.',
      })
    } catch (error) {
      console.error('Password update failed:', error)
      setPasswordResetStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'The password could not be updated.',
      })
    }
  }

  function continueAfterPasswordReset() {
    setPasswordRecovery(false)
    setRecoveryEmail('')
    setRecoveryCode('')
    setPasswordResetStatus({ type: 'idle', message: '' })
  }

  if (!authReady) {
    return (
      <main className="page-shell">
        <section className="form-card" aria-labelledby="order-form-title">
          <header className="intro">
            <p className="eyebrow">Top-tier Patent Search</p>
            <h1 id="order-form-title">Provide Your Order Details</h1>
            <p>Secure sign-in is required before confidential order details can be submitted.</p>
          </header>
          <div className="auth-panel auth-loading" role="status">Checking your account session…</div>
        </section>
      </main>
    )
  }

  if (passwordRecovery && session) {
    return (
      <main className="page-shell">
        <section className="form-card" aria-labelledby="password-reset-title">
          <header className="intro">
            <p className="eyebrow">Top-tier Patent Search</p>
            <h1 id="password-reset-title">Reset Your Password</h1>
            <p>Choose a new password for your Customer Liaison account.</p>
          </header>
          <PasswordResetPanel
            form={passwordResetForm}
            status={passwordResetStatus}
            onChange={updatePasswordResetField}
            onSubmit={handlePasswordResetSubmit}
            onContinue={continueAfterPasswordReset}
          />
        </section>
      </main>
    )
  }

  if (!session && authMode === 'verify-recovery') {
    return (
      <main className="page-shell">
        <section className="form-card" aria-labelledby="recovery-code-title">
          <header className="intro">
            <p className="eyebrow">Top-tier Patent Search</p>
            <h1 id="recovery-code-title">Verify Recovery Code</h1>
            <p>Enter the 6-digit code sent to your email address.</p>
          </header>
          <RecoveryCodePanel
            email={recoveryEmail}
            code={recoveryCode}
            status={authStatus}
            onChange={updateRecoveryCode}
            onSubmit={handleRecoveryCodeSubmit}
            onRequestNew={() => {
              setAuthForm((current) => ({ ...current, email: recoveryEmail, password: '' }))
              changeAuthMode('forgot')
            }}
            onSignIn={() => changeAuthMode('signin')}
          />
        </section>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="page-shell">
        <section className="form-card" aria-labelledby="order-form-title">
          <header className="intro">
            <p className="eyebrow">Top-tier Patent Search</p>
            <h1 id="order-form-title">Provide Your Order Details</h1>
            <p>Sign in or create an account before providing confidential assignment information.</p>
          </header>
          <AuthPanel
            mode={authMode}
            form={authForm}
            status={authStatus}
            onChange={updateAuthField}
            onSubmit={handleAuthSubmit}
            onModeChange={changeAuthMode}
          />
        </section>
      </main>
    )
  }

  return <App />
}

function AuthPanel({ mode, form, status, onChange, onSubmit, onModeChange }) {
  const isSignIn = mode === 'signin'
  const isForgot = mode === 'forgot'

  let heading = 'Create your account'
  let description = 'Create an account to protect order details and supporting documents.'
  if (isSignIn) {
    heading = 'Sign in to continue'
    description = 'Use the account associated with your order request.'
  } else if (isForgot) {
    heading = 'Reset your password'
    description = 'Enter the email address associated with your account. We will send a 6-digit recovery code.'
  }

  return (
    <div className="auth-panel">
      <div className="auth-heading">
        <p className="auth-kicker">Secure client access</p>
        <h2>{heading}</h2>
        <p>{description}</p>
      </div>

      {status.type !== 'idle' && (
        <div className={`status auth-status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
          <strong>{status.type === 'error' ? 'Authentication issue' : status.type === 'loading' ? 'Processing' : 'Account update'}</strong>
          <span>{status.message}</span>
        </div>
      )}

      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <Field label="Email address" required>
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={onChange}
            autoComplete="email"
            required
            maxLength="254"
          />
        </Field>

        {!isForgot && (
          <Field label="Password" required hint={isSignIn ? '' : 'Use at least 8 characters.'}>
            <input
              type="password"
              name="password"
              value={form.password}
              onChange={onChange}
              autoComplete={isSignIn ? 'current-password' : 'new-password'}
              required
              minLength={isSignIn ? undefined : 8}
            />
          </Field>
        )}

        <button className="primary-button auth-submit" type="submit" disabled={status.type === 'loading'}>
          {status.type === 'loading'
            ? (isForgot ? 'Sending code…' : isSignIn ? 'Signing in…' : 'Creating account…')
            : (isForgot ? 'Send Recovery Code' : isSignIn ? 'Sign In' : 'Create Account')}
        </button>
      </form>

      {isSignIn && (
        <div className="auth-switch">
          <button type="button" className="text-button" onClick={() => onModeChange('forgot')}>
            Forgot password?
          </button>
        </div>
      )}

      <div className="auth-switch">
        <span>{isForgot ? 'Remember your password?' : isSignIn ? 'Need an account?' : 'Already have an account?'}</span>
        <button
          type="button"
          className="text-button"
          onClick={() => onModeChange(isSignIn ? 'signup' : 'signin')}
        >
          {isForgot ? 'Sign in' : isSignIn ? 'Create account' : 'Sign in'}
        </button>
      </div>
    </div>
  )
}

function RecoveryCodePanel({ email, code, status, onChange, onSubmit, onRequestNew, onSignIn }) {
  return (
    <div className="auth-panel">
      <div className="auth-heading">
        <p className="auth-kicker">Account recovery</p>
        <h2>Enter your recovery code</h2>
        <p>Use the newest 6-digit code sent to {email || 'your email address'}.</p>
      </div>

      {status.type !== 'idle' && (
        <div className={`status auth-status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
          <strong>{status.type === 'error' ? 'Recovery issue' : status.type === 'loading' ? 'Processing' : 'Recovery email sent'}</strong>
          <span>{status.message}</span>
        </div>
      )}

      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <Field label="6-digit recovery code" required hint="Enter digits only.">
          <input
            type="text"
            name="recoveryCode"
            value={code}
            onChange={onChange}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength="6"
            required
          />
        </Field>
        <button className="primary-button auth-submit" type="submit" disabled={status.type === 'loading'}>
          {status.type === 'loading' ? 'Verifying code…' : 'Verify Code'}
        </button>
      </form>

      <div className="auth-switch">
        <button type="button" className="text-button" onClick={onRequestNew}>Request a new code</button>
        <span>·</span>
        <button type="button" className="text-button" onClick={onSignIn}>Back to sign in</button>
      </div>
    </div>
  )
}

function PasswordResetPanel({ form, status, onChange, onSubmit, onContinue }) {
  return (
    <div className="auth-panel">
      <div className="auth-heading">
        <p className="auth-kicker">Account security</p>
        <h2>Set a new password</h2>
        <p>Use at least 8 characters. Enter the new password twice to prevent typing mistakes.</p>
      </div>

      {status.type !== 'idle' && (
        <div className={`status auth-status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
          <strong>{status.type === 'error' ? 'Password update issue' : status.type === 'loading' ? 'Processing' : 'Password updated'}</strong>
          <span>{status.message}</span>
        </div>
      )}

      {status.type !== 'success' ? (
        <form className="auth-form" onSubmit={onSubmit} noValidate>
          <Field label="New password" required hint="Use at least 8 characters.">
            <input
              type="password"
              name="password"
              value={form.password}
              onChange={onChange}
              autoComplete="new-password"
              required
              minLength="8"
            />
          </Field>
          <Field label="Confirm new password" required>
            <input
              type="password"
              name="confirmPassword"
              value={form.confirmPassword}
              onChange={onChange}
              autoComplete="new-password"
              required
              minLength="8"
            />
          </Field>
          <button className="primary-button auth-submit" type="submit" disabled={status.type === 'loading'}>
            {status.type === 'loading' ? 'Updating password…' : 'Update Password'}
          </button>
        </form>
      ) : (
        <div className="auth-switch">
          <button type="button" className="primary-button" onClick={onContinue}>
            Continue to Customer Liaison
          </button>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, required = false, children }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}{required && <span className="required"> *</span>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}
