import { useEffect, useRef, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { authenticatorQrSource, loadAdminFactors, startAdminEnrollment, verifyAdminFactor } from './lib/adminMfa'

export default function AdminMfa({ adminEmail, onVerified, onBack, onSignOut }) {
  const [factors, setFactors] = useState(null)
  const [factorId, setFactorId] = useState('')
  const [enrollment, setEnrollment] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)
  const operation = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    setError('')
    setFactors(null)
    loadAdminFactors(supabase.auth.mfa).then((result) => {
      if (!active) return
      setFactors(result)
      setFactorId(result.verified[0]?.id ?? '')
    }).catch((failure) => {
      if (active) setError(failure.message || 'Authenticator information could not be loaded.')
    })
    return () => { active = false }
  }, [reload])

  async function run(action) {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError('')
    try { await action() } catch (failure) {
      if (mounted.current) setError(failure.message || 'Verification failed. Please retry.')
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function startSetup() {
    return run(async () => {
      const result = await startAdminEnrollment(supabase.auth.mfa)
      if (!mounted.current) return
      setEnrollment(result)
      setFactorId(result.id)
      setCode('')
    })
  }

  function verify(event) {
    event.preventDefault()
    return run(async () => {
      await verifyAdminFactor(supabase.auth.mfa, factorId, code)
      if (!mounted.current) return
      setEnrollment(null)
      setCode('')
      onVerified()
    })
  }

  function leave(callback) {
    return run(async () => {
      try {
        if (enrollment) {
          // Only remove the unfinished factor created on this screen.
          const { error: failure } = await supabase.auth.mfa.unenroll({ factorId: enrollment.id })
          if (failure) throw failure
          setEnrollment(null)
        }
      } finally {
        // A network error during cleanup must not prevent sign-out or leaving.
        // The next setup attempt can clean up an interrupted enrollment.
        await callback()
      }
    })
  }

  return (
    <main className="page-shell">
      <section className="form-card" aria-labelledby="admin-mfa-title">
        <header className="intro">
          <p className="eyebrow">Top-tier Patent Search</p>
          <h1 id="admin-mfa-title">Administrator verification</h1>
          <p>{adminEmail}</p>
        </header>
        <div className="auth-panel admin-mfa-panel">
          <p>Verify with your authenticator app before opening confidential administrator records.</p>
          {!factors && !error && <p role="status">Checking your authenticator…</p>}
          {!factors && error && <button className="secondary-button" onClick={() => setReload((value) => value + 1)}>Retry</button>}
          {factors && !factors.verified.length && !enrollment && !factors.unsupported && <>
            <p>Set up an authenticator app on your phone. Keep its backup or recovery access somewhere secure.</p>
            <button className="primary-button" onClick={startSetup} disabled={busy}>Set up authenticator</button>
          </>}
          {factors?.unsupported && !factors.verified.length && <p>You have another type of second factor registered. Contact the project owner to recover access or arrange an authenticator app.</p>}
          {enrollment && <div className="admin-mfa-enrollment">
            <p>Scan this QR code in your authenticator app, then enter its current six-digit code below.</p>
            {authenticatorQrSource(enrollment.totp?.qr_code) && <img className="admin-mfa-qr" src={authenticatorQrSource(enrollment.totp.qr_code)} alt="Scan to add the administrator account to your authenticator app" />}
            <details><summary>Enter a setup key manually</summary><p className="admin-mfa-secret">{enrollment.totp?.secret}</p><p>Choose a time-based account. Treat this setup key as confidential.</p></details>
          </div>}
          {(enrollment || Boolean(factors?.verified.length)) && <form className="admin-mfa-form" onSubmit={verify}>
            {factors?.verified.length > 1 && <label>Authenticator
              <select value={factorId} onChange={(event) => setFactorId(event.target.value)} disabled={busy}>
                {factors.verified.map((factor, index) => <option key={factor.id} value={factor.id}>{factor.friendly_name || `Authenticator ${index + 1}`}</option>)}
              </select>
            </label>}
            <label htmlFor="admin-mfa-code">Six-digit authenticator code</label>
            <input id="admin-mfa-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} disabled={busy} />
            <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Verify and open Administrator'}</button>
          </form>}
          {error && <p className="status status-error" role="alert">{error}</p>}
          <details className="admin-mfa-recovery"><summary>Lost access to your authenticator?</summary><p>Restore it using your authenticator app’s backup. If that is unavailable, contact the Supabase project owner to verify your identity and reset the lost factor. Resetting your password alone does not remove MFA. After a factor reset, sign in again and set up a new authenticator.</p></details>
          <div className="admin-mfa-actions">
            <button className="secondary-button" onClick={() => leave(onBack)} disabled={busy}>Back to client view</button>
            <button className="secondary-button" onClick={() => leave(onSignOut)} disabled={busy}>Sign out</button>
          </div>
        </div>
      </section>
    </main>
  )
}
