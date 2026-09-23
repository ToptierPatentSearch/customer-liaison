import { withSupabase } from 'npm:@supabase/server@^1'

const SERVICE_OPTIONS = new Set([
  'Prior Art & Patentability Search',
  'Invalidity / Validity Search',
  'Freedom-to-Operate Search',
  'Patent Landscape / Competitive Analysis',
  'Search Strategy / Classification Support',
  'Other / Customized Assignment',
])

const DELIVERABLE_OPTIONS = new Set([
  'Search report',
  'Search report with claim mapping / comments',
  'Patent list / bibliography',
  'Spreadsheet / structured results',
  'Classification / search-query support',
  'Other / to be confirmed',
])

const MAX_FILES = 8
const MAX_FILE_BYTES = 10 * 1024 * 1024

function makeOrderReference(orderId: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `TPS-${date}-${orderId.slice(0, 8).toUpperCase()}`
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function optionalUuid(value: unknown, fieldName: string) {
  if (value === null || value === undefined || value === '') return null
  if (!isUuid(value)) throw new Error(`${fieldName} is invalid.`)
  return value
}

function requiredText(value: unknown, fieldName: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required.`)
  }
  const text = value.trim()
  if (text.length > maximum) throw new Error(`${fieldName} is too long.`)
  return text
}

function optionalText(value: unknown, maximum: number) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('Invalid text value.')
  const text = value.trim()
  if (!text) return null
  if (text.length > maximum) throw new Error('A submitted field is too long.')
  return text
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function validIsoDate(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Requested completion date is invalid.')
  }
  const [year, month, day] = value.split('-').map(Number)
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error('Requested completion date is invalid.')
  }
  return value
}

function validateSupportingDocuments(value: unknown, orderId: string, userId: string) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Supporting documents are invalid.')
  if (value.length > MAX_FILES) {
    throw new Error(`No more than ${MAX_FILES} supporting documents are permitted.`)
  }

  return value.map((document) => {
    if (!document || typeof document !== 'object') {
      throw new Error('Supporting-document information is invalid.')
    }

    const item = document as Record<string, unknown>
    const originalName = requiredText(item.original_name, 'Supporting-document name', 255)
    const storagePath = requiredText(item.storage_path, 'Supporting-document storage path', 1000)

    if (!storagePath.startsWith(`${userId}/${orderId}/`)) {
      throw new Error('Supporting-document storage path is invalid.')
    }

    const sizeBytes = Number(item.size_bytes)
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_FILE_BYTES) {
      throw new Error(`Each supporting document must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller.`)
    }

    return {
      original_name: originalName,
      storage_path: storagePath,
      content_type:
        typeof item.content_type === 'string' ? item.content_type.slice(0, 200) : null,
      size_bytes: sizeBytes,
    }
  })
}

export default {
  fetch: withSupabase(
    { auth: 'user' },
    async (req, ctx) => {
      if (req.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed.' }, { status: 405 })
      }

      const authenticatedUserId = ctx.userClaims?.id
      const authenticatedEmail = ctx.userClaims?.email

      if (
        typeof authenticatedUserId !== 'string' ||
        !authenticatedUserId ||
        typeof authenticatedEmail !== 'string' ||
        !validEmail(authenticatedEmail)
      ) {
        return Response.json({ ok: false, error: 'An authenticated account is required.' }, { status: 401 })
      }

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, error: 'Invalid JSON request.' }, { status: 400 })
      }

      if (typeof body.website === 'string' && body.website.trim() !== '') {
        return Response.json({ ok: true, message: 'Order details received.' })
      }

      try {
        const orderId = isUuid(body.orderId) ? body.orderId : crypto.randomUUID()
        const orderReference = makeOrderReference(orderId)
        const discussionId = optionalUuid(body.discussionId, 'Originating discussion')

        if (discussionId) {
          const { data: discussion, error: discussionError } = await ctx.supabaseAdmin
            .from('project_discussions')
            .select('id, user_id')
            .eq('id', discussionId)
            .maybeSingle()

          if (discussionError) {
            console.error('Originating discussion lookup failed:', discussionError)
            throw new Error('The originating project discussion could not be verified.')
          }

          if (!discussion || discussion.user_id !== authenticatedUserId) {
            throw new Error('The originating project discussion does not belong to this account.')
          }
        }

        const clientName = requiredText(body.name, 'Name', 160)
        const organization = optionalText(body.organization, 200)
        const email = authenticatedEmail.toLowerCase()
        const country = requiredText(body.country, 'Country', 120)
        const billingOrganization = optionalText(body.billingOrganization, 200)

        const searchService = requiredText(body.searchService, 'Search service', 200)
        if (!SERVICE_OPTIONS.has(searchService)) throw new Error('Please select a valid search service.')

        const technicalSubject = requiredText(body.technicalSubject, 'Technical subject', 3000)
        const searchObjective = requiredText(body.searchObjective, 'Search objective', 5000)
        const jurisdictions = requiredText(body.jurisdictions, 'Relevant jurisdictions', 1000)
        const relevantDates = optionalText(body.relevantDates, 1000)
        const knownPatentDocuments = optionalText(body.knownPatentDocuments, 5000)
        const knownCompetitors = optionalText(body.knownCompetitors, 3000)
        const requestedCompletionDate = validIsoDate(body.requestedCompletionDate)

        const preferredDeliverable = requiredText(body.preferredDeliverable, 'Preferred deliverable', 300)
        if (!DELIVERABLE_OPTIONS.has(preferredDeliverable)) {
          throw new Error('Please select a valid preferred deliverable.')
        }

        const additionalInstructions = optionalText(body.additionalInstructions, 5000)
        if (body.acknowledgment !== true) {
          throw new Error('The scope-review acknowledgment must be accepted.')
        }

        const supportingDocuments = validateSupportingDocuments(body.supportingDocuments, orderId, authenticatedUserId)

        const { error } = await ctx.supabaseAdmin.from('order_requests').insert({
          id: orderId,
          user_id: authenticatedUserId,
          discussion_id: discussionId,
          order_reference: orderReference,
          client_name: clientName,
          organization,
          email,
          country,
          billing_organization: billingOrganization,
          search_service: searchService,
          technical_subject: technicalSubject,
          search_objective: searchObjective,
          relevant_jurisdictions: jurisdictions,
          relevant_dates: relevantDates,
          known_patent_documents: knownPatentDocuments,
          known_competitors_or_assignees: knownCompetitors,
          requested_completion_date: requestedCompletionDate,
          preferred_deliverable: preferredDeliverable,
          additional_instructions: additionalInstructions,
          supporting_documents: supportingDocuments,
          scope_review_acknowledged: true,
          source: 'place-an-order-section-4',
          status: 'submitted',
        })

        if (error) {
          console.error('Database insert error:', error)
          if (error.code === '23505') {
            return Response.json({ ok: false, error: 'This order has already been submitted.' }, { status: 409 })
          }
          return Response.json(
            { ok: false, error: 'The order could not be recorded. Please try again.' },
            { status: 500 },
          )
        }

        return Response.json(
          {
            ok: true,
            message: 'Your order details were submitted for initial scope review.',
            orderId,
            orderReference,
          },
          { status: 201 },
        )
      } catch (error) {
        console.error('Validation error:', error)
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid order information.',
          },
          { status: 400 },
        )
      }
    },
  ),
}
