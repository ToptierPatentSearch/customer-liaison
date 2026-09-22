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

export default function AdminOrders({ adminEmail, onBack, onSignOut }) {
  const [orders, setOrders] = useState([])
  const [status, setStatus] = useState({ type: 'loading', message: 'Loading all orders…' })
  const [query, setQuery] = useState('')
  const [openingDocument, setOpeningDocument] = useState('')

  async function loadOrders() {
    setStatus({ type: 'loading', message: 'Loading all orders…' })

    try {
      const collected = []
      let offset = 0
      let total = null

      while (total === null || collected.length < total) {
        const { data, error } = await supabase.functions.invoke('admin-orders', {
          body: {
            action: 'list',
            offset,
            limit: PAGE_SIZE,
          },
        })

        if (error) throw new Error(error.message)
        if (!data?.ok || !Array.isArray(data.orders)) {
          throw new Error(data?.error || 'The administrator order list could not be loaded.')
        }

        collected.push(...data.orders)
        total = Number.isFinite(Number(data.total)) ? Number(data.total) : collected.length

        if (data.orders.length < PAGE_SIZE) break
        offset += data.orders.length

        if (offset > 10000) {
          throw new Error('The order list is unusually large. Please narrow the administrative query.')
        }
      }

      setOrders(collected)
      setStatus({
        type: 'success',
        message: `${collected.length} order${collected.length === 1 ? '' : 's'} loaded.`,
      })
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'The administrator order list could not be loaded.',
      })
    }
  }

  useEffect(() => {
    loadOrders()
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

  async function openDocument(orderId, document) {
    const storagePath = document?.storage_path
    if (!storagePath) return

    setOpeningDocument(storagePath)

    try {
      const { data, error } = await supabase.functions.invoke('admin-orders', {
        body: {
          action: 'document-url',
          orderId,
          storagePath,
        },
      })

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

  return (
    <main className="page-shell admin-page-shell">
      <section className="form-card admin-card" aria-labelledby="admin-orders-title">
        <header className="intro admin-intro">
          <div>
            <p className="eyebrow">Top-tier Patent Search</p>
            <h1 id="admin-orders-title">Administrator — Orders</h1>
            <p>Review prospect order requests and securely access supporting documents.</p>
          </div>
          <div className="admin-header-actions">
            <button className="secondary-button" type="button" onClick={onBack}>
              Order Form
            </button>
            <button className="secondary-button" type="button" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </header>

        <div className="admin-identity">
          <div>
            <strong>Administrator access</strong>
            <span>{adminEmail}</span>
          </div>
          <button className="secondary-button" type="button" onClick={loadOrders}>
            Refresh Orders
          </button>
        </div>

        <section className="admin-toolbar" aria-label="Order filters">
          <div>
            <strong>{orders.length}</strong>
            <span>Total orders</span>
          </div>
          <div>
            <strong>{filteredOrders.length}</strong>
            <span>Shown</span>
          </div>
          <label className="admin-search">
            <span>Search orders</span>
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

        <section className="admin-orders-list" aria-label="Orders">
          {status.type !== 'loading' && filteredOrders.length === 0 && (
            <div className="admin-empty">No matching orders were found.</div>
          )}

          {filteredOrders.map((order) => {
            const documents = Array.isArray(order.supporting_documents)
              ? order.supporting_documents
              : []

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
                    <h2>Client Information</h2>
                    <Definition label="Name" value={textOrDash(order.client_name)} />
                    <Definition label="Organization" value={textOrDash(order.organization)} />
                    <Definition label="Email" value={textOrDash(order.email)} />
                    <Definition label="Country" value={textOrDash(order.country)} />
                    <Definition label="Billing organization" value={textOrDash(order.billing_organization)} />
                    <Definition label="User ID" value={textOrDash(order.user_id)} mono />
                  </section>

                  <section>
                    <h2>Assignment Information</h2>
                    <Definition label="Search service" value={textOrDash(order.search_service)} />
                    <Definition label="Technical subject" value={textOrDash(order.technical_subject)} multiline />
                    <Definition label="Search objective" value={textOrDash(order.search_objective)} multiline />
                    <Definition label="Relevant jurisdictions" value={textOrDash(order.relevant_jurisdictions)} />
                    <Definition label="Relevant dates" value={textOrDash(order.relevant_dates)} />
                    <Definition label="Known patent documents" value={textOrDash(order.known_patent_documents)} multiline />
                    <Definition label="Known competitors / assignees" value={textOrDash(order.known_competitors_or_assignees)} multiline />
                    <Definition label="Requested completion date" value={formatDate(order.requested_completion_date)} />
                    <Definition label="Preferred deliverable" value={textOrDash(order.preferred_deliverable)} />
                    <Definition label="Additional instructions" value={textOrDash(order.additional_instructions)} multiline />
                  </section>

                  <section>
                    <h2>Order Record</h2>
                    <Definition label="Order reference" value={textOrDash(order.order_reference)} mono />
                    <Definition label="Submitted" value={formatDateTime(order.created_at)} />
                    <Definition label="Status" value={textOrDash(order.status)} />
                    <Definition label="Source" value={textOrDash(order.source)} />
                    <Definition
                      label="Scope review acknowledged"
                      value={order.scope_review_acknowledged ? 'Yes' : 'No'}
                    />
                  </section>

                  <section>
                    <h2>Supporting Documents</h2>
                    {documents.length === 0 ? (
                      <p className="admin-no-documents">No supporting documents were submitted.</p>
                    ) : (
                      <div className="admin-documents">
                        {documents.map((document, index) => (
                          <div className="admin-document" key={document.storage_path || `${order.id}-${index}`}>
                            <div>
                              <strong>{textOrDash(document.original_name)}</strong>
                              <span>{fileSize(document.size_bytes)}</span>
                            </div>
                            <button
                              className="secondary-button"
                              type="button"
                              disabled={openingDocument === document.storage_path}
                              onClick={() => openDocument(order.id, document)}
                            >
                              {openingDocument === document.storage_path ? 'Opening…' : 'Open Document'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </details>
            )
          })}
        </section>
      </section>
    </main>
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
