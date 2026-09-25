import { useMemo, useState } from 'react'
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

function makeInitialForm(initialData = {}) {
  return {
    name: initialData.name || '',
    organization: initialData.organization || '',
    country: initialData.country || '',
    searchService: initialData.searchService || '',
    technicalSubject: initialData.technicalSubject || '',
    projectDescription: initialData.projectDescription || '',
    searchObjective: initialData.searchObjective || '',
    jurisdictions: initialData.jurisdictions || '',
    relevantDates: initialData.relevantDates || '',
    knownPatentDocuments: initialData.knownPatentDocuments || '',
    knownCompetitors: initialData.knownCompetitors || '',
    desiredCompletionDate: initialData.desiredCompletionDate || '',
    preferredDeliverable: initialData.preferredDeliverable || '',
    budgetConsiderations: initialData.budgetConsiderations || '',
    additionalInformation: initialData.additionalInformation || '',
    acknowledgment: false,
    website: '',
    discussionId: initialData.discussionId || '',
  }
}

function validateQuoteForm(form) {
  if (!form.name.trim()) return 'Please enter your name.'
  if (!form.country.trim()) return 'Please enter your country.'
  if (!form.searchService) return 'Please select a search service.'
  if (!form.technicalSubject.trim()) return 'Please enter the technical subject.'
  if (!form.searchObjective.trim()) return 'Please describe the purpose of the requested search.'
  if (!form.jurisdictions.trim()) return 'Please enter the relevant jurisdictions.'
  if (!form.preferredDeliverable) return 'Please select a preferred deliverable.'
  if (!form.acknowledgment) return 'Please confirm the quotation acknowledgment before submitting.'
  return ''
}

function validateFiles(files) {
  if (files.length > MAX_FILES) return `Please attach no more than ${MAX_FILES} files.`

  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXTENSIONS.includes(extension)) return `${file.name}: unsupported file type.`
    if (file.size > MAX_FILE_BYTES) return `${file.name}: files must be 10 MB or smaller.`
  }

  return ''
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

export default function QuoteRequest({ session, initialData = {}, onContinueToOrder }) {
  const [form, setForm] = useState(() => makeInitialForm(initialData))
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState({ type: 'idle', message: '' })
  const [quoteReference, setQuoteReference] = useState('')
  const [submittedQuote, setSubmittedQuote] = useState(null)

  const fileSummary = useMemo(() => {
    if (!files.length) return 'No supporting documents selected.'
    return `${files.length} supporting document${files.length === 1 ? '' : 's'} selected.`
  }, [files])

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

  async function uploadSupportingDocuments(quoteId) {
    if (!files.length) return []

    const { data: authorization, error: authorizationError } =
      await supabase.functions.invoke('create-quote-upload-url', {
        body: {
          quoteId,
          files: files.map((file) => ({
            originalName: file.name,
            sizeBytes: file.size,
            contentType: file.type || null,
          })),
        },
      })

    if (authorizationError) {
      throw new Error(`Could not authorize supporting-document upload: ${authorizationError.message}`)
    }
    if (!authorization?.ok || !Array.isArray(authorization.uploads)) {
      throw new Error(authorization?.error || 'Supporting-document upload authorization failed.')
    }
    if (authorization.uploads.length !== files.length) {
      throw new Error('The number of authorized uploads does not match the selected files.')
    }

    const uploaded = []

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const permission = authorization.uploads[index]

      const { error: uploadError } = await supabase.storage
        .from('quote-supporting-documents')
        .uploadToSignedUrl(permission.storagePath, permission.token, file, {
          contentType: file.type || undefined,
        })

      if (uploadError) throw new Error(`Could not upload ${file.name}: ${uploadError.message}`)

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
    setQuoteReference('')
    setSubmittedQuote(null)

    if (!session?.user) {
      setStatus({ type: 'error', message: 'Please sign in before requesting a quotation.' })
      return
    }

    if (form.website) {
      setStatus({ type: 'success', message: 'Your quotation request has been received.' })
      return
    }

    const formError = validateQuoteForm(form)
    if (formError) {
      setStatus({ type: 'error', message: formError })
      return
    }

    const fileError = validateFiles(files)
    if (fileError) {
      setStatus({ type: 'error', message: fileError })
      return
    }

    const desiredCompletionDate = parseUsDate(form.desiredCompletionDate)
    if (desiredCompletionDate === undefined) {
      setStatus({ type: 'error', message: 'Desired completion date must use Month/Day/Year format.' })
      return
    }

    const quoteId = crypto.randomUUID()

    try {
      setStatus({ type: 'loading', message: 'Submitting your quotation request…' })

      const supportingDocuments = await uploadSupportingDocuments(quoteId)

      const payload = {
        quoteId,
        discussionId: form.discussionId || null,
        name: form.name.trim(),
        organization: form.organization.trim(),
        country: form.country.trim(),
        searchService: form.searchService,
        technicalSubject: form.technicalSubject.trim(),
        projectDescription: form.projectDescription.trim(),
        searchObjective: form.searchObjective.trim(),
        jurisdictions: form.jurisdictions.trim(),
        relevantDates: form.relevantDates.trim(),
        knownPatentDocuments: form.knownPatentDocuments.trim(),
        knownCompetitors: form.knownCompetitors.trim(),
        desiredCompletionDate,
        preferredDeliverable: form.preferredDeliverable,
        budgetConsiderations: form.budgetConsiderations.trim(),
        additionalInformation: form.additionalInformation.trim(),
        acknowledgment: form.acknowledgment,
        supportingDocuments,
        website: form.website,
      }

      const { data, error } = await supabase.functions.invoke('submit-quote', { body: payload })

      if (error) throw new Error(error.message)
      if (!data?.ok) throw new Error(data?.error || 'The quotation request could not be submitted.')

      const submitted = {
        ...payload,
        quoteId: data.quoteId,
        quoteReference: data.quoteReference,
      }

      setQuoteReference(data.quoteReference)
      setSubmittedQuote(submitted)
      setStatus({
        type: 'success',
        message: 'Your custom quotation request was submitted for review.',
      })
      setForm(makeInitialForm())
      setFiles([])
      const fileInput = document.getElementById('quoteSupportingDocuments')
      if (fileInput) fileInput.value = ''
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) {
      console.error(error)
      setStatus({
        type: 'error',
        message: `Submission was not completed. ${error instanceof Error ? error.message : 'Please try again.'}`,
      })
    }
  }

  return (
    <>
      {form.discussionId && status.type === 'idle' && (
        <div className="discussion-link-note" role="status">
          <strong>Project discussion carried forward</strong>
          <span>Core project information has been prefilled. Add the commercial and scope details needed to prepare a custom quotation.</span>
        </div>
      )}

      {status.type !== 'idle' && (
        <div className={`status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
          <strong>{status.type === 'success' ? 'Submitted' : status.type === 'error' ? 'Action required' : 'Processing'}</strong>
          <span>{status.message}</span>
          {quoteReference && <span className="reference">Quote request reference: {quoteReference}</span>}
          {status.type === 'success' && submittedQuote && (
            <div className="discussion-next-step">
              <span>If you are ready to provide complete search instructions, continue to Request a Search. Relevant quote information will be carried forward.</span>
              <button className="secondary-button" type="button" onClick={() => onContinueToOrder(submittedQuote)}>
                Continue to Request a Search
              </button>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="honeypot" aria-hidden="true">
          <label htmlFor="quoteWebsite">Website</label>
          <input id="quoteWebsite" name="website" tabIndex="-1" autoComplete="off" value={form.website} onChange={updateField} />
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
              <input type="email" value={session?.user?.email ?? ''} readOnly autoComplete="email" />
            </Field>
            <Field label="Country" required>
              <input name="country" value={form.country} onChange={updateField} autoComplete="country-name" required maxLength="120" />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Quotation Scope</legend>
          <p className="section-help">Provide enough information to estimate scope, timing, deliverables, and professional fee. Final scope will be confirmed before substantive work begins.</p>
          <div className="grid two-columns">
            <Field label="Requested service" required className="full-width">
              <select name="searchService" value={form.searchService} onChange={updateField} required>
                <option value="">Select a service</option>
                {SERVICE_OPTIONS.map((service) => <option key={service} value={service}>{service}</option>)}
              </select>
            </Field>
            <Field label="Technical subject / invention" required className="full-width">
              <textarea name="technicalSubject" value={form.technicalSubject} onChange={updateField} rows="4" maxLength="3000" required />
            </Field>
            <Field label="Project description" className="full-width" hint="Optional practical context, product description, claim concept, or background relevant to scoping.">
              <textarea name="projectDescription" value={form.projectDescription} onChange={updateField} rows="4" maxLength="5000" />
            </Field>
            <Field label="Search objective" required className="full-width">
              <textarea name="searchObjective" value={form.searchObjective} onChange={updateField} rows="4" maxLength="5000" required />
            </Field>
            <Field label="Relevant jurisdictions" required>
              <input name="jurisdictions" value={form.jurisdictions} onChange={updateField} maxLength="1000" required />
            </Field>
            <Field label="Relevant dates / priority considerations">
              <input name="relevantDates" value={form.relevantDates} onChange={updateField} maxLength="1000" />
            </Field>
            <Field label="Known patent documents" className="full-width">
              <textarea name="knownPatentDocuments" value={form.knownPatentDocuments} onChange={updateField} rows="3" maxLength="5000" />
            </Field>
            <Field label="Known competitors / assignees" className="full-width">
              <textarea name="knownCompetitors" value={form.knownCompetitors} onChange={updateField} rows="3" maxLength="3000" />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Deliverable and Timing</legend>
          <div className="grid two-columns">
            <Field label="Preferred deliverable" required>
              <select name="preferredDeliverable" value={form.preferredDeliverable} onChange={updateField} required>
                <option value="">Select a deliverable</option>
                {DELIVERABLE_OPTIONS.map((deliverable) => <option key={deliverable} value={deliverable}>{deliverable}</option>)}
              </select>
            </Field>
            <Field label="Desired completion date" hint="Optional. Month/Day/Year, for example 10/31/2026.">
              <input name="desiredCompletionDate" value={form.desiredCompletionDate} onChange={updateField} placeholder="MM/DD/YYYY" inputMode="numeric" maxLength="10" />
            </Field>
            <Field label="Budget considerations, if any" className="full-width" hint="Optional. This does not determine the professional fee; it helps identify scope constraints or alternatives.">
              <textarea name="budgetConsiderations" value={form.budgetConsiderations} onChange={updateField} rows="3" maxLength="2000" />
            </Field>
            <Field label="Additional information" className="full-width">
              <textarea name="additionalInformation" value={form.additionalInformation} onChange={updateField} rows="4" maxLength="5000" />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Supporting Documents</legend>
          <p className="section-help">Attach optional claims, draft specifications, invention disclosures, product descriptions, drawings, known prior art, or claim charts.</p>
          <div className="file-field">
            <input
              id="quoteSupportingDocuments"
              className="file-input"
              type="file"
              multiple
              onChange={handleFiles}
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg"
            />
            <div className="file-picker-row">
              <label className="file-picker-button" htmlFor="quoteSupportingDocuments">Choose Files</label>
              <span className="file-picker-status" aria-live="polite">{fileSummary}</span>
            </div>
            <span className="hint">Up to 8 files, 10 MB each. Accepted: PDF, Office files, TXT, PNG, JPG.</span>
          </div>
        </fieldset>

        <div className="acknowledgment-box">
          <label className="check-row">
            <input type="checkbox" name="acknowledgment" checked={form.acknowledgment} onChange={updateField} required />
            <span>I understand that this submission requests a quotation only and does not constitute an accepted search engagement or authorization to begin substantive work.</span>
          </label>
        </div>

        <div className="submit-area">
          <button className="primary-button" type="submit" disabled={status.type === 'loading'}>
            {status.type === 'loading' ? 'Submitting…' : 'Request Custom Quote'}
          </button>
          <p>Scope, deliverables, timing, professional fee, and any required advance payment will be confirmed separately.</p>
        </div>
      </form>
    </>
  )
}

function Field({ label, hint, required = false, className = '', children }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}{required && <span className="required"> *</span>}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}
