// Only copy form fields from the client's own My Requests response. Never copy
// record IDs into new-request IDs, acknowledgments, files, or workflow state.
export const SERVICE_OPTIONS = [
  'Prior Art & Patentability Search',
  'Invalidity / Validity Search',
  'Freedom-to-Operate Search',
  'Patent Landscape / Competitive Analysis',
  'Search Strategy / Classification Support',
  'Other / Customized Assignment',
]

function text(value) {
  return typeof value === 'string' ? value : ''
}

function formDate(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? `${match[2]}/${match[3]}/${match[1]}` : ''
}

export function requestDataForForm(request, target) {
  if (!['discussion', 'quote', 'search'].includes(request?.type) || !['quote', 'order'].includes(target)) {
    throw new Error('Unsupported request or destination form.')
  }
  const details = request.details || {}
  const isDiscussion = request.type === 'discussion'
  const service = text(isDiscussion ? details.projectType : details.searchService)
  const sourceReference = text(request.reference) || text(request.id)
  const sourceTypeLabel = { discussion: 'Discuss a Project', quote: 'Request a Custom Quote', search: 'Request a Search' }[request.type]
  const sourceNote = `Source request: ${sourceTypeLabel} (${sourceReference})`
  const common = {
    name: text(details.clientName),
    organization: text(details.organization),
    country: text(details.country),
    searchService: SERVICE_OPTIONS.includes(service) ? service : '',
    technicalSubject: text(isDiscussion ? details.technologyDescription : details.technicalSubject),
    searchObjective: text(isDiscussion ? details.objective : details.searchObjective),
    jurisdictions: text(details.relevantJurisdictions),
    relevantDates: text(details.relevantDates),
    knownPatentDocuments: text(details.knownPatentDocuments),
    knownCompetitors: text(details.knownCompetitorsOrAssignees),
    preferredDeliverable: text(details.preferredDeliverable),
    discussionId: isDiscussion ? text(request.id) : '',
    acknowledgment: false,
    website: '',
    sourceReference,
  }
  const completionDate = formDate(details.desiredCompletionDate || details.requestedCompletionDate)
  const timingNote = details.timing ? `Relevant timing from discussion: ${text(details.timing)}` : ''

  if (target === 'quote') {
    return {
      ...common,
      projectDescription: text(details.projectDescription),
      desiredCompletionDate: completionDate,
      budgetConsiderations: text(details.budgetConsiderations),
      additionalInformation: [sourceNote, text(details.additionalInformation || details.additionalInstructions), timingNote]
        .filter(Boolean).join('\n\n'),
    }
  }

  return {
    ...common,
    billingOrganization: text(details.billingOrganization),
    requestedCompletionDate: completionDate,
    quoteId: request.type === 'quote' ? text(request.id) : '',
    additionalInstructions: [
      sourceNote,
      text(details.projectDescription),
      details.budgetConsiderations ? `Budget considerations from quote request: ${text(details.budgetConsiderations)}` : '',
      text(details.additionalInformation || details.additionalInstructions),
      timingNote,
    ].filter(Boolean).join('\n\n'),
  }
}
