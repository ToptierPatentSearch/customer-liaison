import { useState } from 'react'
import { supabase } from './lib/supabaseClient'

const PROJECT_TYPES = [
  'Prior Art & Patentability Search',
  'Invalidity / Validity Search',
  'Freedom-to-Operate Search',
  'Patent Landscape / Competitive Analysis',
  'Search Strategy / Classification Support',
  'Not Sure Yet',
  'Other / Customized Assignment',
]

const initialForm = {
  name: '',
  organization: '',
  projectType: '',
  objective: '',
  technologyDescription: '',
  timing: '',
  knownPatentDocuments: '',
  additionalInformation: '',
  acknowledgment: false,
  website: '',
}

function validateDiscussionForm(form) {
  if (!form.name.trim()) return 'Please enter your name.'
  if (!form.projectType) return 'Please select the type of project or choose “Not Sure Yet.”'
  if (!form.objective.trim()) return 'Please describe what you would like to determine or accomplish.'
  if (!form.technologyDescription.trim()) return 'Please describe the technology, product, system, or invention.'
  if (!form.acknowledgment) return 'Please confirm the discussion-scope acknowledgment before submitting.'
  return ''
}

export default function DiscussProject({ session, onContinueToQuote, onContinueToOrder }) {
  const [form, setForm] = useState(initialForm)
  const [status, setStatus] = useState({ type: 'idle', message: '' })
  const [discussionReference, setDiscussionReference] = useState('')
  const [submittedDiscussion, setSubmittedDiscussion] = useState(null)

  function updateField(event) {
    const { name, value, type, checked } = event.target
    setForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setStatus({ type: 'idle', message: '' })
    setDiscussionReference('')
    setSubmittedDiscussion(null)

    if (!session?.user) {
      setStatus({ type: 'error', message: 'Please sign in before submitting a project discussion.' })
      return
    }

    if (form.website) {
      setStatus({ type: 'success', message: 'Your project information has been received.' })
      return
    }

    const formError = validateDiscussionForm(form)
    if (formError) {
      setStatus({ type: 'error', message: formError })
      return
    }

    const payload = {
      name: form.name.trim(),
      organization: form.organization.trim(),
      projectType: form.projectType,
      objective: form.objective.trim(),
      technologyDescription: form.technologyDescription.trim(),
      timing: form.timing.trim(),
      knownPatentDocuments: form.knownPatentDocuments.trim(),
      additionalInformation: form.additionalInformation.trim(),
      acknowledgment: form.acknowledgment,
      website: form.website,
    }

    try {
      setStatus({ type: 'loading', message: 'Submitting your project discussion…' })

      const { data, error } = await supabase.functions.invoke('submit-discussion', {
        body: payload,
      })

      if (error) throw new Error(error.message)
      if (!data?.ok) throw new Error(data?.error || 'The project discussion could not be submitted.')

      const submitted = {
        ...payload,
        discussionId: data.discussionId,
        discussionReference: data.discussionReference,
      }

      setDiscussionReference(data.discussionReference)
      setSubmittedDiscussion(submitted)
      setStatus({
        type: 'success',
        message: 'Your project discussion was submitted for initial review.',
      })
      setForm(initialForm)
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
      {status.type !== 'idle' && (
        <div className={`status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
          <strong>
            {status.type === 'success'
              ? 'Submitted'
              : status.type === 'error'
                ? 'Action required'
                : 'Processing'}
          </strong>
          <span>{status.message}</span>
          {discussionReference && (
            <span className="reference">Discussion reference: {discussionReference}</span>
          )}
          {status.type === 'success' && submittedDiscussion && (
            <div className="discussion-next-step">
              <span>
                Continue to a custom quotation when scope is clear enough for pricing, or proceed directly to a formal Search Request when complete search instructions are already available.
              </span>
              <div className="next-step-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onContinueToQuote(submittedDiscussion)}
                >
                  Continue to Request a Custom Quote
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onContinueToOrder(submittedDiscussion)}
                >
                  Continue to Request a Search
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="honeypot" aria-hidden="true">
          <label htmlFor="discussionWebsite">Website</label>
          <input
            id="discussionWebsite"
            name="website"
            tabIndex="-1"
            autoComplete="off"
            value={form.website}
            onChange={updateField}
          />
        </div>

        <fieldset>
          <legend>Project Overview</legend>
          <p className="section-help">
            Use this shorter form when the exact search scope, service type, or deliverable is not yet settled.
            A project discussion is for scope clarification and does not itself authorize substantive patent-search work.
          </p>

          <div className="grid two-columns">
            <Field label="Name" required>
              <input
                name="name"
                value={form.name}
                onChange={updateField}
                autoComplete="name"
                required
                maxLength="160"
              />
            </Field>

            <Field label="Organization">
              <input
                name="organization"
                value={form.organization}
                onChange={updateField}
                autoComplete="organization"
                maxLength="200"
              />
            </Field>

            <Field label="Email address" required className="full-width">
              <input
                type="email"
                value={session?.user?.email ?? ''}
                readOnly
                autoComplete="email"
              />
            </Field>

            <Field
              label="Project type"
              required
              className="full-width"
              hint="Choose “Not Sure Yet” if you would like help identifying the appropriate patent-search service."
            >
              <select name="projectType" value={form.projectType} onChange={updateField} required>
                <option value="">Select a project type</option>
                {PROJECT_TYPES.map((projectType) => (
                  <option key={projectType} value={projectType}>{projectType}</option>
                ))}
              </select>
            </Field>

            <Field
              label="Project objective"
              required
              className="full-width"
              hint="Explain what decision, filing, risk question, competitive question, or technical issue the project should support."
            >
              <textarea
                name="objective"
                value={form.objective}
                onChange={updateField}
                required
                rows="4"
                maxLength="5000"
              />
            </Field>

            <Field
              label="Technology / invention"
              required
              className="full-width"
              hint="Describe the product, system, process, invention, claim concept, or technical field in practical terms."
            >
              <textarea
                name="technologyDescription"
                value={form.technologyDescription}
                onChange={updateField}
                required
                rows="5"
                maxLength="7000"
              />
            </Field>

            <Field label="Relevant timing" className="full-width">
              <input
                name="timing"
                value={form.timing}
                onChange={updateField}
                placeholder="For example: filing planned in six weeks; product launch in Q1"
                maxLength="1000"
              />
            </Field>

            <Field
              label="Known patent documents"
              className="full-width"
              hint="Optional patent/publication numbers, titles, applicants, or other known references."
            >
              <textarea
                name="knownPatentDocuments"
                value={form.knownPatentDocuments}
                onChange={updateField}
                rows="3"
                maxLength="5000"
              />
            </Field>

            <Field label="Additional context" className="full-width">
              <textarea
                name="additionalInformation"
                value={form.additionalInformation}
                onChange={updateField}
                rows="4"
                maxLength="5000"
              />
            </Field>
          </div>
        </fieldset>

        <div className="acknowledgment-box">
          <label className="check-row">
            <input
              type="checkbox"
              name="acknowledgment"
              checked={form.acknowledgment}
              onChange={updateField}
              required
            />
            <span>
              I understand that this submission requests an initial project discussion and scope review only.
              Scope, deliverables, timing, professional fee, and authorization to begin substantive work will be confirmed separately.
            </span>
          </label>
        </div>

        <div className="submit-area">
          <button className="primary-button" type="submit" disabled={status.type === 'loading'}>
            {status.type === 'loading' ? 'Submitting…' : 'Submit Project Discussion'}
          </button>
          <p>
            If the assignment is sufficiently defined for pricing, use Request a Custom Quote. If complete search instructions are already available, use Request a Search.
          </p>
        </div>
      </form>
    </>
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
