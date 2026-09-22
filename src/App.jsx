import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'

const SERVICE_OPTIONS = [
  'Prior Art & Patentability Search',
  'Invalidity / Validity Search',
  'Freedom-to-Operate Search',
  'Patent Landscape / Competitive Analysis',
  'Search Strategy / Classification Support',
  'Other / Customized Assignment',
]

const DELIVERABLE_OPTIONS = [
  'Search report',
  'Search report with claim mapping / comments',
  'Patent list / bibliography',
  'Spreadsheet / structured results',
  'Classification / search-query support',
  'Other / to be confirmed',
]

const MAX_FILES = 8
const MAX_FILE_BYTES = 10 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'png', 'jpg', 'jpeg']

const initialForm = {
  name: '',
  organization: '',
  email: '',
  country: '',
  billingOrganization: '',
  searchService: '',
  technicalSubject: '',
  searchObjective: '',
  jurisdictions: '',
  relevantDates: '',
  knownPatentDocuments: '',
  knownCompetitors: '',
  requestedCompletionDate: '',
  preferredDeliverable: '',
  additionalInstructions: '',
  acknowledgment: false,
  website: '',
}

function getAuthRedirectUrl() {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString()
}

function makeOrderReference(orderId) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `TPS-${date}-${orderId.slice(0, 8).toUpperCase()}`
}

function safeFileName(name) {
  return name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(-140)
}

function parseUsDate(value) {
  if (!value.trim()) return null
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) return undefined
  const [, monthText, dayText, yearText] = match
  const month = Number(monthText)
  const day = Number(dayText)
  const year = Number(yearText)
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) return undefined
  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}`
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function validateOrderForm(form) {
  if (!form.name.trim()) return 'Please enter your name.'
  if (!form.country.trim()) return 'Please enter your country.'
  if (!form.searchService) return 'Please select a search service.'
  if (!form.technicalSubject.trim()) return 'Please enter the technical subject.'
  if (!form.searchObjective.trim()) return 'Please enter the search objective.'
  if (!form.jurisdictions.trim()) return 'Please enter the relevant jurisdictions.'
  if (!form.preferredDeliverable) return 'Please select a preferred deliverable.'
  if (!form.acknowledgment) return 'Please confirm the scope-review acknowledgment before submitting.'
  return ''
}

function validateFiles(files) {
  if (files.length > MAX_FILES) {
    return `Please attach no more than ${MAX_FILES} files.`
  }

  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      return `${file.name}: unsupported file type.`
    }
    if (file.size > MAX_FILE_BYTES) {
      return `${file.name}: files must be 10 MB or smaller.`
    }
  }
  return ''
}

export default function App() {
  const [form, setForm] = useState(initialForm)
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState({ type: 'idle', message: '' })
  const [orderReference, setOrderReference] = useState('')
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [authMode, setAuthMode] = useState('signin')
  const [authForm, setAuthForm] = useState({ email: '', password: '' })
  const [authStatus, setAuthStatus] = useState({ type: 'idle', message: '' })

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

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      setAuthReady(true)
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const accountEmail = session?.user?.email
    if (!accountEmail) return

    setForm((current) =>
      current.email === accountEmail
        ? current
        : { ...current, email: accountEmail },
    )
  }, [session])

  const fileSummary = useMemo(() => {
    if (!files.length) return 'No supporting documents selected.'
    return `${files.length} supporting document${files.length === 1 ? '' : 's'} selected.`
  }, [files])

  function updateAuthField(event) {
    const { name, value } = event.target
    setAuthForm((current) => ({ ...current, [name]: value }))
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

  async function handleSignOut() {
    setAuthStatus({ type: 'idle', message: '' })
    const { error } = await supabase.auth.signOut()
    if (error) {
      setStatus({ type: 'error', message: `Could not sign out. ${error.message}` })
      return
    }
    setForm(initialForm)
    setFiles([])
    setOrderReference('')
    setStatus({ type: 'idle', message: '' })
  }

  function updateField(event) {
    const { name, value, type, checked } = event.target
    setForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  function handleFiles(event) {
    const selected = Array.from(event.target.files ?? [])
    const error = validateFiles(selected)
    if (error) {
      setFiles([])
      event.target.value = ''
      setStatus({ type: 'error', message: error })
      return
    }
    setFiles(selected)
    setStatus({ type: 'idle', message: '' })
  }

  async function uploadSupportingDocuments(orderId) {
    if (!files.length) {
      return []
    }

    // 1. Ask the Edge Function for temporary upload authorization.
    const { data: authorization, error: authorizationError } =
      await supabase.functions.invoke('create-upload-url', {
        body: {
          orderId,
          files: files.map((file) => ({
            originalName: file.name,
            sizeBytes: file.size,
            contentType: file.type || null,
          })),
        },
      })

    if (authorizationError) {
      throw new Error(
        `Could not authorize supporting-document upload: ${authorizationError.message}`
      )
    }

    if (!authorization?.ok || !Array.isArray(authorization.uploads)) {
      throw new Error(
        authorization?.error ||
        'Supporting-document upload authorization failed.'
      )
    }

    if (authorization.uploads.length !== files.length) {
      throw new Error(
        'The number of authorized uploads does not match the selected files.'
      )
    }

    const uploaded = []

    // 2. Upload each file using its temporary signed token.
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const permission = authorization.uploads[index]

      const { error: uploadError } = await supabase.storage
        .from('order-supporting-documents')
        .uploadToSignedUrl(
          permission.storagePath,
          permission.token,
          file,
          {
            contentType: file.type || undefined,
          }
        )

      if (uploadError) {
        throw new Error(
          `Could not upload ${file.name}: ${uploadError.message}`
        )
      }

      uploaded.push({
        original_name: file.name,
        storage_path: permission.storagePath,
        content_type: file.type || null,
        size_bytes: file.size,
      })
    }

    return uploaded
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setStatus({ type: 'idle', message: '' })
    setOrderReference('')

    if (!session?.user) {
      setStatus({ type: 'error', message: 'Please sign in before submitting order details.' })
      return
    }

    if (form.website) {
      setStatus({ type: 'success', message: 'Your order details have been received.' })
      return
    }

    const formError = validateOrderForm(form)
    if (formError) {
      setStatus({ type: 'error', message: formError })
      return
    }

    const fileError = validateFiles(files)
    if (fileError) {
      setStatus({ type: 'error', message: fileError })
      return
    }

    const requestedCompletionDate = parseUsDate(form.requestedCompletionDate)
    if (requestedCompletionDate === undefined) {
      setStatus({ type: 'error', message: 'Requested completion date must use Month/Day/Year format.' })
      return
    }

    const orderId = crypto.randomUUID()
    const reference = makeOrderReference(orderId)

    try {
      setStatus({ type: 'loading', message: 'Submitting your order details…' })

      const supportingDocuments = await uploadSupportingDocuments(orderId)

      const { data, error } = await supabase.functions.invoke('submit-order', {
        body: {
          orderId,
          name: form.name.trim(),
          organization: form.organization.trim(),
          email: session.user.email?.toLowerCase() ?? form.email.trim().toLowerCase(),
          country: form.country.trim(),
          billingOrganization: form.billingOrganization.trim(),

          searchService: form.searchService,
          technicalSubject: form.technicalSubject.trim(),
          searchObjective: form.searchObjective.trim(),
          jurisdictions: form.jurisdictions.trim(),
          relevantDates: form.relevantDates.trim(),
          knownPatentDocuments: form.knownPatentDocuments.trim(),
          knownCompetitors: form.knownCompetitors.trim(),

          requestedCompletionDate,
          preferredDeliverable: form.preferredDeliverable,
          additionalInstructions: form.additionalInstructions.trim(),

          acknowledgment: form.acknowledgment,
          supportingDocuments,
          website: form.website,
        },
      })

      if (error) {
        throw new Error(error.message)
      }

      if (!data?.ok) {
        throw new Error(
          data?.error || 'The order could not be submitted.'
        )
      }

      setOrderReference(data.orderReference)

      setStatus({
        type: 'success',
        message:
          'Your order details were submitted for initial scope review.',
      })
      setForm({ ...initialForm, email: session.user.email ?? '' })
      setFiles([])
      const fileInput = document.getElementById('supportingDocuments')
      if (fileInput) fileInput.value = ''
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) {
      console.error(error)
      setStatus({
        type: 'error',
        message: `Submission was not completed. ${error.message}`,
      })
    }
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
            onModeChange={(nextMode) => {
              setAuthMode(nextMode)
              setAuthStatus({ type: 'idle', message: '' })
            }}
          />
        </section>
      </main>
    )
  }

  return (
    <main className="page-shell">
      <section className="form-card" aria-labelledby="order-form-title">
        <header className="intro">
          <p className="eyebrow">Top-tier Patent Search</p>
          <h1 id="order-form-title">Provide Your Order Details</h1>
          <p>Please provide sufficient information to permit an initial scope review.</p>
        </header>

        <div className="account-bar">
          <div>
            <strong>Signed in</strong>
            <span>{session.user.email}</span>
          </div>
          <button className="secondary-button" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>

        {status.type !== 'idle' && (
          <div className={`status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
            <strong>{status.type === 'success' ? 'Submitted' : status.type === 'error' ? 'Action required' : 'Processing'}</strong>
            <span>{status.message}</span>
            {orderReference && <span className="reference">Order reference: {orderReference}</span>}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="honeypot" aria-hidden="true">
            <label htmlFor="website">Website</label>
            <input id="website" name="website" tabIndex="-1" autoComplete="off" value={form.website} onChange={updateField} />
          </div>

          <fieldset>
            <legend>Client Information</legend>
            <div className="grid two-columns">
              <Field label="Name" required>
                <input name="name" value={form.name} onChange={updateField} autoComplete="name" required maxLength="160" />
              </Field>
              <Field label="Organization">
                <input name="organization" value={form.organization} onChange={updateField} autoComplete="organization" maxLength="200" />
              </Field>
              <Field label="Email address" required>
                <input type="email" name="email" value={form.email} readOnly autoComplete="email" required maxLength="254" />
              </Field>
              <Field label="Country" required>
                <input name="country" value={form.country} onChange={updateField} autoComplete="country-name" required maxLength="120" />
              </Field>
              <Field label="Billing organization, if different" className="full-width">
                <input name="billingOrganization" value={form.billingOrganization} onChange={updateField} maxLength="200" />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend>Assignment Information</legend>
            <div className="grid two-columns">
              <Field label="Search service requested" required className="full-width">
                <select name="searchService" value={form.searchService} onChange={updateField} required>
                  <option value="">Select a service</option>
                  {SERVICE_OPTIONS.map((service) => <option key={service} value={service}>{service}</option>)}
                </select>
              </Field>

              <Field label="Technical subject" required className="full-width" hint="Briefly identify the technology, product, system, or invention to be searched.">
                <textarea name="technicalSubject" value={form.technicalSubject} onChange={updateField} required rows="3" maxLength="3000" />
              </Field>

              <Field label="Search objective" required className="full-width" hint="State what the search should determine, support, or investigate.">
                <textarea name="searchObjective" value={form.searchObjective} onChange={updateField} required rows="4" maxLength="5000" />
              </Field>

              <Field label="Relevant jurisdictions" required hint="For example: US, EP, JP, PCT, CN, KR.">
                <input name="jurisdictions" value={form.jurisdictions} onChange={updateField} required maxLength="1000" />
              </Field>

              <Field label="Relevant filing or publication dates" hint="Enter any priority, filing, publication, cutoff, or other dates that matter.">
                <input name="relevantDates" value={form.relevantDates} onChange={updateField} maxLength="1000" />
              </Field>

              <Field label="Known patent documents" className="full-width" hint="Patent/publication numbers, titles, applicants, or links may be included.">
                <textarea name="knownPatentDocuments" value={form.knownPatentDocuments} onChange={updateField} rows="3" maxLength="5000" />
              </Field>

              <Field label="Known competitors or assignees" className="full-width">
                <textarea name="knownCompetitors" value={form.knownCompetitors} onChange={updateField} rows="3" maxLength="3000" />
              </Field>

              <Field label="Requested completion date">
                <input name="requestedCompletionDate" value={form.requestedCompletionDate} onChange={updateField} inputMode="numeric" placeholder="Month/Day/Year" maxLength="10" />
              </Field>

              <Field label="Preferred deliverable" required>
                <select name="preferredDeliverable" value={form.preferredDeliverable} onChange={updateField} required>
                  <option value="">Select a deliverable</option>
                  {DELIVERABLE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>

              <Field label="Additional instructions" className="full-width">
                <textarea name="additionalInstructions" value={form.additionalInstructions} onChange={updateField} rows="4" maxLength="5000" />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend>Supporting Documents</legend>
            <p className="section-help">
              Where appropriate, you may provide patent claims, an invention disclosure, drawings, relevant patent documents,
              technical documents, known prior art, or other materials necessary to understand the assignment.
            </p>
            <div className="field">
              <span className="field-label">Attach supporting documents</span>
              <input
                id="supportingDocuments"
                className="file-input-hidden"
                type="file"
                multiple
                onChange={handleFiles}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg"
              />
              <div className="file-picker-row">
                <label className="file-picker-button" htmlFor="supportingDocuments">
                  Choose Files
                </label>
                <span className="file-picker-status" aria-live="polite">
                  {fileSummary}
                </span>
              </div>
              <span className="hint">Up to 8 files, 10 MB each. Accepted: PDF, Office files, TXT, PNG, JPG.</span>
            </div>
          </fieldset>

          <div className="acknowledgment-box">
            <label className="check-row">
              <input type="checkbox" name="acknowledgment" checked={form.acknowledgment} onChange={updateField} required />
              <span>
                I understand that submitting this form requests a scope review and does not by itself authorize work at an undefined fee.
              </span>
            </label>
          </div>

          <div className="submit-area">
            <button className="primary-button" type="submit" disabled={status.type === 'loading'}>
              {status.type === 'loading' ? 'Submitting…' : 'Submit Order Details'}
            </button>
            <p>Scope, deliverables, timing, professional fee, and any required advance payment will be confirmed separately before substantive search work begins.</p>
          </div>
        </form>
      </section>
    </main>
  )
}

function AuthPanel({ mode, form, status, onChange, onSubmit, onModeChange }) {
  const isSignIn = mode === 'signin'

  return (
    <div className="auth-panel">
      <div className="auth-heading">
        <p className="auth-kicker">Secure client access</p>
        <h2>{isSignIn ? 'Sign in to continue' : 'Create your account'}</h2>
        <p>
          {isSignIn
            ? 'Use the account associated with your order request.'
            : 'Create an account to protect order details and supporting documents.'}
        </p>
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

        <button className="primary-button auth-submit" type="submit" disabled={status.type === 'loading'}>
          {status.type === 'loading'
            ? (isSignIn ? 'Signing in…' : 'Creating account…')
            : (isSignIn ? 'Sign In' : 'Create Account')}
        </button>
      </form>

      <div className="auth-switch">
        <span>{isSignIn ? 'Need an account?' : 'Already have an account?'}</span>
        <button
          type="button"
          className="text-button"
          onClick={() => onModeChange(isSignIn ? 'signup' : 'signin')}
        >
          {isSignIn ? 'Create account' : 'Sign in'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, hint, required = false, className = '', children }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">
        {label}{required && <span className="required"> *</span>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}
