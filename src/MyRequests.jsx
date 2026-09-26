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

const COMPLETED_STATUSES = new Set([
  'completed',
  'closed',
  'report_delivered',
  'converted',
])

function statusLabel(status) {
  if (!status) return 'Status Pending'
  return STATUS_LABELS[status] || status
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value) {
  if (!value) return '—'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'

  return new Intl.DateTimeFormat('en-US', {
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

export default function MyRequests() {
  const [requests, setRequests] = useState([])
  const [status, setStatus] = useState({ type: 'loading', message: 'Loading your requests…' })
  const [filter, setFilter] = useState('all')

  async function loadRequests() {
    setStatus({ type: 'loading', message: 'Loading your requests…' })

    try {
      const { data, error } = await supabase.functions.invoke('my-requests', {
        body: {},
      })

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

  const counts = useMemo(() => {
    const completed = requests.filter((request) => COMPLETED_STATUSES.has(request.status)).length
    return {
      all: requests.length,
      active: requests.length - completed,
      completed,
    }
  }, [requests])

  const filteredRequests = useMemo(() => {
    if (filter === 'active') {
      return requests.filter((request) => !COMPLETED_STATUSES.has(request.status))
    }
    if (filter === 'completed') {
      return requests.filter((request) => COMPLETED_STATUSES.has(request.status))
    }
    return requests
  }, [filter, requests])

  return (
    <div className="my-requests">
      <div className="my-requests-toolbar">
        <div className="request-filter-tabs" role="tablist" aria-label="Request filters">
          <button
            className={filter === 'all' ? 'request-filter active' : 'request-filter'}
            type="button"
            onClick={() => setFilter('all')}
            aria-selected={filter === 'all'}
          >
            All <span>{counts.all}</span>
          </button>
          <button
            className={filter === 'active' ? 'request-filter active' : 'request-filter'}
            type="button"
            onClick={() => setFilter('active')}
            aria-selected={filter === 'active'}
          >
            Active <span>{counts.active}</span>
          </button>
          <button
            className={filter === 'completed' ? 'request-filter active' : 'request-filter'}
            type="button"
            onClick={() => setFilter('completed')}
            aria-selected={filter === 'completed'}
          >
            Completed <span>{counts.completed}</span>
          </button>
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
          <button className="secondary-button" type="button" onClick={loadRequests}>
            Try again
          </button>
        </div>
      )}

      {status.type === 'idle' && filteredRequests.length === 0 && (
        <div className="my-requests-empty">
          <strong>
            {filter === 'all'
              ? 'No requests have been submitted yet.'
              : `No ${filter} requests were found.`}
          </strong>
          <span>
            Requests submitted through Discuss a Project, Request a Custom Quote, or Request a Search will appear here.
          </span>
        </div>
      )}

      {status.type === 'idle' && filteredRequests.length > 0 && (
        <div className="my-requests-list">
          {filteredRequests.map((request) => (
            <details className="customer-request-card" key={request.id}>
              <summary>
                <div className="customer-request-main">
                  <span className={`request-kind ${requestKindClass(request.type)}`}>
                    {request.typeLabel}
                  </span>
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
                  <div>
                    <dt>Request type</dt>
                    <dd>{request.typeLabel}</dd>
                  </div>
                  <div>
                    <dt>Reference</dt>
                    <dd>{request.reference || '—'}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{statusLabel(request.status)}</dd>
                  </div>
                  <div>
                    <dt>Service</dt>
                    <dd>{request.service || '—'}</dd>
                  </div>
                  <div>
                    <dt>Submitted</dt>
                    <dd>{formatDate(request.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Last updated</dt>
                    <dd>{formatDate(request.updatedAt || request.createdAt)}</dd>
                  </div>
                  {request.requestedCompletionDate && (
                    <div>
                      <dt>Requested completion</dt>
                      <dd>{formatDate(request.requestedCompletionDate)}</dd>
                    </div>
                  )}
                </dl>

                {request.summary && (
                  <div className="customer-request-summary">
                    <strong>Request summary</strong>
                    <p>{request.summary}</p>
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
