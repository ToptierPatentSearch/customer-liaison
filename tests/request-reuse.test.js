import assert from 'node:assert/strict'
import test from 'node:test'
import { requestDataForForm } from '../src/lib/requestReuse.js'

const discussion = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'discussion', reference: 'TPS-D-TEST', status: 'closed',
  details: {
    clientName: 'Discussion Client', organization: 'Example Research', email: 'old@example.test',
    projectType: 'Freedom-to-Operate Search', objective: 'Review freedom to operate',
    technologyDescription: 'Sensor circuit', timing: 'Before product launch',
    knownPatentDocuments: 'US1234567', additionalInformation: 'Include the controller.',
    scopeReviewAcknowledged: true,
  },
}
const quote = {
  id: '22222222-2222-4222-8222-222222222222',
  type: 'quote', reference: 'TPS-Q-TEST',
  details: {
    clientName: 'Quote Client', organization: 'Example Devices', country: 'United States',
    searchService: 'Prior Art & Patentability Search', technicalSubject: 'Optical sensor',
    projectDescription: 'Wearable measurement device', searchObjective: 'Find prior disclosures',
    relevantJurisdictions: 'US, JP', relevantDates: 'Before 2025-01-01',
    knownPatentDocuments: 'WO2024123456', knownCompetitorsOrAssignees: 'Example Competitor',
    desiredCompletionDate: '2026-11-20', preferredDeliverable: 'Search report',
    budgetConsiderations: 'Limit scope to the optical assembly', additionalInformation: 'Include nonpatent literature.',
    quoteRequestAcknowledged: true,
  },
}
const search = {
  ...quote, id: '33333333-3333-4333-8333-333333333333', type: 'search', reference: 'TPS-S-TEST',
  details: {
    ...quote.details, billingOrganization: 'Example Billing', desiredCompletionDate: null,
    requestedCompletionDate: '2026-12-02', projectDescription: null, budgetConsiderations: null,
    additionalInformation: null, additionalInstructions: 'Compare independent claims.',
  },
}

test('discussion fields are translated for both quote and order, including origin and timing', () => {
  for (const target of ['quote', 'order']) {
    const seed = requestDataForForm(discussion, target)
    assert.equal(seed.name, 'Discussion Client')
    assert.equal(seed.searchService, 'Freedom-to-Operate Search')
    assert.equal(seed.technicalSubject, 'Sensor circuit')
    assert.equal(seed.searchObjective, 'Review freedom to operate')
    assert.equal(seed.knownPatentDocuments, 'US1234567')
    assert.equal(seed.discussionId, discussion.id)
    const notes = seed.additionalInformation || seed.additionalInstructions
    assert.match(notes, /TPS-D-TEST/)
    assert.match(notes, /Include the controller/)
    assert.match(notes, /Before product launch/)
    assert.equal(seed.country, '')
    assert.equal(seed.jurisdictions, '')
  }
})

test('quote to order retains commercial and scope information with the correct linked quote ID', () => {
  const seed = requestDataForForm(quote, 'order')
  assert.equal(seed.quoteId, quote.id)
  assert.equal(seed.discussionId, '')
  assert.equal(seed.country, 'United States')
  assert.equal(seed.jurisdictions, 'US, JP')
  assert.equal(seed.relevantDates, 'Before 2025-01-01')
  assert.equal(seed.knownCompetitors, 'Example Competitor')
  assert.equal(seed.requestedCompletionDate, '11/20/2026')
  assert.equal(seed.preferredDeliverable, 'Search report')
  for (const value of ['TPS-Q-TEST', quote.details.projectDescription, quote.details.budgetConsiderations, quote.details.additionalInformation]) {
    assert.ok(seed.additionalInstructions.includes(value))
  }
})

test('search data maps to both forms, retaining instructions and converting the completion date', () => {
  const orderSeed = requestDataForForm(search, 'order')
  assert.equal(orderSeed.billingOrganization, 'Example Billing')
  assert.equal(orderSeed.requestedCompletionDate, '12/02/2026')
  assert.equal(orderSeed.quoteId, '')
  const quoteSeed = requestDataForForm(search, 'quote')
  assert.equal(quoteSeed.desiredCompletionDate, '12/02/2026')
  for (const seed of [orderSeed, quoteSeed]) {
    assert.equal(seed.technicalSubject, 'Optical sensor')
    assert.ok((seed.additionalInformation || seed.additionalInstructions).includes('Compare independent claims.'))
  }
})

test('all six conversions reset consent and omit old identities, files, status, and account email', () => {
  for (const request of [discussion, quote, search]) {
    for (const target of ['quote', 'order']) {
      const seed = requestDataForForm({ ...request, documents: [{ id: 'old-file' }], replies: [{ body: 'private reply' }] }, target)
      assert.equal(seed.acknowledgment, false)
      assert.equal(seed.website, '')
      for (const key of ['id', 'email', 'status', 'documents', 'replies', 'supportingDocuments', 'orderId']) {
        assert.equal(Object.hasOwn(seed, key), false, `${key} must not carry forward`)
      }
      if (target === 'quote') assert.equal(Object.hasOwn(seed, 'quoteId'), false)
      assert.equal(seed.sourceReference, request.reference)
    }
  }
})

test('quote to quote preserves project, budget, and desired date without reusing the old quote ID', () => {
  const seed = requestDataForForm(quote, 'quote')
  assert.equal(seed.projectDescription, quote.details.projectDescription)
  assert.equal(seed.budgetConsiderations, quote.details.budgetConsiderations)
  assert.equal(seed.desiredCompletionDate, '11/20/2026')
  assert.equal(seed.discussionId, '')
})

test('missing optional fields remain empty and unknown services require a new selection', () => {
  const seed = requestDataForForm({ ...discussion, details: { projectType: 'Unspecified consulting' } }, 'order')
  assert.equal(seed.searchService, '')
  assert.equal(seed.name, '')
  assert.equal(seed.requestedCompletionDate, '')
  assert.throws(() => requestDataForForm({ type: 'admin' }, 'quote'), /Unsupported/)
})
