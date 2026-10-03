import { useCallback, useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { loadRecoveryMfaRequirement, verifyRecoveryMfaFactor } from './lib/recoveryMfa'

const EMPTY_PASSWORD_FORM = { password: '', confirmPassword: '' }

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}

function isInsufficientAal(error) {
  return error?.code === 'insufficient_aal'
    || /AAL2 session is required/i.test(error?.message ?? '')
}

function mfaVerificationMessage(error) {
  const message = errorMessage(error, 'Authenticator verification failed. Please retry.')
  if (/invalid TOTP code/i.test(message)) {
    return 'That authenticator code was not accepted. Open your authenticator app and enter the current 6-digit code shown there.'
  }
  return message
}

export default function RecoveryPasswordReset({ onContinue }) {
  const [phase, setPhase] = useState('checking')
  const [factors, setFactors] = useState([])
  const [factorId, setFactorId] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaStatus, setMfaStatus] = useState({ type: 'idle', message: '' })
  const [passwordForm, setPasswordForm] = useState(EMPTY_PASSWORD_FORM)
  const [passwordStatus, setPasswordStatus] = useState({ type: 'idle', message: '' })

  const checkMfaRequirement = useCallback(async () => {
    setPhase('checking')
    setMfaStatus({ type: 'loading', message: 'Checking whether additional verification is required…' })

    try {
      const requirement = await loadRecoveryMfaRequirement(supabase.auth.mfa)
      if (!requirement.required) {
        setFactors([])
        setFactorId('')
        setMfaCode('')
        setMfaStatus({ type: 'idle', message: '' })
        setPhase('password')
        return false
      }

      setFactors(requirement.factors)
      setFactorId(requirement.factors[0]?.id ?? '')
      setMfaCode('')

      if (!requirement.factors.length) {
        setMfaStatus({
          type: 'error',
          message: requirement.unsupported
            ? 'This account has MFA enabled, but its registered second factor cannot be verified on this recovery screen. Use the enrolled MFA method or contact the project owner for account recovery.'
            : 'MFA is required, but no verified authenticator-app factor is available. Contact the project owner for account recovery.',
        })
        setPhase('mfa')
        return true
      }

      setMfaStatus({ type: 'idle', message: '' })
      setPhase('mfa')
      return true
    } catch (error) {
      console.error('Recovery MFA check failed:', error)
      setFactors([])
      setFactorId('')
      setMfaStatus({
        type: 'error',
        message: errorMessage(error, 'Additional account verification could not be checked. Please retry.'),
      })
      setPhase('mfa-check-error')
      return true
    }
  }, [])

  useEffect(() => {
    void checkMfaRequirement()
  }, [checkMfaRequirement])

  function updatePasswordField(event) {
    const { name, value } = event.target
    setPasswordForm((current) => ({ ...current, [name]: value }))
  }

  function updateMfaCode(event) {
    setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 10))
  }

  async function handleMfaSubmit(event) {
    event.preventDefault()

    if (!factorId) {
      setMfaStatus({ type: 'error', message: 'No verified authenticator is available for this account.' })
      return
    }

    if (!/^\d{6}$/.test(mfaCode)) {
      setMfaStatus({
        type: 'error',
        message: 'The email recovery code is not used on this screen. Open your authenticator app and enter its current 6-digit code.',
      })
      return
    }

    setMfaStatus({ type: 'loading', message: 'Verifying your authenticator…' })
    try {
      await verifyRecoveryMfaFactor(supabase.auth.mfa, factorId, mfaCode)
      setMfaCode('')
      setMfaStatus({ type: 'success', message: 'Additional verification completed.' })
      setPasswordStatus({ type: 'idle', message: '' })
      setPhase('password')
    } catch (error) {
      console.error('Recovery MFA verification failed:', error)
      setMfaStatus({
        type: 'error',
        message: mfaVerificationMessage(error),
      })
    }
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault()

    const { password, confirmPassword } = passwordForm
    if (!password) {
      setPasswordStatus({ type: 'error', message: 'Please enter a new password.' })
      return
    }
    if (password.length < 12) {
      setPasswordStatus({ type: 'error', message: 'Please use a password with at least 12 characters.' })
      return
    }
    if (password !== confirmPassword) {
      setPasswordStatus({ type: 'error', message: 'The two password entries do not match.' })
      return
    }

    setPasswordStatus({ type: 'loading', message: 'Updating your password…' })
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error

      setPasswordForm(EMPTY_PASSWORD_FORM)
      setPasswordStatus({
        type: 'success',
        message: 'Your password has been updated successfully. You can continue to Customer Liaison.',
      })
      setPhase('success')
    } catch (error) {
      console.error('Password update failed:', error)

      if (isInsufficientAal(error)) {
        setPasswordStatus({ type: 'idle', message: '' })
        const needsMfa = await checkMfaRequirement()
        if (needsMfa) {
          setMfaStatus((current) => current.type === 'error' ? current : {
            type: 'idle',
            message: '',
          })
          return
        }
      }

      setPasswordStatus({
        type: 'error',
        message: errorMessage(error, 'The password could not be updated.'),
      })
    }
  }

  if (phase === 'checking') {
    return (
      <div className="auth-panel">
        <div className="auth-heading">
          <p className="auth-kicker">Account security</p>
          <h2>Checking account security</h2>
          <p>Customer Liaison is checking whether your account requires an additional verification step.</p>
        </div>
        <div className="status auth-status status-loading" role="status">
          <strong>Processing</strong>
          <span>{mfaStatus.message || 'Checking account security…'}</span>
        </div>
      </div>
    )
  }

  if (phase === 'mfa-check-error') {
    return (
      <div className="auth-panel">
        <div className="auth-heading">
          <p className="auth-kicker">Account security</p>
          <h2>Additional verification</h2>
          <p>Customer Liaison could not confirm the MFA requirements for this recovery session.</p>
        </div>
        <div className="status auth-status status-error" role="alert">
          <strong>Verification issue</strong>
          <span>{mfaStatus.message}</span>
        </div>
        <button className="primary-button auth-submit" type="button" onClick={() => void checkMfaRequirement()}>
          Retry Verification Check
        </button>
      </div>
    )
  }

  if (phase === 'mfa') {
    const canVerify = factors.length > 0
    return (
      <div className="auth-panel">
        <div className="auth-heading">
          <p className="auth-kicker">Account security</p>
          <h2>Verify your authenticator</h2>
          <p>This is a separate MFA step. Do not enter the recovery code from the email here. Open the authenticator app previously registered with this account and enter the current 6-digit code shown by that app.</p>
        </div>

        {mfaStatus.type !== 'idle' && (
          <div className={`status auth-status status-${mfaStatus.type}`} role={mfaStatus.type === 'error' ? 'alert' : 'status'}>
            <strong>{mfaStatus.type === 'error' ? 'Verification issue' : mfaStatus.type === 'loading' ? 'Processing' : 'Verified'}</strong>
            <span>{mfaStatus.message}</span>
          </div>
        )}

        {canVerify && (
          <form className="auth-form" onSubmit={handleMfaSubmit} noValidate>
            {factors.length > 1 && (
              <Field label="Authenticator" required>
                <select value={factorId} onChange={(event) => setFactorId(event.target.value)} disabled={mfaStatus.type === 'loading'} required>
                  {factors.map((factor, index) => (
                    <option key={factor.id} value={factor.id}>
                      {factor.friendly_name || `Authenticator ${index + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Authenticator app code" required hint="Use the current 6-digit code from your authenticator app — not the code from the recovery email.">
              <input
                type="text"
                value={mfaCode}
                onChange={updateMfaCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength="10"
                required
                disabled={mfaStatus.type === 'loading'}
              />
            </Field>
            <button className="primary-button auth-submit" type="submit" disabled={mfaStatus.type === 'loading'}>
              {mfaStatus.type === 'loading' ? 'Verifying…' : 'Verify and Continue'}
            </button>
          </form>
        )}

        <details className="admin-mfa-recovery">
          <summary>Lost access to your authenticator?</summary>
          <p>Restore it using your authenticator app’s backup. Resetting your password does not remove MFA. If the authenticator cannot be restored, contact the project owner to verify your identity and reset the lost factor.</p>
        </details>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="auth-panel">
        <div className="auth-heading">
          <p className="auth-kicker">Account security</p>
          <h2>Password updated</h2>
        </div>
        <div className="status auth-status status-success" role="status">
          <strong>Password updated</strong>
          <span>{passwordStatus.message}</span>
        </div>
        <div className="auth-switch">
          <button type="button" className="primary-button" onClick={onContinue}>
            Continue to Customer Liaison
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-panel">
      <div className="auth-heading">
        <p className="auth-kicker">Account security</p>
        <h2>Set a new password</h2>
        <p>Use at least 12 characters. Enter the new password twice to prevent typing mistakes.</p>
      </div>

      {passwordStatus.type !== 'idle' && (
        <div className={`status auth-status status-${passwordStatus.type}`} role={passwordStatus.type === 'error' ? 'alert' : 'status'}>
          <strong>{passwordStatus.type === 'error' ? 'Password update issue' : passwordStatus.type === 'loading' ? 'Processing' : 'Password updated'}</strong>
          <span>{passwordStatus.message}</span>
        </div>
      )}

      <form className="auth-form" onSubmit={handlePasswordSubmit} noValidate>
        <Field label="New password" required hint="Use at least 12 characters.">
          <input
            type="password"
            name="password"
            value={passwordForm.password}
            onChange={updatePasswordField}
            autoComplete="new-password"
            required
            minLength="12"
          />
        </Field>
        <Field label="Confirm new password" required>
          <input
            type="password"
            name="confirmPassword"
            value={passwordForm.confirmPassword}
            onChange={updatePasswordField}
            autoComplete="new-password"
            required
            minLength="12"
          />
        </Field>
        <button className="primary-button auth-submit" type="submit" disabled={passwordStatus.type === 'loading'}>
          {passwordStatus.type === 'loading' ? 'Updating password…' : 'Update Password'}
        </button>
      </form>
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
