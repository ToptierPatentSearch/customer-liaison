import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, invokeFunction } from './lib/supabaseClient'

const STATUS_LABELS = {
  new: 'Received',
  submitted: 'Submitted',
  reviewing: 'Under Review',
  clarification_required: 'Information Required',
  scope_confirmed: 'Scope Confirmed',
  quote_sent: 'Quote Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  search_in_progress: 'Search in Progress',
  report_delivered: 'Report Delivered',
  completed: 'Completed',
  closed: 'Closed',
  quote_requested: 'Quote Requested',
  converted: 'Continued to Next Stage',
}

const FINAL_STATUSES = new Set(['completed', 'closed', 'converted', 'declined'])

const STATUS_LEGEND = [
  {
    status: 'submitted',
    label: 'Received / Submitted',
    description: 'The request has been received.',
  },
  {
    status: 'reviewing',
    label: 'Under Review',
    description: 'The request is being reviewed.',
  },
  {
    status: 'clarification_required',
    label: 'Information Required',
    description: 'Additional client information is needed.',
  },
  {
    status: 'search_in_progress',
    label: 'Active / Confirmed',
    description: 'The project is confirmed or work is underway.',
  },
  {
    status: 'quote_sent',
    label: 'Quote / Report Ready',
    description: 'A quotation or report has been delivered.',
  },
  {
    status: 'completed',
    label: 'Completed',
    description: 'The requested work has been completed.',
  },
  {
    status: 'closed',
    label: 'Closed / Continued',
    description: 'The workflow has ended or moved to the next stage.',
  },
]

const DETAIL_FIELDS = {
  discussion: [
    ['clientName', 'Name'],
    ['organization', 'Organization'],
    ['email', 'Email'],
    ['projectType', 'Project type'],
    ['objective', 'Objective'],
    ['technologyDescription', 'Technology / invention'],
    ['timing', 'Relevant timing'],
    ['knownPatentDocuments', 'Known patent documents'],
    ['additionalInformation', 'Additional information'],
  ],
  quote: [
    ['clientName', 'Name'],
    ['organization', 'Organization'],
    ['email', 'Email'],
    ['country', 'Country'],
    ['searchService', 'Requested service'],
    ['technicalSubject', 'Technical subject'],
    ['projectDescription', 'Project description'],
    ['searchObjective', 'Search objective'],
    ['relevantJurisdictions', 'Relevant jurisdictions'],
    ['relevantDates', 'Relevant dates'],
    ['knownPatentDocuments', 'Known patent documents'],
    ['knownCompetitorsOrAssignees', 'Known competitors / assignees'],
    ['desiredCompletionDate', 'Desired completion date'],
    ['preferredDeliverable', 'Preferred deliverable'],
    ['budgetConsiderations', 'Budget considerations'],
    ['additionalInformation', 'Additional information'],
  ],
  search: [
    ['clientName', 'Name'],
    ['organization', 'Organization'],
    ['email', 'Email'],
    ['country', 'Country'],
    ['billingOrganization', 'Billing organization'],
    ['searchService', 'Search service'],
    ['technicalSubject', 'Technical subject'],
    ['searchObjective', 'Search objective'],
    ['relevantJurisdictions', 'Relevant jurisdictions'],
    ['relevantDates', 'Relevant dates'],
    ['knownPatentDocuments', 'Known patent documents'],
    ['knownCompetitorsOrAssignees', 'Known competitors / assignees'],
    ['requestedCompletionDate', 'Requested completion date'],
    ['preferredDeliverable', 'Preferred deliverable'],
    ['additionalInstructions', 'Additional instructions'],
  ],
}

const AMENDMENT_OPTIONS = [
  ['scope', 'Search scope'],
  ['dates', 'Relevant dates'],
  ['jurisdictions', 'Jurisdictions'],
  ['claims', 'Claims / technical information'],
  ['deliverable', 'Deliverable'],
  ['completion_date', 'Completion date'],
  ['other', 'Other'],
]

const MAX_FILES = 8
const MAX_FILE_BYTES = 10 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'png', 'jpg', 'jpeg'])

function statusLabel(status) {
  if (!status) return 'Status Pending'
  return STATUS_LABELS[status] || status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value, withTime = false) {
  if (!value) return '—'
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'

  return new Intl.DateTimeFormat('en-US', withTime
    ? {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }
    : {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date)
}

function fileSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'Unknown size'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function requestKindClass(type) {
  if (type === 'discussion') return 'request-kind-discussion'
  if (type === 'quote') return 'request-kind-quote'
  return 'request-kind-search'
}

function databaseRequestType(type) {
  return type === 'search' ? 'order' : type
}

function requestNeedsAction(request) {
  return Boolean(
    request.hasUnreadMessage ||
    request.status === 'clarification_required' ||
    (request.type === 'quote' && request.status === 'quote_sent'),
  )
}

function nextActionFor(request) {
  if (request.status === 'clarification_required') {
    return {
      tone: 'required',
      title: 'Information required',
      description: 'Additional information is needed before the request can continue. Review the conversation, reply, or upload supporting documents.',
      target: 'conversation',
    }
  }

  if (request.type === 'quote' && request.status === 'quote_sent') {
    return {
      tone: 'required',
      title: 'Quotation ready for decision',
      description: 'Review the quotation and related messages, then accept or decline it from this request.',
      target: 'conversation',
    }
  }

  if (request.hasUnreadMessage) {
    return {
      tone: 'review',
      title: 'New message to review',
      description: `${request.unreadMessageCount} unread message${request.unreadMessageCount === 1 ? '' : 's'} from Top-tier Patent Search.`,
      target: 'conversation',
    }
  }

  if (request.type === 'quote' && request.status === 'accepted') {
    return {
      tone: 'review',
      title: 'Quotation accepted',
      description: 'When ready, continue to Request a Search to provide or confirm the formal search instructions.',
      target: 'search',
    }
  }

  if (request.status === 'report_delivered') {
    return {
      tone: 'review',
      title: 'Report delivered',
      description: 'Review the available documents and use the conversation if any follow-up clarification is needed.',
      target: 'documents',
    }
  }

  if (FINAL_STATUSES.has(request.status)) {
    return {
      tone: 'complete',
      title: request.status === 'declined' ? 'Quotation declined' : 'No action required',
      description: 'This workflow is closed. The record and its conversation remain available for reference.',
      target: null,
    }
  }

  if (request.status === 'search_in_progress') {
    return {
      tone: 'none',
      title: 'No action required',
      description: 'The search is in progress. New messages or status changes will be highlighted here.',
      target: null,
    }
  }

  return {
    tone: 'none',
    title: 'No action required',
    description: 'The request is being processed. New messages or status changes will be highlighted here.',
    target: null,
  }
}

function formatDetailValue(key, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Confirmed' : 'Not confirmed'
  if (key.toLowerCase().includes('date') && typeof value === 'string') return formatDate(value)
  return String(value)
}

function scrollToSection(requestId, section) {
  document.getElementById(`${section}-${requestId}`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
}

function validateFiles(files) {
  if (files.length < 1) return 'Please choose at least one file.'
  if (files.length > MAX_FILES) return `Please attach no more than ${MAX_FILES} files at one time.`

  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXTENSIONS.has(extension)) return `${file.name}: unsupported file type.`
    if (file.size > MAX_FILE_BYTES) return `${file.name}: files must be 10 MB or smaller.`
  }
  return ''
}

export default function MyRequests({ onRequestQuote, onRequestOrder }) {
  const [requests, setRequests] = useState([])
  const [status, setStatus] = useState({ type: 'loading', message: 'Loading your requests…' })
  const [filter, setFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [replyText, setReplyText] = useState({})
  const [sendingReply, setSendingReply] = useState('')
  const [replyStatus, setReplyStatus] = useState({})
  const [uploadFiles, setUploadFiles] = useState({})
  const [uploadStatus, setUploadStatus] = useState({})
  const [openingDocument, setOpeningDocument] = useState('')
  const [amendmentDraft, setAmendmentDraft] = useState({})
  const [amendmentStatus, setAmendmentStatus] = useState({})
  const [quoteDecisionStatus, setQuoteDecisionStatus] = useState({})
  const markingStatusSeen = useRef(new Set())
  const markingMessagesSeen = useRef(new Set())

  async function loadRequests() {
    setStatus({ type: 'loading', message: 'Loading your requests…' })
    try {
      const { data, error } = await invokeFunction('my-requests', { body: {} })
      if (error) throw new Error(error.message)
      if (!data?.ok) throw new Error(data?.error || 'Your requests could not be loaded.')
      setRequests(Array.isArray(data.requests) ? data.requests : [])
      setStatus({ type: 'idle', message: '' })
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Your requests could not be loaded.',
      })
    }
  }

  useEffect(() => {
    loadRequests()
  }, [])

  async function markStatusSeen(request) {
    if (!request?.hasStatusUpdate || markingStatusSeen.current.has(request.id)) return

    markingStatusSeen.current.add(request.id)

    try {
      const { data, error } = await invokeFunction('my-requests', {
        body: {
          action: 'mark-status-seen',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
          statusVersion: request.statusVersion,
        },
      })

      if (error || !data?.ok) {
        throw new Error(error?.message || data?.error || 'Status update could not be marked as viewed.')
      }

      setRequests((current) =>
        current.map((item) =>
          item.id === request.id
            ? {
                ...item,
                hasStatusUpdate: item.statusVersion > Math.max(item.seenStatusVersion, request.statusVersion),
                seenStatusVersion: Math.max(item.seenStatusVersion, request.statusVersion),
              }
            : item,
        ),
      )
    } catch (error) {
      console.error('Could not mark status update as viewed:', error)
    } finally {
      markingStatusSeen.current.delete(request.id)
    }
  }

  async function markMessagesSeen(request) {
    const messageIds = Array.isArray(request?.unreadMessageIds) ? request.unreadMessageIds : []
    if (!messageIds.length || markingMessagesSeen.current.has(request.id)) return

    markingMessagesSeen.current.add(request.id)

    try {
      const { data, error } = await invokeFunction('my-requests', {
        body: {
          action: 'mark-messages-seen',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
          messageIds,
        },
      })

      if (error || !data?.ok) {
        throw new Error(error?.message || data?.error || 'Messages could not be marked as viewed.')
      }

      const acknowledged = new Set(data.messageIds || messageIds)
      setRequests((current) =>
        current.map((item) => {
          if (item.id !== request.id) return item
          const remainingIds = (item.unreadMessageIds || []).filter((id) => !acknowledged.has(id))
          return {
            ...item,
            unreadMessageIds: remainingIds,
            unreadMessageCount: remainingIds.length,
            hasUnreadMessage: remainingIds.length > 0,
            replies: (item.replies || []).map((reply) =>
              acknowledged.has(reply.id)
                ? { ...reply, isUnread: false, readAt: data.readAt || reply.readAt }
                : reply,
            ),
          }
        }),
      )
    } catch (error) {
      console.error('Could not mark messages as viewed:', error)
    } finally {
      markingMessagesSeen.current.delete(request.id)
    }
  }

  async function sendReply(request) {
    const message = (replyText[request.id] || '').trim()
    if (!message) {
      setReplyStatus((current) => ({
        ...current,
        [request.id]: { type: 'error', message: 'Please enter a message.' },
      }))
      return
    }

    setSendingReply(request.id)
    setReplyStatus((current) => ({
      ...current,
      [request.id]: { type: 'loading', message: 'Sending…' },
    }))

    try {
      const { data, error } = await invokeFunction('my-requests', {
        body: {
          action: 'send-reply',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
          message,
        },
      })

      if (error) throw new Error(error.message)
      if (!data?.ok || !data.reply) {
        throw new Error(data?.error || 'Your message could not be sent.')
      }

      setRequests((current) =>
        current.map((item) =>
          item.id === request.id
            ? {
                ...item,
                replies: [...(item.replies || []), data.reply],
                updatedAt: data.reply.createdAt || item.updatedAt,
              }
            : item,
        ),
      )
      setReplyText((current) => ({ ...current, [request.id]: '' }))
      setReplyStatus((current) => ({
        ...current,
        [request.id]: { type: 'success', message: 'Message sent.' },
      }))
    } catch (error) {
      setReplyStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'error',
          message: error instanceof Error ? error.message : 'Your message could not be sent.',
        },
      }))
    } finally {
      setSendingReply('')
    }
  }

  function chooseFiles(requestId, event) {
    const files = Array.from(event.target.files || [])
    const validationError = validateFiles(files)

    setUploadFiles((current) => ({ ...current, [requestId]: validationError ? [] : files }))
    setUploadStatus((current) => ({
      ...current,
      [requestId]: validationError
        ? { type: 'error', message: validationError }
        : { type: 'idle', message: files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected.` : '' },
    }))
  }

  async function uploadDocuments(request) {
    const files = uploadFiles[request.id] || []
    const validationError = validateFiles(files)
    if (validationError) {
      setUploadStatus((current) => ({
        ...current,
        [request.id]: { type: 'error', message: validationError },
      }))
      return
    }

    setUploadStatus((current) => ({
      ...current,
      [request.id]: { type: 'loading', message: 'Preparing secure upload…' },
    }))

    try {
      const { data, error } = await invokeFunction('my-requests', {
        body: {
          action: 'create-document-upload',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
          files: files.map((file) => ({
            name: file.name,
            size: file.size,
            type: file.type,
          })),
        },
      })

      if (error) throw new Error(error.message)
      if (!data?.ok || !data.bucket || !Array.isArray(data.uploads) || data.uploads.length !== files.length) {
        throw new Error(data?.error || 'Secure upload links could not be created.')
      }

      setUploadStatus((current) => ({
        ...current,
        [request.id]: { type: 'loading', message: 'Uploading documents…' },
      }))

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const upload = data.uploads[index]
        const options = file.type ? { contentType: file.type } : undefined
        const { error: uploadError } = await supabase.storage
          .from(data.bucket)
          .uploadToSignedUrl(upload.storagePath, upload.token, file, options)

        if (uploadError) throw new Error(`${file.name}: ${uploadError.message}`)
      }

      const { data: registration, error: registrationError } = await invokeFunction('my-requests', {
        body: {
          action: 'register-documents',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
          documents: data.uploads,
        },
      })

      if (registrationError) throw new Error(registrationError.message)
      if (!registration?.ok || !Array.isArray(registration.documents)) {
        throw new Error(registration?.error || 'Uploaded documents could not be registered.')
      }

      setRequests((current) =>
        current.map((item) => {
          if (item.id !== request.id) return item
          const newIds = new Set(registration.documents.map((document) => document.id))
          return {
            ...item,
            documents: [
              ...(item.documents || []).filter((document) => !newIds.has(document.id)),
              ...registration.documents,
            ],
            replies: registration.reply
              ? [...(item.replies || []), registration.reply]
              : item.replies,
            updatedAt: registration.reply?.createdAt || item.updatedAt,
          }
        }),
      )

      setUploadFiles((current) => ({ ...current, [request.id]: [] }))
      setUploadStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'success',
          message: `${registration.documents.length} document${registration.documents.length === 1 ? '' : 's'} added securely.`,
        },
      }))
    } catch (error) {
      setUploadStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'error',
          message: error instanceof Error ? error.message : 'Documents could not be uploaded.',
        },
      }))
    }
  }

  async function openDocument(request, document) {
    const key = document.source === 'original' ? document.storagePath : document.id
    if (!key) return

    setOpeningDocument(key)

    try {
      const body = document.source === 'original'
        ? {
            action: 'original-document-url',
            requestType: databaseRequestType(request.type),
            requestId: request.id,
            storagePath: document.storagePath,
          }
        : {
            action: 'document-url',
            requestType: databaseRequestType(request.type),
            requestId: request.id,
            documentId: document.id,
          }

      const { data, error } = await invokeFunction('my-requests', { body })
      if (error) throw new Error(error.message)
      if (!data?.ok || !data.signedUrl) {
        throw new Error(data?.error || 'The secure document link could not be created.')
      }

      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setUploadStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'error',
          message: error instanceof Error ? error.message : 'The document could not be opened.',
        },
      }))
    } finally {
      setOpeningDocument('')
    }
  }

  async function submitAmendment(request) {
    const draft = amendmentDraft[request.id] || { category: 'scope', description: '' }
    const description = (draft.description || '').trim()

    if (!description) {
      setAmendmentStatus((current) => ({
        ...current,
        [request.id]: { type: 'error', message: 'Please describe the requested change.' },
      }))
      return
    }

    setAmendmentStatus((current) => ({
      ...current,
      [request.id]: { type: 'loading', message: 'Submitting amendment request…' },
    }))

    try {
      const { data, error } = await invokeFunction('my-requests', {
        body: {
          action: 'submit-amendment',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
          category: draft.category || 'scope',
          description,
        },
      })

      if (error) throw new Error(error.message)
      if (!data?.ok || !data.reply) {
        throw new Error(data?.error || 'The amendment request could not be submitted.')
      }

      setRequests((current) =>
        current.map((item) =>
          item.id === request.id
            ? {
                ...item,
                replies: [...(item.replies || []), data.reply],
                updatedAt: data.reply.createdAt || item.updatedAt,
              }
            : item,
        ),
      )
      setAmendmentDraft((current) => ({
        ...current,
        [request.id]: { category: draft.category || 'scope', description: '' },
      }))
      setAmendmentStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'success',
          message: 'Amendment request submitted and added to the request conversation.',
        },
      }))
    } catch (error) {
      setAmendmentStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'error',
          message: error instanceof Error ? error.message : 'The amendment request could not be submitted.',
        },
      }))
    }
  }

  async function recordQuoteDecision(request, decision) {
    setQuoteDecisionStatus((current) => ({
      ...current,
      [request.id]: { type: 'loading', message: decision === 'accept' ? 'Accepting quotation…' : 'Declining quotation…' },
    }))

    try {
      const { data, error } = await invokeFunction('my-requests', {
        body: {
          action: 'quote-decision',
          requestId: request.id,
          decision,
        },
      })

      if (error) throw new Error(error.message)
      if (!data?.ok) throw new Error(data?.error || 'The quotation decision could not be recorded.')

      setQuoteDecisionStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'success',
          message: decision === 'accept'
            ? 'Quotation accepted. You may now continue to Request a Search.'
            : 'Quotation declined. The decision has been recorded.',
        },
      }))

      await loadRequests()
    } catch (error) {
      setQuoteDecisionStatus((current) => ({
        ...current,
        [request.id]: {
          type: 'error',
          message: error instanceof Error ? error.message : 'The quotation decision could not be recorded.',
        },
      }))
    }
  }

  const counts = useMemo(() => {
    const completed = requests.filter((request) => FINAL_STATUSES.has(request.status)).length
    const action = requests.filter(requestNeedsAction).length
    return {
      all: requests.length,
      action,
      active: requests.length - completed,
      completed,
    }
  }, [requests])

  const filteredRequests = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return requests.filter((request) => {
      if (filter === 'action' && !requestNeedsAction(request)) return false
      if (filter === 'active' && FINAL_STATUSES.has(request.status)) return false
      if (filter === 'completed' && !FINAL_STATUSES.has(request.status)) return false
      if (typeFilter !== 'all' && request.type !== typeFilter) return false

      if (!needle) return true

      const details = request.details && typeof request.details === 'object'
        ? Object.values(request.details)
        : []

      return [
        request.reference,
        request.subject,
        request.service,
        request.summary,
        statusLabel(request.status),
        ...details,
      ]
        .filter((value) => value !== null && value !== undefined)
        .some((value) => String(value).toLowerCase().includes(needle))
    })
  }, [filter, query, requests, typeFilter])

  return (
    <div className="my-requests">
      <div className="my-requests-toolbar">
        <div className="request-filter-tabs" role="tablist" aria-label="Request filters">
          {[
            ['all', 'All'],
            ['action', 'Action Required'],
            ['active', 'Active'],
            ['completed', 'Completed'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'request-filter active' : 'request-filter'}
              type="button"
              onClick={() => setFilter(value)}
              aria-selected={filter === value}
            >
              {label} <span>{counts[value]}</span>
            </button>
          ))}
        </div>

        <button
          className="secondary-button request-refresh-button"
          type="button"
          onClick={loadRequests}
          disabled={status.type === 'loading'}
        >
          {status.type === 'loading' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="my-requests-searchbar">
        <label>
          <span>Search requests</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Reference, subject, service, keyword…"
          />
        </label>
        <label>
          <span>Request type</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="all">All request types</option>
            <option value="discussion">Discuss a Project</option>
            <option value="quote">Request a Custom Quote</option>
            <option value="search">Request a Search</option>
          </select>
        </label>
      </div>

      <section className="status-color-legend" aria-labelledby="status-color-legend-title">
        <div className="status-color-legend-heading">
          <div>
            <h2 id="status-color-legend-title">Status Color Legend</h2>
            <p>Colors identify the current stage. NEW STATUS and NEW MESSAGE are separate indicators so the reason for an update is clear.</p>
          </div>
        </div>
        <div className="status-color-legend-grid">
          {STATUS_LEGEND.map((item) => (
            <div className="status-color-legend-item" key={item.status}>
              <span className={`status-legend-chip status-value-${item.status}`}>
                {item.label}
              </span>
              <span>{item.description}</span>
            </div>
          ))}
        </div>
      </section>

      {status.type === 'loading' && (
        <div className="status status-loading my-requests-status" role="status">
          <strong>Loading</strong>
          <span>{status.message}</span>
        </div>
      )}

      {status.type === 'error' && (
        <div className="status status-error my-requests-status" role="alert">
          <strong>Could not load requests</strong>
          <span>{status.message}</span>
          <button className="secondary-button" type="button" onClick={loadRequests}>Try again</button>
        </div>
      )}

      {status.type === 'idle' && filteredRequests.length === 0 && (
        <div className="my-requests-empty">
          <strong>{requests.length === 0 ? 'No requests have been submitted yet.' : 'No requests match the current filters.'}</strong>
          <span>Requests submitted through Discuss a Project, Request a Custom Quote, or Request a Search will appear here.</span>
        </div>
      )}

      {status.type === 'idle' && filteredRequests.length > 0 && (
        <div className="my-requests-list">
          {filteredRequests.map((request) => {
            const replies = Array.isArray(request.replies) ? request.replies : []
            const history = Array.isArray(request.statusHistory) ? request.statusHistory : []
            const originalDocuments = Array.isArray(request.originalDocuments) ? request.originalDocuments : []
            const workspaceDocuments = Array.isArray(request.documents) ? request.documents : []
            const currentReplyStatus = replyStatus[request.id]
            const currentUploadStatus = uploadStatus[request.id]
            const currentAmendmentStatus = amendmentStatus[request.id]
            const currentDecisionStatus = quoteDecisionStatus[request.id]
            const selectedFiles = uploadFiles[request.id] || []
            const amendment = amendmentDraft[request.id] || { category: 'scope', description: '' }
            const nextAction = nextActionFor(request)
            const detailFields = DETAIL_FIELDS[request.type] || []

            return (
              <article className="customer-request-entry" key={request.id} aria-label={`${request.typeLabel}: ${request.reference || request.subject}`}>
              <details
                className={`customer-request-card${request.hasStatusUpdate ? ' has-status-update' : ''}${request.hasUnreadMessage ? ' has-message-update' : ''}`}
                key={request.id}
                onToggle={(event) => {
                  if (event.currentTarget.open) {
                    markStatusSeen(request)
                    markMessagesSeen(request)
                  }
                }}
              >
                <summary>
                  <div className="customer-request-main">
                    <div className="customer-request-label-row">
                      <span className={`request-kind ${requestKindClass(request.type)}`}>{request.typeLabel}</span>
                      {request.hasStatusUpdate && (
                        <span className="request-new-update" aria-label="New status update">NEW STATUS</span>
                      )}
                      {request.hasUnreadMessage && (
                        <span className="request-new-message" aria-label="New message">
                          NEW MESSAGE{request.unreadMessageCount > 1 ? ` · ${request.unreadMessageCount}` : ''}
                        </span>
                      )}
                    </div>
                    <strong>{request.subject || request.typeLabel}</strong>
                    <span className="customer-request-reference">{request.reference || 'Reference pending'}</span>
                  </div>

                  <div className="customer-request-meta">
                    <span className={`customer-status-pill status-value-${request.status || 'pending'}`}>
                      {statusLabel(request.status)}
                    </span>
                    <span>Submitted: {formatDate(request.createdAt)}</span>
                    <span>Status changed: {formatDate(request.statusUpdatedAt, true)}</span>
                    <span>Last activity: {formatDate(request.updatedAt || request.createdAt, true)}</span>
                  </div>
                </summary>

                <div className="customer-request-details">
                  <section className={`request-next-action next-action-${nextAction.tone}`} aria-label="Next action">
                    <div>
                      <span className="next-action-kicker">Next Action</span>
                      <h3>{nextAction.title}</h3>
                      <p>{nextAction.description}</p>
                    </div>
                    <div className="request-next-action-buttons">
                      {nextAction.target === 'conversation' && request.status !== 'quote_sent' && (
                        <button className="secondary-button" type="button" onClick={() => scrollToSection(request.id, 'conversation')}>
                          Go to Conversation
                        </button>
                      )}
                      {nextAction.target === 'documents' && (
                        <button className="secondary-button" type="button" onClick={() => scrollToSection(request.id, 'documents')}>
                          View Documents
                        </button>
                      )}
                      {nextAction.target === 'search' && (
                        <button className="primary-button" type="button" onClick={() => onRequestOrder(request)}>
                          Request a Search
                        </button>
                      )}
                      {request.type === 'quote' && request.status === 'quote_sent' && (
                        <>
                          <button
                            className="primary-button"
                            type="button"
                            disabled={currentDecisionStatus?.type === 'loading'}
                            onClick={() => recordQuoteDecision(request, 'accept')}
                          >
                            Accept Quote
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={currentDecisionStatus?.type === 'loading'}
                            onClick={() => recordQuoteDecision(request, 'decline')}
                          >
                            Decline
                          </button>
                        </>
                      )}
                    </div>
                    {currentDecisionStatus && (
                      <p className={`conversation-feedback ${currentDecisionStatus.type}`}>{currentDecisionStatus.message}</p>
                    )}
                  </section>

                  <dl>
                    <div><dt>Request type</dt><dd>{request.typeLabel}</dd></div>
                    <div><dt>Reference</dt><dd>{request.reference || '—'}</dd></div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        <span className={`status-history-status status-value-${request.status || 'pending'}`}>
                          {statusLabel(request.status)}
                        </span>
                      </dd>
                    </div>
                    <div><dt>Status changed</dt><dd>{formatDate(request.statusUpdatedAt, true)}</dd></div>
                    <div><dt>Service</dt><dd>{request.service || '—'}</dd></div>
                    <div><dt>Submitted</dt><dd>{formatDate(request.createdAt)}</dd></div>
                    <div><dt>Last activity</dt><dd>{formatDate(request.updatedAt || request.createdAt, true)}</dd></div>
                    {request.requestedCompletionDate && (
                      <div><dt>Requested completion</dt><dd>{formatDate(request.requestedCompletionDate)}</dd></div>
                    )}
                  </dl>

                  {request.summary && (
                    <div className="customer-request-summary">
                      <strong>Request summary</strong>
                      <p>{request.summary}</p>
                    </div>
                  )}

                  <details className="original-request-panel">
                    <summary>View Original Submission</summary>
                    <div className="original-request-grid">
                      {detailFields.map(([key, label]) => (
                        <div className="original-request-field" key={key}>
                          <span>{label}</span>
                          <p>{formatDetailValue(key, request.details?.[key])}</p>
                        </div>
                      ))}
                    </div>
                    <p className="read-only-note">
                      This is a read-only record of the submitted information. Use Request an Amendment below rather than changing the historical submission.
                    </p>
                  </details>

                  <section className="request-documents" id={`documents-${request.id}`} aria-label="Request documents">
                    <div className="documents-heading">
                      <div>
                        <h3>Documents</h3>
                        <p>Original files and later supporting materials remain associated with this request.</p>
                      </div>
                      <span>{originalDocuments.length + workspaceDocuments.length} file{originalDocuments.length + workspaceDocuments.length === 1 ? '' : 's'}</span>
                    </div>

                    {originalDocuments.length === 0 && workspaceDocuments.length === 0 ? (
                      <p className="conversation-empty">No documents are currently associated with this request.</p>
                    ) : (
                      <div className="request-document-list">
                        {originalDocuments.map((document, index) => (
                          <div className="request-document-row" key={document.storagePath || `original-${index}`}>
                            <div>
                              <strong>{document.originalName}</strong>
                              <span>Submitted with request · {fileSize(document.sizeBytes)}</span>
                            </div>
                            <button
                              className="secondary-button"
                              type="button"
                              disabled={openingDocument === document.storagePath}
                              onClick={() => openDocument(request, document)}
                            >
                              {openingDocument === document.storagePath ? 'Opening…' : 'Open'}
                            </button>
                          </div>
                        ))}
                        {workspaceDocuments.map((document) => (
                          <div className="request-document-row" key={document.id}>
                            <div>
                              <strong>{document.originalName}</strong>
                              <span>
                                {document.uploaderRole === 'admin' ? 'Top-tier Patent Search' : 'Added after submission'}
                                {' · '}{fileSize(document.sizeBytes)}
                                {document.createdAt ? ` · ${formatDate(document.createdAt)}` : ''}
                              </span>
                            </div>
                            <button
                              className="secondary-button"
                              type="button"
                              disabled={openingDocument === document.id}
                              onClick={() => openDocument(request, document)}
                            >
                              {openingDocument === document.id ? 'Opening…' : 'Open'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {!FINAL_STATUSES.has(request.status) && (
                      <div className="request-document-upload">
                        <div>
                          <strong>Add Supporting Documents</strong>
                          <span>PDF, Office documents, TXT, PNG, or JPG. Up to 8 files per upload; 10 MB each.</span>
                        </div>
                        <input
                          id={`workspace-files-${request.id}`}
                          className="file-input-hidden"
                          type="file"
                          multiple
                          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.png,.jpg,.jpeg"
                          onChange={(event) => chooseFiles(request.id, event)}
                        />
                        <div className="request-upload-actions">
                          <label className="file-picker-button" htmlFor={`workspace-files-${request.id}`}>Choose Files</label>
                          <span>{selectedFiles.length ? `${selectedFiles.length} selected` : 'No files selected'}</span>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={!selectedFiles.length || currentUploadStatus?.type === 'loading'}
                            onClick={() => uploadDocuments(request)}
                          >
                            {currentUploadStatus?.type === 'loading' ? 'Uploading…' : 'Upload Documents'}
                          </button>
                        </div>
                        {currentUploadStatus?.message && (
                          <p className={`conversation-feedback ${currentUploadStatus.type}`}>{currentUploadStatus.message}</p>
                        )}
                      </div>
                    )}
                  </section>

                  <section className="request-status-history" aria-label="Status history">
                    <div className="status-history-heading">
                      <div>
                        <h3>Status history</h3>
                        <p>Track the progression of this request over time.</p>
                      </div>
                      <span>{history.length} status entr{history.length === 1 ? 'y' : 'ies'}</span>
                    </div>

                    {history.length === 0 ? (
                      <p className="status-history-empty">No status history is available yet.</p>
                    ) : (
                      <ol className="status-history-list">
                        {[...history].reverse().map((entry) => (
                          <li key={entry.id || `${entry.statusVersion}-${entry.changedAt || ''}`}>
                            <span className={`status-history-dot status-dot-${entry.toStatus || 'pending'}`} aria-hidden="true" />
                            <div>
                              <div className="status-history-transition" aria-label={
                                entry.fromStatus
                                  ? `${statusLabel(entry.fromStatus)} changed to ${statusLabel(entry.toStatus)}`
                                  : statusLabel(entry.toStatus)
                              }>
                                {entry.fromStatus && (
                                  <>
                                    <span className={`status-history-status status-value-${entry.fromStatus}`}>
                                      {statusLabel(entry.fromStatus)}
                                    </span>
                                    <span className="status-history-arrow" aria-hidden="true">→</span>
                                  </>
                                )}
                                <span className={`status-history-status status-value-${entry.toStatus || 'pending'}`}>
                                  {statusLabel(entry.toStatus)}
                                </span>
                              </div>
                              <span>{formatDate(entry.changedAt, true)}</span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  <section className="request-conversation" id={`conversation-${request.id}`} aria-label="Request conversation">
                    <div className="conversation-heading">
                      <div>
                        <h3>Conversation</h3>
                        <p>Messages about this request stay with the request record.</p>
                      </div>
                      <span>{replies.length} message{replies.length === 1 ? '' : 's'}</span>
                    </div>

                    <div className="conversation-thread">
                      {replies.length === 0 ? (
                        <p className="conversation-empty">No replies have been exchanged yet.</p>
                      ) : (
                        replies.map((reply) => (
                          <article
                            key={reply.id}
                            className={`conversation-message ${reply.senderRole === 'admin' ? 'from-admin' : 'from-client'}${reply.isUnread ? ' unread-message' : ''}`}
                          >
                            <div className="conversation-message-meta">
                              <strong>{reply.senderRole === 'admin' ? 'Top-tier Patent Search' : 'You'}</strong>
                              <span>{formatDate(reply.createdAt, true)}</span>
                            </div>
                            <p>{reply.message}</p>
                          </article>
                        ))
                      )}
                    </div>

                    <div className="conversation-composer">
                      <label>
                        <span>Send a message about this request</span>
                        <textarea
                          rows="4"
                          value={replyText[request.id] || ''}
                          onChange={(event) =>
                            setReplyText((current) => ({ ...current, [request.id]: event.target.value }))
                          }
                          maxLength={10000}
                          placeholder="Add a clarification, answer a question, or provide additional information."
                        />
                      </label>
                      <div className="conversation-composer-actions">
                        <span>{(replyText[request.id] || '').length}/10,000</span>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={sendingReply === request.id}
                          onClick={() => sendReply(request)}
                        >
                          {sendingReply === request.id ? 'Sending…' : 'Send Message'}
                        </button>
                      </div>
                      {currentReplyStatus && (
                        <p className={`conversation-feedback ${currentReplyStatus.type}`}>{currentReplyStatus.message}</p>
                      )}
                    </div>
                  </section>

                  {!FINAL_STATUSES.has(request.status) && (
                    <section className="request-amendment" aria-label="Request an amendment">
                      <div>
                        <h3>Request an Amendment</h3>
                        <p>
                          Use this when submitted instructions need to change. The original submission remains unchanged and the amendment is recorded in the conversation.
                        </p>
                      </div>
                      <div className="amendment-form">
                        <label>
                          <span>What should change?</span>
                          <select
                            value={amendment.category || 'scope'}
                            onChange={(event) =>
                              setAmendmentDraft((current) => ({
                                ...current,
                                [request.id]: {
                                  category: event.target.value,
                                  description: amendment.description || '',
                                },
                              }))
                            }
                          >
                            {AMENDMENT_OPTIONS.map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Describe the requested change</span>
                          <textarea
                            rows="4"
                            maxLength={5000}
                            value={amendment.description || ''}
                            onChange={(event) =>
                              setAmendmentDraft((current) => ({
                                ...current,
                                [request.id]: {
                                  category: amendment.category || 'scope',
                                  description: event.target.value,
                                },
                              }))
                            }
                            placeholder="State what should change and why."
                          />
                        </label>
                        <div className="amendment-actions">
                          <span>{(amendment.description || '').length}/5,000</span>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={currentAmendmentStatus?.type === 'loading'}
                            onClick={() => submitAmendment(request)}
                          >
                            {currentAmendmentStatus?.type === 'loading' ? 'Submitting…' : 'Submit Amendment Request'}
                          </button>
                        </div>
                        {currentAmendmentStatus && (
                          <p className={`conversation-feedback ${currentAmendmentStatus.type}`}>{currentAmendmentStatus.message}</p>
                        )}
                      </div>
                    </section>
                  )}
                </div>
              </details>
              <div className="request-reuse-actions">
                <p>Use this request’s information to prepare a new quote or search request.</p>
                <div>
                  <button className="secondary-button" type="button" onClick={() => onRequestQuote(request)} title="Request a Custom Quote using this request">
                    Quote
                  </button>
                  <button className="primary-button" type="button" onClick={() => onRequestOrder(request)} title="Request a Search using this request">
                    Order
                  </button>
                </div>
              </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
