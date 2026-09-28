import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'

const STATUS_LABELS = {
  new: 'Received',
  submitted: 'Submitted',
  reviewing: 'Under Review',
  clarification_required: 'Information Required',
  scope_confirmed: 'Scope Confirmed',
  quote_sent: 'Quote Sent',
  accepted: 'Accepted',
  search_in_progress: 'Search in Progress',
  report_delivered: 'Report Delivered',
  completed: 'Completed',
  closed: 'Closed',
  quote_requested: 'Quote Requested',
  converted: 'Continued to Next Stage',
}

const COMPLETED_STATUSES = new Set(['completed', 'closed', 'report_delivered', 'converted'])

function statusLabel(status) {
  if (!status) return 'Status Pending'
  return STATUS_LABELS[status] || status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value, withTime = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date)
}

function requestKindClass(type) {
  if (type === 'discussion') return 'request-kind-discussion'
  if (type === 'quote') return 'request-kind-quote'
  return 'request-kind-search'
}

function databaseRequestType(type) {
  return type === 'search' ? 'order' : type
}

export default function MyRequests() {
  const [requests, setRequests] = useState([])
  const [status, setStatus] = useState({ type: 'loading', message: 'Loading your requests…' })
  const [filter, setFilter] = useState('all')
  const [replyText, setReplyText] = useState({})
  const [sendingReply, setSendingReply] = useState('')
  const [replyStatus, setReplyStatus] = useState({})

  async function loadRequests() {
    setStatus({ type: 'loading', message: 'Loading your requests…' })
    try {
      const { data, error } = await supabase.functions.invoke('my-requests', { body: {} })
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
      const { data, error } = await supabase.functions.invoke('my-requests', {
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

  const counts = useMemo(() => {
    const completed = requests.filter((request) => COMPLETED_STATUSES.has(request.status)).length
    return { all: requests.length, active: requests.length - completed, completed }
  }, [requests])

  const filteredRequests = useMemo(() => {
    if (filter === 'active') return requests.filter((request) => !COMPLETED_STATUSES.has(request.status))
    if (filter === 'completed') return requests.filter((request) => COMPLETED_STATUSES.has(request.status))
    return requests
  }, [filter, requests])

  return (
    <div className="my-requests">
      <div className="my-requests-toolbar">
        <div className="request-filter-tabs" role="tablist" aria-label="Request filters">
          {[
            ['all', 'All'],
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
          <strong>{filter === 'all' ? 'No requests have been submitted yet.' : `No ${filter} requests were found.`}</strong>
          <span>Requests submitted through Discuss a Project, Request a Custom Quote, or Request a Search will appear here.</span>
        </div>
      )}

      {status.type === 'idle' && filteredRequests.length > 0 && (
        <div className="my-requests-list">
          {filteredRequests.map((request) => {
            const replies = Array.isArray(request.replies) ? request.replies : []
            const currentReplyStatus = replyStatus[request.id]

            return (
              <details className="customer-request-card" key={request.id}>
                <summary>
                  <div className="customer-request-main">
                    <span className={`request-kind ${requestKindClass(request.type)}`}>{request.typeLabel}</span>
                    <strong>{request.subject || request.typeLabel}</strong>
                    <span className="customer-request-reference">{request.reference || 'Reference pending'}</span>
                  </div>

                  <div className="customer-request-meta">
                    <span className={`customer-status-pill status-value-${request.status || 'pending'}`}>
                      {statusLabel(request.status)}
                    </span>
                    <span>Submitted: {formatDate(request.createdAt)}</span>
                    <span>Updated: {formatDate(request.updatedAt || request.createdAt)}</span>
                  </div>
                </summary>

                <div className="customer-request-details">
                  <dl>
                    <div><dt>Request type</dt><dd>{request.typeLabel}</dd></div>
                    <div><dt>Reference</dt><dd>{request.reference || '—'}</dd></div>
                    <div><dt>Status</dt><dd>{statusLabel(request.status)}</dd></div>
                    <div><dt>Service</dt><dd>{request.service || '—'}</dd></div>
                    <div><dt>Submitted</dt><dd>{formatDate(request.createdAt)}</dd></div>
                    <div><dt>Last updated</dt><dd>{formatDate(request.updatedAt || request.createdAt)}</dd></div>
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

                  <section className="request-conversation" aria-label="Request conversation">
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
                            className={`conversation-message ${reply.senderRole === 'admin' ? 'from-admin' : 'from-client'}`}
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
                </div>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}
