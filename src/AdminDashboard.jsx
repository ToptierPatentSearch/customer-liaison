import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'

const PAGE_SIZE = 100

const STATUS_OPTIONS = {
  discussion: [
    ['new', 'Received'],
    ['reviewing', 'Under Review'],
    ['clarification_required', 'Information Required'],
    ['quote_requested', 'Quote Requested'],
    ['converted', 'Continued to Next Stage'],
    ['closed', 'Closed'],
  ],
  quote: [
    ['submitted', 'Submitted'],
    ['reviewing', 'Under Review'],
    ['clarification_required', 'Information Required'],
    ['quote_sent', 'Quote Sent'],
    ['accepted', 'Accepted'],
    ['converted', 'Continued to Next Stage'],
    ['closed', 'Closed'],
  ],
  order: [
    ['submitted', 'Submitted'],
    ['reviewing', 'Under Review'],
    ['clarification_required', 'Information Required'],
    ['scope_confirmed', 'Scope Confirmed'],
    ['search_in_progress', 'Search in Progress'],
    ['report_delivered', 'Report Delivered'],
    ['completed', 'Completed'],
    ['closed', 'Closed'],
  ],
}

const STATUS_LABELS = Object.fromEntries(
  Object.values(STATUS_OPTIONS).flat().map(([value, label]) => [value, label]),
)

function statusLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return '—'
  return STATUS_LABELS[value] || value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(date)
}

function textOrDash(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '—'
}

function fileSize(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return 'Unknown size'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

async function loadPaged(action, dataKey) {
  const collected = []
  let offset = 0
  let total = null

  while (total === null || collected.length < total) {
    const { data, error } = await supabase.functions.invoke('admin-orders', {
      body: { action, offset, limit: PAGE_SIZE },
    })

    if (error) throw new Error(error.message)

    const items = data?.[dataKey]
    if (!data?.ok || !Array.isArray(items)) {
      throw new Error(data?.error || 'Administrator data could not be loaded.')
    }

    collected.push(...items)
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : collected.length

    if (items.length < PAGE_SIZE) break
    offset += items.length

    if (offset > 10000) throw new Error('The administrator list is unusually large.')
  }

  return collected
}

export default function AdminDashboard({ adminEmail, onBack, onSignOut }) {
  const [activeTab, setActiveTab] = useState('discussions')
  const [orders, setOrders] = useState([])
  const [quotes, setQuotes] = useState([])
  const [discussions, setDiscussions] = useState([])
  const [status, setStatus] = useState({ type: 'loading', message: 'Loading administrator data…' })
  const [query, setQuery] = useState('')
  const [openingDocument, setOpeningDocument] = useState('')
  const [updatingStatus, setUpdatingStatus] = useState('')
  const [actionStatus, setActionStatus] = useState({ type: 'idle', message: '' })

  async function loadAll() {
    setStatus({ type: 'loading', message: 'Loading administrator data…' })

    try {
      const [loadedDiscussions, loadedQuotes, loadedOrders] = await Promise.all([
        loadPaged('list-discussions', 'discussions'),
        loadPaged('list-quotes', 'quotes'),
        loadPaged('list', 'orders'),
      ])

      setDiscussions(loadedDiscussions)
      setQuotes(loadedQuotes)
      setOrders(loadedOrders)
      setStatus({
        type: 'success',
        message:
          `${loadedDiscussions.length} discussion${loadedDiscussions.length === 1 ? '' : 's'}, ` +
          `${loadedQuotes.length} quote request${loadedQuotes.length === 1 ? '' : 's'}, and ` +
          `${loadedOrders.length} search request${loadedOrders.length === 1 ? '' : 's'} loaded.`,
      })
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Administrator data could not be loaded.',
      })
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  const filteredOrders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return orders

    return orders.filter((order) =>
      [
        order.order_reference,
        order.client_name,
        order.organization,
        order.email,
        order.country,
        order.search_service,
        order.technical_subject,
        order.search_objective,
        order.relevant_jurisdictions,
        order.known_patent_documents,
        order.known_competitors_or_assignees,
        order.preferred_deliverable,
        order.status,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [orders, query])

  const filteredQuotes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return quotes

    return quotes.filter((quote) =>
      [
        quote.quote_reference,
        quote.client_name,
        quote.organization,
        quote.email,
        quote.country,
        quote.search_service,
        quote.technical_subject,
        quote.project_description,
        quote.search_objective,
        quote.relevant_jurisdictions,
        quote.known_patent_documents,
        quote.known_competitors_or_assignees,
        quote.preferred_deliverable,
        quote.budget_considerations,
        quote.additional_information,
        quote.status,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [quotes, query])

  const filteredDiscussions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return discussions

    return discussions.filter((discussion) =>
      [
        discussion.discussion_reference,
        discussion.client_name,
        discussion.organization,
        discussion.email,
        discussion.project_type,
        discussion.objective,
        discussion.technology_description,
        discussion.timing,
        discussion.known_patent_documents,
        discussion.additional_information,
        discussion.status,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [discussions, query])

  async function openDocument(recordType, recordId, document) {
    const storagePath = document?.storage_path
    if (!storagePath) return

    setOpeningDocument(storagePath)

    try {
      const body = recordType === 'quote'
        ? { action: 'quote-document-url', quoteId: recordId, storagePath }
        : { action: 'document-url', orderId: recordId, storagePath }

      const { data, error } = await supabase.functions.invoke('admin-orders', { body })

      if (error) throw new Error(error.message)
      if (!data?.ok || !data.signedUrl) {
        throw new Error(data?.error || 'The document link could not be created.')
      }

      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'The document could not be opened.',
      })
    } finally {
      setOpeningDocument('')
    }
  }

  async function updateRequestStatus(recordType, recordId, nextStatus) {
    const updateKey = `${recordType}:${recordId}`
    setUpdatingStatus(updateKey)
    setActionStatus({ type: 'loading', message: 'Updating customer-visible status…' })

    try {
      const { data, error } = await supabase.functions.invoke('admin-orders', {
        body: {
          action: 'update-status',
          recordType,
          recordId,
          status: nextStatus,
        },
      })

      if (error) throw new Error(error.message)
      if (!data?.ok || !data.record) {
        throw new Error(data?.error || 'The status could not be updated.')
      }

      const applyUpdate = (records) =>
        records.map((record) =>
          record.id === recordId
            ? {
                ...record,
                status: data.record.status,
                updated_at: data.record.updated_at,
              }
            : record,
        )

      if (recordType === 'discussion') setDiscussions(applyUpdate)
      if (recordType === 'quote') setQuotes(applyUpdate)
      if (recordType === 'order') setOrders(applyUpdate)

      setActionStatus({
        type: 'success',
        message: `Status updated to “${statusLabel(data.record.status)}”. The customer can now see this status in My Requests.`,
      })
    } catch (error) {
      setActionStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'The status could not be updated.',
      })
    } finally {
      setUpdatingStatus('')
    }
  }

  const filteredByTab = {
    discussions: filteredDiscussions,
    quotes: filteredQuotes,
    orders: filteredOrders,
  }

  const totalsByTab = {
    discussions: discussions,
    quotes,
    orders,
  }

  const shownCount = filteredByTab[activeTab]?.length ?? 0
  const totalCount = totalsByTab[activeTab]?.length ?? 0
  const searchLabel =
    activeTab === 'discussions'
      ? 'discussions'
      : activeTab === 'quotes'
        ? 'quote requests'
        : 'search requests'

  return (
    <main className="page-shell admin-page-shell">
      <section className="form-card admin-card" aria-labelledby="admin-title">
        <header className="intro admin-intro">
          <div>
            <p className="eyebrow">Top-tier Patent Search</p>
            <h1 id="admin-title">Administrator</h1>
            <p>Review project discussions, custom quotation requests, and formal search requests from authenticated prospects.</p>
          </div>
          <div className="admin-header-actions">
            <button className="secondary-button" type="button" onClick={onBack}>Client View</button>
            <button className="secondary-button" type="button" onClick={onSignOut}>Sign out</button>
          </div>
        </header>

        <div className="admin-identity">
          <div>
            <strong>Administrator access</strong>
            <span>{adminEmail}</span>
          </div>
          <button className="secondary-button" type="button" onClick={loadAll}>Refresh</button>
        </div>

        <div className="admin-tabs" role="tablist" aria-label="Administrator records">
          <AdminTab active={activeTab === 'discussions'} onClick={() => { setActiveTab('discussions'); setQuery('') }}>
            Discussions ({discussions.length})
          </AdminTab>
          <AdminTab active={activeTab === 'quotes'} onClick={() => { setActiveTab('quotes'); setQuery('') }}>
            Quote Requests ({quotes.length})
          </AdminTab>
          <AdminTab active={activeTab === 'orders'} onClick={() => { setActiveTab('orders'); setQuery('') }}>
            Search Requests ({orders.length})
          </AdminTab>
        </div>

        <section className="admin-toolbar" aria-label="Administrator filters">
          <div>
            <strong>{totalCount}</strong>
            <span>Total records</span>
          </div>
          <div>
            <strong>{shownCount}</strong>
            <span>Shown</span>
          </div>
          <label className="admin-search">
            <span>Search {searchLabel}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Reference, client, email, service, keyword…"
            />
          </label>
        </section>

        {status.type !== 'success' && (
          <div className={`status admin-status status-${status.type}`} role={status.type === 'error' ? 'alert' : 'status'}>
            <strong>{status.type === 'error' ? 'Administrator action required' : 'Processing'}</strong>
            <span>{status.message}</span>
          </div>
        )}

        {actionStatus.type !== 'idle' && (
          <div
            className={`status admin-status admin-action-status status-${actionStatus.type}`}
            role={actionStatus.type === 'error' ? 'alert' : 'status'}
          >
            <strong>
              {actionStatus.type === 'success'
                ? 'Customer status updated'
                : actionStatus.type === 'error'
                  ? 'Status update failed'
                  : 'Updating status'}
            </strong>
            <span>{actionStatus.message}</span>
          </div>
        )}

        {activeTab === 'discussions' && (
          <DiscussionList
            discussions={filteredDiscussions}
            loading={status.type === 'loading'}
            updatingStatus={updatingStatus}
            onStatusChange={updateRequestStatus}
          />
        )}

        {activeTab === 'quotes' && (
          <QuoteList
            quotes={filteredQuotes}
            loading={status.type === 'loading'}
            openingDocument={openingDocument}
            onOpenDocument={(quoteId, document) => openDocument('quote', quoteId, document)}
            updatingStatus={updatingStatus}
            onStatusChange={updateRequestStatus}
          />
        )}

        {activeTab === 'orders' && (
          <OrderList
            orders={filteredOrders}
            loading={status.type === 'loading'}
            openingDocument={openingDocument}
            onOpenDocument={(orderId, document) => openDocument('order', orderId, document)}
            updatingStatus={updatingStatus}
            onStatusChange={updateRequestStatus}
          />
        )}
      </section>
    </main>
  )
}

function AdminTab({ active, onClick, children }) {
  return (
    <button type="button" className={active ? 'admin-tab active' : 'admin-tab'} onClick={onClick}>
      {children}
    </button>
  )
}

function StatusEditor({
  recordType,
  recordId,
  currentStatus,
  updating,
  onStatusChange,
}) {
  const options = STATUS_OPTIONS[recordType] ?? []
  const fallback = options[0]?.[0] ?? ''
  const [selectedStatus, setSelectedStatus] = useState(currentStatus || fallback)

  useEffect(() => {
    setSelectedStatus(currentStatus || fallback)
  }, [currentStatus, fallback])

  const hasChange = Boolean(selectedStatus) && selectedStatus !== currentStatus

  return (
    <section className="admin-status-editor" aria-label="Customer-visible status">
      <div>
        <h2>Customer-visible Status</h2>
        <p>
          This status is shown to the signed-in customer in My Requests.
        </p>
      </div>
      <div className="admin-status-controls">
        <label>
          <span>Status</span>
          <select
            value={selectedStatus}
            onChange={(event) => setSelectedStatus(event.target.value)}
            disabled={updating}
          >
            {options.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <button
          className="primary-button admin-status-save"
          type="button"
          disabled={!hasChange || updating}
          onClick={() => onStatusChange(recordType, recordId, selectedStatus)}
        >
          {updating ? 'Updating…' : 'Update Status'}
        </button>
      </div>
    </section>
  )
}

function DiscussionList({ discussions, loading, updatingStatus, onStatusChange }) {
  return (
    <section className="admin-orders-list" aria-label="Project discussions">
      {!loading && discussions.length === 0 && (
        <div className="admin-empty">No matching project discussions were found.</div>
      )}

      {discussions.map((discussion) => (
        <details className="admin-order" key={discussion.id}>
          <summary>
            <div className="admin-order-summary-main">
              <span className="reference">{discussion.discussion_reference}</span>
              <strong>{textOrDash(discussion.client_name)}</strong>
              <span>{textOrDash(discussion.organization)}</span>
            </div>
            <div className="admin-order-summary-meta">
              <span>{textOrDash(discussion.project_type)}</span>
              <span>{formatDateTime(discussion.created_at)}</span>
              <span className="admin-status-pill">{statusLabel(discussion.status)}</span>
            </div>
          </summary>

          <div className="admin-order-body">
            <StatusEditor
              recordType="discussion"
              recordId={discussion.id}
              currentStatus={discussion.status}
              updating={updatingStatus === `discussion:${discussion.id}`}
              onStatusChange={onStatusChange}
            />

            <section>
              <h2>Client</h2>
              <dl>
                <Definition label="Reference" value={textOrDash(discussion.discussion_reference)} mono />
                <Definition label="Name" value={textOrDash(discussion.client_name)} />
                <Definition label="Organization" value={textOrDash(discussion.organization)} />
                <Definition label="Email" value={textOrDash(discussion.email)} />
                <Definition label="Submitted" value={formatDateTime(discussion.created_at)} />
                <Definition label="Last updated" value={formatDateTime(discussion.updated_at)} />
                <Definition label="Status" value={statusLabel(discussion.status)} />
              </dl>
            </section>

            <section>
              <h2>Project Discussion</h2>
              <dl>
                <Definition label="Project type" value={textOrDash(discussion.project_type)} />
                <Definition label="Objective" value={textOrDash(discussion.objective)} multiline />
                <Definition label="Technology / invention" value={textOrDash(discussion.technology_description)} multiline />
                <Definition label="Relevant timing" value={textOrDash(discussion.timing)} multiline />
                <Definition label="Known patent documents" value={textOrDash(discussion.known_patent_documents)} multiline />
                <Definition label="Additional context" value={textOrDash(discussion.additional_information)} multiline />
              </dl>
            </section>
          </div>
        </details>
      ))}
    </section>
  )
}

function QuoteList({ quotes, loading, openingDocument, onOpenDocument, updatingStatus, onStatusChange }) {
  return (
    <section className="admin-orders-list" aria-label="Custom quotation requests">
      {!loading && quotes.length === 0 && (
        <div className="admin-empty">No matching quotation requests were found.</div>
      )}

      {quotes.map((quote) => {
        const documents = Array.isArray(quote.supporting_documents) ? quote.supporting_documents : []

        return (
          <details className="admin-order" key={quote.id}>
            <summary>
              <div className="admin-order-summary-main">
                <span className="reference">{quote.quote_reference}</span>
                <strong>{textOrDash(quote.client_name)}</strong>
                <span>{textOrDash(quote.organization)}</span>
              </div>
              <div className="admin-order-summary-meta">
                <span>{textOrDash(quote.search_service)}</span>
                <span>{formatDateTime(quote.created_at)}</span>
                <span className="admin-status-pill">{statusLabel(quote.status)}</span>
              </div>
            </summary>

            <div className="admin-order-body">
              <StatusEditor
                recordType="quote"
                recordId={quote.id}
                currentStatus={quote.status}
                updating={updatingStatus === `quote:${quote.id}`}
                onStatusChange={onStatusChange}
              />

              <section>
                <h2>Client</h2>
                <dl>
                  <Definition label="Quote reference" value={textOrDash(quote.quote_reference)} mono />
                  <Definition label="Originating discussion ID" value={textOrDash(quote.discussion_id)} mono />
                  <Definition label="Name" value={textOrDash(quote.client_name)} />
                  <Definition label="Organization" value={textOrDash(quote.organization)} />
                  <Definition label="Email" value={textOrDash(quote.email)} />
                  <Definition label="Country" value={textOrDash(quote.country)} />
                  <Definition label="Submitted" value={formatDateTime(quote.created_at)} />
                  <Definition label="Last updated" value={formatDateTime(quote.updated_at)} />
                  <Definition label="Status" value={statusLabel(quote.status)} />
                </dl>
              </section>

              <section>
                <h2>Quotation Scope</h2>
                <dl>
                  <Definition label="Requested service" value={textOrDash(quote.search_service)} />
                  <Definition label="Technical subject" value={textOrDash(quote.technical_subject)} multiline />
                  <Definition label="Project description" value={textOrDash(quote.project_description)} multiline />
                  <Definition label="Search objective" value={textOrDash(quote.search_objective)} multiline />
                  <Definition label="Jurisdictions" value={textOrDash(quote.relevant_jurisdictions)} multiline />
                  <Definition label="Relevant dates" value={textOrDash(quote.relevant_dates)} multiline />
                  <Definition label="Known patent documents" value={textOrDash(quote.known_patent_documents)} multiline />
                  <Definition label="Known competitors / assignees" value={textOrDash(quote.known_competitors_or_assignees)} multiline />
                  <Definition label="Desired completion date" value={formatDate(quote.desired_completion_date)} />
                  <Definition label="Preferred deliverable" value={textOrDash(quote.preferred_deliverable)} />
                  <Definition label="Budget considerations" value={textOrDash(quote.budget_considerations)} multiline />
                  <Definition label="Additional information" value={textOrDash(quote.additional_information)} multiline />
                </dl>
              </section>

              <DocumentList
                documents={documents}
                recordId={quote.id}
                openingDocument={openingDocument}
                onOpenDocument={onOpenDocument}
              />
            </div>
          </details>
        )
      })}
    </section>
  )
}

function OrderList({ orders, loading, openingDocument, onOpenDocument, updatingStatus, onStatusChange }) {
  return (
    <section className="admin-orders-list" aria-label="Search requests">
      {!loading && orders.length === 0 && (
        <div className="admin-empty">No matching search requests were found.</div>
      )}

      {orders.map((order) => {
        const documents = Array.isArray(order.supporting_documents) ? order.supporting_documents : []

        return (
          <details className="admin-order" key={order.id}>
            <summary>
              <div className="admin-order-summary-main">
                <span className="reference">{order.order_reference}</span>
                <strong>{textOrDash(order.client_name)}</strong>
                <span>{textOrDash(order.organization)}</span>
              </div>
              <div className="admin-order-summary-meta">
                <span>{textOrDash(order.search_service)}</span>
                <span>{formatDateTime(order.created_at)}</span>
                <span className="admin-status-pill">{statusLabel(order.status)}</span>
              </div>
            </summary>

            <div className="admin-order-body">
              <StatusEditor
                recordType="order"
                recordId={order.id}
                currentStatus={order.status}
                updating={updatingStatus === `order:${order.id}`}
                onStatusChange={onStatusChange}
              />

              <section>
                <h2>Client</h2>
                <dl>
                  <Definition label="Reference" value={textOrDash(order.order_reference)} mono />
                  <Definition label="Originating discussion ID" value={textOrDash(order.discussion_id)} mono />
                  <Definition label="Originating quote ID" value={textOrDash(order.quote_id)} mono />
                  <Definition label="Name" value={textOrDash(order.client_name)} />
                  <Definition label="Organization" value={textOrDash(order.organization)} />
                  <Definition label="Email" value={textOrDash(order.email)} />
                  <Definition label="Country" value={textOrDash(order.country)} />
                  <Definition label="Billing organization" value={textOrDash(order.billing_organization)} />
                  <Definition label="Submitted" value={formatDateTime(order.created_at)} />
                  <Definition label="Last updated" value={formatDateTime(order.updated_at)} />
                  <Definition label="Status" value={statusLabel(order.status)} />
                </dl>
              </section>

              <section>
                <h2>Assignment</h2>
                <dl>
                  <Definition label="Search service" value={textOrDash(order.search_service)} />
                  <Definition label="Technical subject" value={textOrDash(order.technical_subject)} multiline />
                  <Definition label="Search objective" value={textOrDash(order.search_objective)} multiline />
                  <Definition label="Jurisdictions" value={textOrDash(order.relevant_jurisdictions)} multiline />
                  <Definition label="Relevant dates" value={textOrDash(order.relevant_dates)} multiline />
                  <Definition label="Known patent documents" value={textOrDash(order.known_patent_documents)} multiline />
                  <Definition label="Known competitors / assignees" value={textOrDash(order.known_competitors_or_assignees)} multiline />
                  <Definition label="Requested completion date" value={formatDate(order.requested_completion_date)} />
                  <Definition label="Preferred deliverable" value={textOrDash(order.preferred_deliverable)} />
                  <Definition label="Additional instructions" value={textOrDash(order.additional_instructions)} multiline />
                </dl>
              </section>

              <DocumentList
                documents={documents}
                recordId={order.id}
                openingDocument={openingDocument}
                onOpenDocument={onOpenDocument}
              />
            </div>
          </details>
        )
      })}
    </section>
  )
}

function DocumentList({ documents, recordId, openingDocument, onOpenDocument }) {
  return (
    <section>
      <h2>Supporting Documents</h2>
      {documents.length === 0 ? (
        <p className="admin-no-documents">No supporting documents were submitted.</p>
      ) : (
        <div className="admin-documents">
          {documents.map((document, index) => (
            <div className="admin-document" key={document.storage_path || `${recordId}-${index}`}>
              <div>
                <strong>{textOrDash(document.original_name)}</strong>
                <span>{fileSize(document.size_bytes)}</span>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={openingDocument === document.storage_path}
                onClick={() => onOpenDocument(recordId, document)}
              >
                {openingDocument === document.storage_path ? 'Opening…' : 'Open Document'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Definition({ label, value, multiline = false, mono = false }) {
  return (
    <div className="admin-definition">
      <dt>{label}</dt>
      <dd className={`${multiline ? 'admin-multiline' : ''} ${mono ? 'reference' : ''}`.trim()}>
        {value}
      </dd>
    </div>
  )
}
