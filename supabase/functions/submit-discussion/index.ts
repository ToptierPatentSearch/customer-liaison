import { withSupabase } from 'npm:@supabase/server@^1'

const PROJECT_TYPES = new Set([
  'Prior Art & Patentability Search',
  'Invalidity / Validity Search',
  'Freedom-to-Operate Search',
  'Patent Landscape / Competitive Analysis',
  'Search Strategy / Classification Support',
  'Not Sure Yet',
  'Other / Customized Assignment',
])

function makeDiscussionReference(discussionId: string) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `TPS-DISC-${date}-${discussionId.slice(0, 8).toUpperCase()}`
}

function requiredText(value: unknown, fieldName: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required.`)
  }

  const text = value.trim()
  if (text.length > maximum) {
    throw new Error(`${fieldName} is too long.`)
  }

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
        return Response.json(
          { ok: false, error: 'An authenticated account is required.' },
          { status: 401 },
        )
      }

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, error: 'Invalid JSON request.' }, { status: 400 })
      }

      if (typeof body.website === 'string' && body.website.trim() !== '') {
        return Response.json({ ok: true, message: 'Project information received.' })
      }

      try {
        const discussionId = crypto.randomUUID()
        const discussionReference = makeDiscussionReference(discussionId)

        const clientName = requiredText(body.name, 'Name', 160)
        const organization = optionalText(body.organization, 200)
        const email = authenticatedEmail.toLowerCase()

        const projectType = requiredText(body.projectType, 'Project type', 200)
        if (!PROJECT_TYPES.has(projectType)) {
          throw new Error('Please select a valid project type.')
        }

        const objective = requiredText(body.objective, 'Project objective', 5000)
        const technologyDescription = requiredText(
          body.technologyDescription,
          'Technology / invention',
          7000,
        )
        const timing = optionalText(body.timing, 1000)
        const knownPatentDocuments = optionalText(body.knownPatentDocuments, 5000)
        const additionalInformation = optionalText(body.additionalInformation, 5000)

        if (body.acknowledgment !== true) {
          throw new Error('The discussion-scope acknowledgment must be accepted.')
        }

        const { error } = await ctx.supabaseAdmin.from('project_discussions').insert({
          id: discussionId,
          user_id: authenticatedUserId,
          discussion_reference: discussionReference,
          client_name: clientName,
          organization,
          email,
          project_type: projectType,
          objective,
          technology_description: technologyDescription,
          timing,
          known_patent_documents: knownPatentDocuments,
          additional_information: additionalInformation,
          scope_review_acknowledged: true,
          source: 'discuss-a-project',
          status: 'new',
        })

        if (error) {
          console.error('Discussion database insert error:', error)
          return Response.json(
            { ok: false, error: 'The project discussion could not be recorded. Please try again.' },
            { status: 500 },
          )
        }

        return Response.json(
          {
            ok: true,
            message: 'Your project discussion was submitted for initial review.',
            discussionId,
            discussionReference,
          },
          { status: 201 },
        )
      } catch (error) {
        console.error('Discussion validation error:', error)
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid project information.',
          },
          { status: 400 },
        )
      }
    },
  ),
}
