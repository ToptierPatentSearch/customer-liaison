import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'

const PAGE_SIZE = 100

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

        {activeTab === 'discussions' && (
          <DiscussionList discussions={filteredDiscussions} loading={status.type === 'loading'} />
        )}

        {activeTab === 'quotes' && (
          <QuoteList
            quotes={filteredQuotes}
            loading={status.type === 'loading'}
            openingDocument={openingDocument}
            onOpenDocument={(quoteId, document) => openDocument('quote', quoteId, document)}
          />
        )}

        {activeTab === 'orders' && (
          <OrderList
            orders={filteredOrders}
            loading={status.type === 'loading'}
            openingDocument={openingDocument}
            onOpenDocument={(orderId, document) => openDocument('order', orderId, document)}
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

function DiscussionList({ discussions, loading }) {
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
              <span className="admin-status-pill">{textOrDash(discussion.status)}</span>
            </div>
          </summary>

          <div className="admin-order-body">
            <section>
              <h2>Client</h2>
              <dl>
                <Definition label="Reference" value={textOrDash(discussion.discussion_reference)} mono />
                <Definition label="Name" value={textOrDash(discussion.client_name)} />
                <Definition label="Organization" value={textOrDash(discussion.organization)} />
                <Definition label="Email" value={textOrDash(discussion.email)} />
                <Definition label="Submitted" value={formatDateTime(discussion.created_at)} />
                <Definition label="Status" value={textOrDash(discussion.status)} />
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

function QuoteList({ quotes, loading, openingDocument, onOpenDocument }) {
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
                <span className="admin-status-pill">{textOrDash(quote.status)}</span>
              </div>
            </summary>

            <div className="admin-order-body">
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
                  <Definition label="Status" value={textOrDash(quote.status)} />
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

function OrderList({ orders, loading, openingDocument, onOpenDocument }) {
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
                <span className="admin-status-pill">{textOrDash(order.status)}</span>
              </div>
            </summary>

            <div className="admin-order-body">
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
