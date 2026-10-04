// Exercise the production bundle with synthetic accounts/files and intercepted
// Supabase responses. Never create accounts, records, or uploads in production.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { resolve, extname } from 'node:path'
import { build, createServer as createViteServer } from 'vite'
import { chromium } from 'playwright'

process.env.VITE_SUPABASE_URL = 'https://syshvcymwktnkrkrvwtk.supabase.co'
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_synthetic_csp_test_only'
const backend = process.env.VITE_SUPABASE_URL
const source = await readFile('index.html', 'utf8')
await build({ logLevel: 'error' })
const built = await readFile('dist/index.html', 'utf8')
assert.ok(built.indexOf('http-equiv="Content-Security-Policy"') < built.indexOf('<script'))
assert.ok(built.includes("style-src 'self'") && !built.includes('unsafe-inline') && !built.includes('unsafe-eval'))
const dev = await createViteServer({ server: { middlewareMode: true }, appType: 'custom' })
try {
  const devHtml = await dev.transformIndexHtml('/customer-liaison/', source)
  assert.ok(!devHtml.includes('http-equiv="Content-Security-Policy"'))
  assert.ok(devHtml.includes('/@vite/client'), 'Local hot reload remains available')
} finally { await dev.close() }

const directory = resolve('dist')
const server = createHttpServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (!pathname.startsWith('/customer-liaison/')) throw new Error('Unknown route')
    if (pathname === '/customer-liaison/csp-eval-probe.js') {
      // Browser automation evaluations can bypass the unsafe-eval restriction.
      // Run this check from a normally loaded, permitted script instead.
      response.writeHead(200, { 'Content-Type': 'text/javascript' })
      response.end("try { new Function('return 1')(); window.cspEvalBlocked = false } catch { window.cspEvalBlocked = true }")
      return
    }
    const file = resolve(directory, pathname.slice('/customer-liaison/'.length) || 'index.html')
    if (!file.startsWith(directory + '/')) throw new Error('Invalid path')
    const body = await readFile(file)
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' })
    response.end(body)
  } catch { response.writeHead(404); response.end('Not found') }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CSP_BROWSER_EXECUTABLE ? { executablePath: process.env.CSP_BROWSER_EXECUTABLE } : {}),
    ...(process.env.CSP_BROWSER_ARGS ? { args: JSON.parse(process.env.CSP_BROWSER_ARGS) } : {}),
  })
  const context = await browser.newContext()
  context.setDefaultTimeout(15_000)
  await context.addInitScript(() => {
    window.cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => window.cspViolations.push(event.effectiveDirective))
  })
  const calls = []
  const submissions = []
  const unexpected = []
  const userId = '11111111-1111-4111-8111-111111111111'
  const factorId = '22222222-2222-4222-8222-222222222222'
  let verified = false
  const user = () => ({ id: userId, email: 'synthetic@example.test', aud: 'authenticated',
    factors: verified ? [{ id: factorId, factor_type: 'totp', status: 'verified' }] : [] })
  const session = () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const access_token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, aal: verified ? 'aal2' : 'aal1', amr: [{ method: 'password', timestamp: 1 }], exp: Math.floor(Date.now() / 1000) + 3600 })}.c3ludGhldGlj`
    return { access_token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, user: user() }
  }
  const original = { original_name: 'synthetic-original.txt', storage_path: userId + '/synthetic.txt', size_bytes: 9 }
  const workspace = { id: 'synthetic-workspace', original_name: 'synthetic-workspace.txt', storage_path: userId + '/workspace.txt', size_bytes: 9, uploader_role: 'admin', visible_to_client: true }
  const records = ['discussion', 'quote', 'search'].map((type) => ({ id: 'synthetic-' + type, type, typeLabel: type + ' request', reference: 'TEST-' + type,
    subject: 'Synthetic ' + type, status: type === 'discussion' ? 'closed' : type === 'quote' ? 'accepted' : 'submitted', createdAt: '2026-10-03T00:00:00Z', replies: [], details: {
      clientName: 'Client ' + type, organization: 'Organization ' + type, country: 'Japan',
      projectType: 'Prior Art & Patentability Search', searchService: 'Prior Art & Patentability Search',
      technologyDescription: 'Technology ' + type, technicalSubject: 'Technology ' + type,
      objective: 'Objective ' + type, searchObjective: 'Objective ' + type,
      relevantJurisdictions: 'US, JP', desiredCompletionDate: type === 'quote' ? '2026-11-20' : null,
      requestedCompletionDate: type === 'search' ? '2026-12-02' : null, preferredDeliverable: 'Search report',
      additionalInformation: 'Notes ' + type, billingOrganization: type === 'search' ? 'Billing search' : null,
    },
    originalDocuments: [{ source: 'original', originalName: original.original_name, storagePath: original.storage_path, sizeBytes: 9 }],
    documents: type === 'quote' ? [{ id: workspace.id, originalName: workspace.original_name, storagePath: workspace.storage_path, sizeBytes: 9, uploaderRole: 'admin' }] : [],
  }))
  await context.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.origin === origin) return route.continue()
    if (url.origin !== backend) { unexpected.push(url.origin); return route.abort() }
    const body = req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() ?? {} : {}
    const action = body.action ?? ''
    calls.push(url.pathname + (action ? ':' + action : ''))
    const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (url.pathname === '/auth/v1/token') return json(session())
    if (url.pathname === '/auth/v1/user') return json(user())
    if (url.pathname === '/auth/v1/factors') return json({ id: factorId, type: 'totp', friendly_name: 'Synthetic test', totp: {
      qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="black"/></svg>', secret: 'SYNTHETIC-TEST-ONLY', uri: 'otpauth://totp/synthetic' } })
    if (url.pathname.endsWith('/challenge')) return json({ id: 'synthetic-challenge', expires_at: Math.floor(Date.now() / 1000) + 300 })
    if (url.pathname.endsWith('/verify')) { verified = true; return json(session()) }
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/')) return json({ Key: 'synthetic.txt' })
    if (url.pathname.startsWith('/storage/v1/object/sign/')) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'Synthetic document only' })
    if (url.pathname.endsWith('/create-quote-upload-url')) return json({ ok: true, uploads: [{ storagePath: original.storage_path, token: 'synthetic-upload-token' }] })
    if (url.pathname.endsWith('/submit-quote')) {
      submissions.push({ type: 'quote', body })
      return json({ ok: true, quoteId: body.quoteId, quoteReference: 'TEST-QUOTE' })
    }
    if (url.pathname.endsWith('/submit-order')) {
      submissions.push({ type: 'order', body })
      return json({ ok: true, orderId: body.orderId, orderReference: 'TEST-ORDER' })
    }
    if (url.pathname.endsWith('/my-requests')) {
      if (!action) return json({ ok: true, requests: records })
      if (action.endsWith('document-url')) return json({ ok: true, signedUrl: backend + '/storage/v1/object/sign/private/synthetic.txt?token=synthetic', expiresIn: 60 })
    }
    if (url.pathname.endsWith('/admin-orders')) {
      if (action === 'status') return json({ ok: true, isAdmin: true, mfaVerified: verified })
      if (action === 'list-discussions') return json({ ok: true, discussions: [], total: 0 })
      if (action === 'list-quotes') return json({ ok: true, quotes: [{ id: 'synthetic-quote', quote_reference: 'TEST-QUOTE', status: 'submitted', supporting_documents: [original] }], total: 1 })
      if (action === 'list') return json({ ok: true, orders: [{ id: 'synthetic-search', order_reference: 'TEST-SEARCH', status: 'submitted', supporting_documents: [original] }], total: 1 })
      if (action === 'list-workspace-documents') return json({ ok: true, documents: [workspace] })
      if (action.endsWith('document-url')) return json({ ok: true, signedUrl: backend + '/storage/v1/object/sign/private/synthetic.txt?token=synthetic', expiresIn: 60 })
    }
    unexpected.push(url.pathname + ':' + action)
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Unexpected synthetic test request"}' })
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(origin + '/customer-liaison/?view=quote')
  await page.getByLabel('Email address').fill('synthetic@example.test')
  await page.getByLabel('Password').fill('synthetic-password')
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await page.locator('[name="name"]').fill('Synthetic Test')
  await page.locator('[name="country"]').fill('Japan')
  await page.locator('[name="searchService"]').selectOption({ index: 1 })
  await page.locator('[name="technicalSubject"]').fill('Synthetic scanner-free CSP test')
  await page.locator('[name="searchObjective"]').fill('Verify browser resource restrictions')
  await page.locator('[name="jurisdictions"]').fill('Japan')
  await page.locator('[name="preferredDeliverable"]').selectOption({ index: 1 })
  await page.locator('#quoteSupportingDocuments').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') })
  await page.locator('[name="acknowledgment"]').check()
  await page.getByRole('button', { name: 'Request Custom Quote', exact: true }).click()
  await page.getByText('Your custom quotation request was submitted for review.').waitFor()
  assert.ok(calls.some((call) => call.startsWith('/storage/v1/object/upload/sign/')))
  console.log('PASS: sign-in, quote submission, and actual SDK signed upload under CSP')

  async function documentOpens(button) {
    const popupPromise = context.waitForEvent('page')
    await button.click()
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    assert.equal(await popup.locator('body').innerText(), 'Synthetic document only')
    await popup.close()
  }
  await page.getByRole('button', { name: 'My Requests', exact: true }).click()
  for (const name of ['Synthetic quote', 'Synthetic search']) {
    const card = page.locator('details.customer-request-card').filter({ hasText: name })
    await card.locator(':scope > summary').click()
    await documentOpens(card.getByRole('button', { name: 'Open', exact: true }).first())
    if (name === 'Synthetic quote') await documentOpens(card.getByRole('button', { name: 'Open', exact: true }).nth(1))
  }
  console.log('PASS: client original order/quote and workspace signed downloads')

  // Exercise every source/destination combination through the real React forms
  // and SDK. All backend traffic is intercepted above; no real requests issue.
  for (const record of records) {
    for (const target of ['quote', 'order']) {
      const myRequestsButton = page.getByRole('button', { name: 'My Requests', exact: true })
      if (await myRequestsButton.isEnabled()) await myRequestsButton.click()
      const entry = page.locator('article.customer-request-entry').filter({ hasText: record.reference })
      const before = submissions.length
      await entry.getByRole('button', { name: target === 'quote' ? 'Quote' : 'Order', exact: true }).click()
      await page.getByText(`Prefilled from My Requests: ${record.reference}`, { exact: true }).waitFor()
      assert.equal(submissions.length, before, 'Reuse must prepare a draft before submission')
      assert.equal(await page.locator('[name="name"]').inputValue(), record.details.clientName)
      assert.equal(await page.locator('[name="technicalSubject"]').inputValue(), record.details.technicalSubject)
      assert.equal(await page.locator('[name="searchObjective"]').inputValue(), record.details.searchObjective)
      assert.equal(await page.locator('[name="acknowledgment"]').isChecked(), false)
      const input = page.locator(target === 'quote' ? '#quoteSupportingDocuments' : '#supportingDocuments')
      assert.equal(await input.evaluate((element) => element.files.length), 0)
      const dateField = target === 'quote' ? 'desiredCompletionDate' : 'requestedCompletionDate'
      assert.equal(await page.locator(`[name="${dateField}"]`).inputValue(), record.type === 'quote' ? '11/20/2026' : record.type === 'search' ? '12/02/2026' : '')
      if (target === 'order') assert.equal(await page.locator('[name="email"]').inputValue(), 'synthetic@example.test')
      await page.locator('[name="acknowledgment"]').check()
      await page.getByRole('button', { name: target === 'quote' ? 'Request Custom Quote' : 'Submit Order Details', exact: true }).click()
      await page.getByText(target === 'quote' ? 'Your custom quotation request was submitted for review.' : 'Your order details were submitted for initial scope review.', { exact: true }).waitFor()
      const submitted = submissions.at(-1)
      assert.equal(submitted.type, target)
      assert.equal(submitted.body.name, record.details.clientName)
      assert.equal(submitted.body.discussionId, record.type === 'discussion' ? record.id : null)
      if (target === 'order') assert.equal(submitted.body.quoteId, record.type === 'quote' ? record.id : null)
      if (target === 'quote') assert.notEqual(submitted.body.quoteId, record.id)
      else assert.notEqual(submitted.body.orderId, record.id)
      assert.ok((submitted.body.additionalInformation || submitted.body.additionalInstructions).includes(record.reference))
      assert.deepEqual(submitted.body.supportingDocuments, [])
    }
  }

  await page.getByRole('button', { name: 'My Requests', exact: true }).click()
  await page.locator('article.customer-request-entry').filter({ hasText: 'TEST-search' }).getByRole('button', { name: 'Order', exact: true }).click()
  await page.locator('#supportingDocuments').setInputFiles({ name: 'unrelated-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') })
  await page.locator('[name="acknowledgment"]').check()
  await page.getByRole('button', { name: 'My Requests', exact: true }).click()
  await page.locator('article.customer-request-entry').filter({ hasText: 'TEST-discussion' }).getByRole('button', { name: 'Order', exact: true }).click()
  assert.equal(await page.locator('[name="billingOrganization"]').inputValue(), '')
  assert.equal(await page.locator('[name="acknowledgment"]').isChecked(), false)
  assert.equal(await page.locator('#supportingDocuments').evaluate((element) => element.files.length), 0)

  await page.getByRole('button', { name: 'My Requests', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const entry = page.locator('article.customer-request-entry').filter({ hasText: 'TEST-quote' })
  await entry.getByRole('button', { name: 'Quote', exact: true }).waitFor({ state: 'visible' })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile reuse buttons must not overflow the page')
  await entry.locator('details > summary').first().click()
  await entry.getByRole('button', { name: 'Request a Search', exact: true }).click()
  await page.getByText('Prefilled from My Requests: TEST-quote', { exact: true }).waitFor()
  assert.equal(await page.locator('[name="name"]').inputValue(), 'Client quote')
  await page.setViewportSize({ width: 1280, height: 720 })
  console.log('PASS: all six My Requests quote/order submissions, source links, new IDs, fresh consent/files, stale draft reset, mobile layout, and Next Action reuse')

  await page.getByRole('button', { name: 'Administrator', exact: true }).click()
  await page.getByRole('button', { name: 'Set up authenticator' }).click()
  const qr = page.locator('.admin-mfa-qr')
  await qr.waitFor()
  assert.ok(await qr.evaluate((image) => image.complete && image.naturalWidth > 0))
  await page.getByLabel('Six-digit authenticator code').fill('123456')
  await page.getByRole('button', { name: 'Verify and open Administrator' }).click()
  await page.getByRole('heading', { name: 'Administrator', exact: true }).waitFor()
  for (const tab of ['Quote Requests', 'Search Requests']) {
    await page.getByRole('button', { name: new RegExp('^' + tab + ' \\(') }).click()
    const card = page.locator('details.admin-order').first()
    await card.locator(':scope > summary').click()
    await documentOpens(card.getByRole('button', { name: 'Open Document', exact: true }).first())
    if (tab === 'Quote Requests') {
      await card.getByRole('button', { name: 'Load Documents', exact: true }).click()
      await documentOpens(card.locator('.admin-workspace-documents').getByRole('button', { name: 'Open Document', exact: true }))
    }
  }
  assert.deepEqual(await page.evaluate(() => window.cspViolations), [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(unexpected, [])
  assert.ok(await page.locator('.form-card').evaluate((element) => getComputedStyle(element).borderRadius !== '0px'))
  console.log('PASS: authenticator QR image, MFA verification, administrator downloads, and stylesheet; no CSP violations')

  const blocked = await page.evaluate(async () => {
    const script = document.createElement('script')
    script.textContent = 'window.injectedInlineRan = true'
    document.head.appendChild(script)
    const remote = document.createElement('script')
    remote.src = 'https://blocked.invalid/test.js'
    document.head.appendChild(remote)
    const dataScript = document.createElement('script')
    dataScript.src = 'data:text/javascript,window.injectedDataRan=true'
    document.head.appendChild(dataScript)
    const image = document.createElement('img')
    image.src = 'https://blocked.invalid/image.png'
    document.body.appendChild(image)
    const style = document.createElement('style')
    style.textContent = 'body { display:none !important }'
    document.head.appendChild(style)
    const frame = document.createElement('iframe')
    frame.src = 'https://blocked.invalid/frame'
    document.body.appendChild(frame)
    const handler = document.createElement('img')
    handler.setAttribute('onerror', 'window.injectedHandlerRan=true')
    handler.src = 'data:image/png,invalid'
    document.body.appendChild(handler)
    const styled = document.createElement('div')
    styled.setAttribute('style', 'display:none')
    document.body.appendChild(styled)
    const originalBase = document.baseURI
    const base = document.createElement('base')
    base.href = 'https://blocked.invalid/'
    document.head.appendChild(base)
    const form = document.createElement('form')
    form.action = 'https://blocked.invalid/form'
    form.target = '_blank'
    document.body.appendChild(form)
    form.submit()
    const probe = document.createElement('script')
    probe.src = '/customer-liaison/csp-eval-probe.js'
    await new Promise((done, reject) => { probe.onload = done; probe.onerror = reject; document.head.appendChild(probe) })
    let connectionBlocked = false
    try { await fetch('https://blocked.invalid/data') } catch { connectionBlocked = true }
    await new Promise((done) => setTimeout(done, 100))
    return { inlineRan: !!window.injectedInlineRan, dataRan: !!window.injectedDataRan, handlerRan: !!window.injectedHandlerRan,
      styleApplied: getComputedStyle(styled).display === 'none', baseChanged: document.baseURI !== originalBase,
      evaluationBlocked: window.cspEvalBlocked, connectionBlocked, violations: window.cspViolations }
  })
  assert.equal(blocked.inlineRan, false)
  assert.equal(blocked.dataRan, false)
  assert.equal(blocked.handlerRan, false)
  assert.equal(blocked.styleApplied, false)
  assert.equal(blocked.baseChanged, false)
  assert.equal(blocked.evaluationBlocked, true)
  assert.equal(blocked.connectionBlocked, true)
  for (const directive of ['script-src-elem', 'script-src-attr', 'script-src', 'img-src', 'style-src-elem', 'style-src-attr', 'frame-src', 'connect-src', 'base-uri', 'form-action']) assert.ok(blocked.violations.includes(directive), directive)
  assert.deepEqual(unexpected, [], 'Disallowed requests must never reach the network')
  console.log('PASS: inline/data/external scripts, event handlers, eval, external images, inline styles, frames, external connections, base changes, and external form submissions blocked')
} finally {
  if (browser) await browser.close()
  await new Promise((done) => server.close(done))
}
