import { useEffect, useMemo, useRef, useState } from 'react'
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

function statusLabel(status) {
  if (!status) return 'Status Pending'
  return STATUS_LABELS[status] || status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value, withTime = false) {
  if (!value) return '—'
  const date = new Date(value)
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
  const markingStatusSeen = useRef(new Set())

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

  async function markStatusSeen(request) {
    if (!request?.hasStatusUpdate || markingStatusSeen.current.has(request.id)) return

    markingStatusSeen.current.add(request.id)

    try {
      const { data, error } = await supabase.functions.invoke('my-requests', {
        body: {
          action: 'mark-status-seen',
          requestType: databaseRequestType(request.type),
          requestId: request.id,
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
                hasStatusUpdate: false,
                seenStatusVersion: data.seenStatusVersion ?? item.statusVersion,
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

      <section className="status-color-legend" aria-labelledby="status-color-legend-title">
        <div className="status-color-legend-heading">
          <div>
            <h2 id="status-color-legend-title">Status Color Legend</h2>
            <p>Colors identify the current stage and make status changes easier to scan. Text labels are always shown with the colors.</p>
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
          <strong>{filter === 'all' ? 'No requests have been submitted yet.' : `No ${filter} requests were found.`}</strong>
          <span>Requests submitted through Discuss a Project, Request a Custom Quote, or Request a Search will appear here.</span>
        </div>
      )}

      {status.type === 'idle' && filteredRequests.length > 0 && (
        <div className="my-requests-list">
          {filteredRequests.map((request) => {
            const replies = Array.isArray(request.replies) ? request.replies : []
            const history = Array.isArray(request.statusHistory) ? request.statusHistory : []
            const currentReplyStatus = replyStatus[request.id]

            return (
              <details
                className={`customer-request-card${request.hasStatusUpdate ? ' has-status-update' : ''}`}
                key={request.id}
                onToggle={(event) => {
                  if (event.currentTarget.open) markStatusSeen(request)
                }}
              >
                <summary>
                  <div className="customer-request-main">
                    <div className="customer-request-label-row">
                      <span className={`request-kind ${requestKindClass(request.type)}`}>{request.typeLabel}</span>
                      {request.hasStatusUpdate && (
                        <span className="request-new-update" aria-label="New status update">NEW UPDATE</span>
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
                    <span>Status changed: {formatDate(request.statusUpdatedAt || request.createdAt, true)}</span>
                    <span>Last activity: {formatDate(request.updatedAt || request.createdAt, true)}</span>
                  </div>
                </summary>

                <div className="customer-request-details">
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
                    <div><dt>Status changed</dt><dd>{formatDate(request.statusUpdatedAt || request.createdAt, true)}</dd></div>
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
