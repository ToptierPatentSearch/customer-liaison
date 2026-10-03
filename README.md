# Top-tier Patent Search — Section 4 Order Details

A React/Vite implementation of Section 4, **Provide Your Order Details**, for the Place an Order workflow.

## Included

- Client Information
- Assignment Information
- Optional supporting-document upload
- Scope-review acknowledgment
- Requested completion date displayed as `Month/Day/Year`
- Supabase Database submission
- Private Supabase Storage bucket for attachments
- Responsive, conservative B2B styling
- A generated order reference after successful submission

## 1. Install

```bash
npm install
```

## 2. Configure Supabase

The project URL is already placed in `.env.example`:

```text
https://syshvcymwktnkrkrvwtk.supabase.co
```

Copy the example file:

```bash
cp .env.example .env.local
```

Then obtain the project's **Publishable key** from the Supabase Dashboard **Connect** panel and set:

```text
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

Do not put the `service_role` key or any secret server key in a Vite/browser environment variable.

## 3. Create the database table and Storage bucket

Open the Supabase SQL Editor for the project and run:

```text
supabase/schema.sql
```

The SQL creates:

- `public.order_requests`
- RLS permitting anonymous **INSERT only**
- private bucket `order-supporting-documents`
- an anonymous upload-only Storage policy

## 4. Run locally

```bash
npm run dev
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`).

## 5. Build

```bash
npm run build
```

The deployable output will be in `dist/`.

## Important production hardening

This browser-only version is suitable as a functional baseline, but a public form can be spammed because the publishable key is intentionally browser-visible. Before a production launch, route submission and document uploads through a Supabase Edge Function and add bot protection such as Cloudflare Turnstile. The Edge Function can validate payloads, apply rate limits, and perform the database/storage writes using server-side credentials.

Because submitted technical information may be confidential, keep the Storage bucket private and provide staff access only through authenticated/admin workflows or signed URLs generated server-side.


## 6. Enable Supabase Auth

This app now requires a Supabase Auth account before the order form is displayed.

In the Supabase Dashboard for project `syshvcymwktnkrkrvwtk`:

1. Open **Authentication > Providers > Email** and keep Email authentication enabled.
2. Under **Authentication > URL Configuration**, add this redirect URL:
   `https://toptierpatentsearch.github.io/customer-liaison/`
3. Apply `supabase/auth-migration.sql` once to the existing project.
4. Deploy both Edge Functions again:
   - `create-upload-url`
   - `submit-order`

The Edge Functions use `withSupabase({ auth: 'user' })`, so a valid signed-in user JWT is required. The order row stores the authenticated user ID, and the email recorded for the order is taken from the authenticated account rather than trusting an editable request field.

For a fresh Supabase project, use the updated `supabase/schema.sql` instead of the migration file.


## 7. Administrator Orders Dashboard

The app includes an administrator-only order dashboard. Authorization is enforced by the `admin-orders` Edge Function, not only by the React UI.

### Apply the administrator migration

For the existing Supabase project, run:

```text
supabase/admin-dashboard-migration.sql
```

This creates `public.admin_users`, a private allowlist that ordinary authenticated users cannot read or modify.

### Assign an administrator

The administrator must first have a Supabase Auth account. Then run the following in the Supabase SQL Editor, replacing the placeholder with the administrator's actual sign-in email:

```sql
insert into public.admin_users (user_id)
select id
from auth.users
where lower(email) = lower('ADMIN_EMAIL_HERE')
on conflict (user_id) do nothing;
```

### Deploy the administrator Edge Function

Deploy:

```text
supabase/functions/admin-orders/index.ts
```

as the Edge Function named:

```text
admin-orders
```

### Use the dashboard

After an allowlisted administrator signs in, the order-form account bar displays an **Administrator** button. Selecting it opens the administrator Orders page.

The page provides:
- all order records, loaded in pages from newest to oldest
- search across references, clients, email, services, subjects, objectives, and related fields
- full order details
- secure, short-lived signed links for supporting documents
- no administrator navigation or order data for ordinary users

A direct request to the administrator Edge Function from a non-administrator receives a 403 response for order-list or document access.

## 8. Discuss a Project with the same authenticated account

The client workspace now provides two authenticated workflows under the same Supabase Auth session:

- **Discuss a Project** — a shorter scope-clarification form for prospects who are not yet ready to submit full search instructions.
- **Request a Search** — the existing detailed order/search-request form.

A signed-in prospect can switch between the two workflows without signing in again.

### Apply the existing-project migration

Run:

```text
supabase/discuss-project-migration.sql
```

in the Supabase SQL Editor before deploying the updated frontend. The migration creates:

- `public.project_discussions`
- indexes for discussion lookup
- RLS/revocations so browser clients cannot read or write the table directly
- `order_requests.discussion_id` for linking a formal search request to its originating discussion

For a brand-new Supabase project, the current `supabase/schema.sql` includes the same structure.

### Deploy the discussion Edge Function

Deploy:

```text
supabase/functions/submit-discussion/index.ts
```

as:

```text
submit-discussion
```

The function requires an authenticated Supabase user and derives `user_id` and email from the authenticated claims.

### Redeploy changed existing Edge Functions

Because this feature also extends the existing server-side behavior, redeploy:

- `submit-order` — verifies and stores the optional originating discussion ID.
- `admin-orders` — adds the administrator-only discussion list.

### Administrator workspace

The administrator page now has two tabs:

- **Discussions**
- **Search Requests**

The existing administrator allowlist remains the authorization source. Discussion records and order records are still unavailable directly to ordinary authenticated browser clients.

### Discussion-to-request handoff

After a successful discussion submission, the client can choose **Continue to Request a Search**. The application carries the project type (when it maps to a supported service), technical description, objective, known patent documents, timing/context, and the discussion ID into the detailed search-request workflow. The `submit-order` Edge Function confirms that the originating discussion belongs to the same authenticated account before creating the linked order.



## 9. Request a Custom Quote

The authenticated client workspace now provides three related workflows:

- **Discuss a Project** — clarify scope when the appropriate service or deliverable is not yet settled.
- **Request a Custom Quote** — provide enough scope information to estimate timing, deliverables, and professional fee.
- **Request a Search** — submit detailed instructions for a formal search request.

A discussion can be carried into a quotation request, and a quotation request can be carried into a Search Request without re-entering the core project information.

### Apply the quote migration

For the existing Supabase project, run:

```text
supabase/quote-request-migration.sql
```

The migration creates:

- `public.quote_requests`
- a private `quote-supporting-documents` Storage bucket
- `order_requests.quote_id` for linking a formal Search Request to its originating quotation request
- indexes and RLS/revocations consistent with the existing server-side security model

For a fresh Supabase project, the current `supabase/schema.sql` includes the same structure.

### Deploy the quote Edge Functions

Deploy:

```text
supabase/functions/create-quote-upload-url/index.ts
supabase/functions/submit-quote/index.ts
```

as the Edge Functions:

```text
create-quote-upload-url
submit-quote
```

Also redeploy these changed existing functions:

```text
submit-order
admin-orders
```

### Administrator workspace

The administrator dashboard now has three tabs:

- **Discussions**
- **Quote Requests**
- **Search Requests**

Quote supporting documents are opened through short-lived signed URLs generated only after administrator authorization.

### Quote-to-search handoff

After a quotation request is successfully submitted, the client can select **Continue to Request a Search**. The application carries relevant quote data into the Search Request and stores the originating quote ID. When the Search Request is accepted by the backend, the quotation request status is updated to `converted`.


## 10. Threaded Request Conversations

Customer Liaison supports stored conversations for all three authenticated request types:

- **Discuss a Project**
- **Request a Custom Quote**
- **Request a Search**

Administrators can send replies from the administrator workspace, and signed-in clients can read and answer those messages from **My Requests**.

### Existing Supabase projects

Before deploying the conversation-enabled Edge Functions to an existing project, run:

```text
supabase/request-replies-migration.sql
```

The migration creates `public.request_replies`, enables RLS, revokes direct browser access, grants server-side access to `service_role`, and creates the conversation and administrator-draft indexes.

### Fresh Supabase projects

For a new project, run the current:

```text
supabase/schema.sql
```

The canonical schema includes `public.request_replies`, so the standalone request-replies migration is not required for a fresh installation.

### Deploy the conversation-enabled Edge Functions

After the database table exists, deploy or redeploy:

```text
supabase/functions/admin-orders/index.ts
supabase/functions/my-requests/index.ts
```

as:

```text
admin-orders
my-requests
```

Deploy the database change before these Edge Functions. Otherwise the functions can fail when they query `request_replies`.

Administrator drafts are private to the administrator who created them. Sent messages remain visible to the conversation participants, while drafts are never returned to clients.

## 11. Status Change Indication

**My Requests** distinguishes a request's current status from ordinary request activity and clearly shows when the status has changed since the client last opened that request.

### Existing Supabase projects

Run:

```text
supabase/status-change-indication-migration.sql
```

The migration adds:

- `status_updated_at` and `status_version` to discussions, quote requests, and search requests
- `public.request_status_history` for an auditable status timeline
- `public.request_status_views` for each client's last-seen status version
- database triggers that update the status timestamp/version and append history whenever a status changes

The status tables are not exposed directly to browser clients. RLS remains enabled, browser-role access is revoked, and the authenticated `my-requests` Edge Function returns only records belonging to the signed-in client.

### Redeploy the client request function

After the migration, redeploy:

```text
supabase/functions/my-requests/index.ts
```

as the Edge Function:

```text
my-requests
```

The administrator status workflow does not need a separate status-tracking API call: database triggers centralize the tracking whenever the administrator changes a request status.

### Client behavior

In **My Requests**:

- every current status uses both a text label and a color indicator
- a status change receives a temporary **NEW UPDATE** badge and highlighted request card
- **Status changed** is shown separately from **Last activity**
- opening an updated request marks that status version as seen and removes the temporary update indication
- the request details include a reverse-chronological **Status history** timeline

For a new Supabase project, the current `supabase/schema.sql` includes the same status-change structures and triggers.



## 12. My Requests Client Workspace

**My Requests** now acts as a secure post-submission client workspace for project discussions, quotation requests, and search requests.

### Client functions

Signed-in clients can:

- distinguish **NEW STATUS** from **NEW MESSAGE**
- filter by All, Action Required, Active, or Completed and search by request information
- review a context-sensitive **Next Action**
- open the complete original submission as a read-only historical record
- securely open original supporting documents
- add further supporting documents after submission
- receive and securely open quotations, reports, and other documents published by Top-tier Patent Search
- submit an amendment request without overwriting the original instructions
- accept or decline a quotation when its status is **Quote Sent**
- continue to use the existing request conversation and status-history timeline

Opening a request acknowledges only the status version and administrator message IDs actually rendered by that client view. A newer update arriving concurrently is therefore not cleared accidentally.

### Private document workspace

The post-submission workspace uses:

```text
public.request_documents
request-workspace-documents
```

The bucket remains private. Clients and administrators request short-lived signed upload/download URLs through authenticated Edge Functions; browser roles do not receive direct table access to `public.request_documents`.

For an existing Supabase project, apply:

```text
supabase/my-requests-workspace-migration.sql
```

For a fresh project, the current canonical `supabase/schema.sql` includes the same structures.

After the database migration is present, deploy or redeploy:

```text
supabase/functions/my-requests/index.ts
supabase/functions/admin-orders/index.ts
```

as:

```text
my-requests
admin-orders
```

Deploy the database change before the Edge Functions because both functions query `public.request_documents`.

### Administrator document publishing

The administrator workspace can load documents added after submission and publish a document to the client as one of:

- Deliverable
- Quotation
- Report
- Other

Publishing a document also creates an administrator conversation message, which appears to the client as **NEW MESSAGE** until that exact message is opened.

### Deferred integrations

Transactional email notification, invoicing/payment status, and richer milestone scheduling remain separate integrations because they require external delivery/billing configuration or a broader project-scheduling data model. The in-app workflow does not depend on those integrations.

## 13. Administrator authenticator verification

Opening **Administrator** requires a verified TOTP session. First-time administrators choose **Set up authenticator**, scan the QR code (or enter the setup key), and verify the six-digit code. Returning administrators use their existing authenticator after password sign-in. Ordinary client workflows do not require MFA.

The `admin-orders` function uses both `admin_users` membership and the authenticated JWT's top-level `aal === 'aal2'` claim. All record, reply, status, upload, and download actions require both checks. The `status` action exposes only the caller's own administrator membership and MFA status at AAL1 so enrollment can be reached; it returns no client records. Body fields and user metadata cannot satisfy the MFA check.

### Deployment order

1. Deploy the frontend with this MFA screen first. It supports the previous `admin-orders` status response. The frontend gate alone does not protect the API; complete the backend step below.
2. Each administrator signs in, opens **Administrator**, registers their authenticator, and saves their authenticator app's backup/recovery access securely. Test signing out and back in, entering a wrong code, then a valid code. Confirm all administrator panels and original and workspace document downloads work.
3. Deploy `supabase/functions/admin-orders/index.ts` as `admin-orders`, retaining the existing authenticated `withSupabase({ auth: 'user' })` wrapper. Keep the project's existing gateway/signing-key configuration; this change does not depend on switching the legacy JWT gateway setting.
4. With a fresh administrator password-only session, directly call a protected action and confirm HTTP 403 with `ADMIN_MFA_REQUIRED`. Complete MFA and repeat: it should succeed. Check that a nonadministrator remains denied even after MFA and that normal client submissions/uploads still work.

No schema migration is required. `npm test` covers every protected administrator action at AAL1, forged/missing claims, AAL2 membership checks, and enrollment/verification failures. `npm run build` compiles the frontend. The physical authenticator, live sign-in, and recovery checks require the administrator and must be completed during rollout.

### Lost authenticator recovery

Use the authenticator application's backup first. If unavailable, the Supabase project owner must verify the administrator's identity through an established channel, confirm the correct Auth user and lost factor ID, and remove that factor through a trusted server or owner console using `supabase.auth.admin.mfa.deleteFactor({ userId, id: factorId })`. Removing a verified factor signs out its active sessions. Keep the service role key entirely outside this frontend and repository. A password reset alone does not remove the factor.

After the reset, sign in again, enroll a replacement authenticator, and complete verification before reopening administrator records. Leave the server AAL2 requirement in place throughout recovery. Test this procedure with a dedicated test administrator before relying on it for the production account. The application offers no MFA bypass or reset button at AAL1.

Canceled or interrupted setup creates no verified factor. The next explicit setup attempt removes only unfinished factors bearing this application's name. The QR code and setup key are held only in component memory and are not written to logs or storage.

Reference: [Supabase TOTP guide](https://supabase.com/docs/guides/auth/auth-mfa/totp), [MFA verification](https://supabase.com/docs/reference/javascript/auth-mfa-verify), [owner factor reset](https://supabase.com/docs/reference/javascript/auth-admin-deletefactor).

## 14. Server-side application rate limits

All seven authenticated Edge Functions use shared, atomic PostgreSQL counters through `consume_app_rate_limit`. Limits follow the signed-in account across browser sessions and function instances. No additional Redis account, external credentials, or production npm dependency is needed.

| Operation | Per-account limit | Shared scope |
| --- | --- | --- |
| Discussion submission attempts | 5/hour | `submit-discussion` |
| Quote submission attempts | 5/hour | `submit-quote` |
| Search submission attempts | 5/hour | `submit-order` |
| Client upload authorization batches | 20/hour | Order, quote, and workspace uploads combined; existing 8-file/batch and 10-MB/file restrictions still apply |
| Client message-producing actions | 30/hour | Replies, amendments, quote decisions, and document-registration notifications combined |
| Administrator operations | 120/hour | All protected reads, replies, status changes, uploads, and signed document links combined |
| Own administrator-membership status | 120/hour | Separate from protected administrator operations; available before MFA |
| Authenticated permission denials | 10/15 minutes | HTTP 403 responses across the application; subsequent denials return 429 |
| Authenticated API burst | 120/minute | All seven functions combined, including malformed requests |

These are fixed UTC time windows, not rolling windows. A boundary can admit up to two windows' quota in a short interval. Each action has only one counter row per account, replaced when its window expires. Rejected calls do not increase the counter or postpone the reset time. Submission and mutation attempts can consume quota even when later validation fails; changing a browser-provided user ID cannot change the quota identity. Unknown actions do not create new policy names.

HTTP 429 includes `code: RATE_LIMITED`, a numeric `retryAfter` in seconds, and `Retry-After`. The frontend displays the server's wait message and preserves entered form data. It does not automatically retry submissions or document registration. A missing/malformed quota response or database outage returns HTTP 503 with `RATE_LIMIT_UNAVAILABLE`; it does not permit unrestricted operations. Membership, ownership, and administrator AAL2 checks remain required.

### Deployment and verification

1. Apply `supabase/migrations/20261003004546_customer_liaison_rate_limits.sql` before deploying the functions. The fresh-project `supabase/schema.sql` includes the same SQL. Counter access and RPC execution belong exclusively to `service_role`; no browser policies or grants are required.
2. Deploy the frontend error-message support and all seven functions: `submit-discussion`, `submit-quote`, `submit-order`, `create-upload-url`, `create-quote-upload-url`, `my-requests`, and `admin-orders`. Include `supabase/functions/_shared/rate-limit.ts` in every function's deployment bundle. Preserve each function's existing gateway JWT setting and authenticated wrapper.
3. Verify a normal client submission, reply, and original/workspace upload, and a verified administrator view/document download. Use a dedicated test account for quota-exhaustion smoke tests: the sixth submission attempt should return 429 with a retry interval; another account must remain unaffected. Existing accounts are not automatically signed out by this update.
4. During regular maintenance, remove expired counters with `delete from public.app_rate_limits where window_started_at < now() - interval '7 days';`. This table contains only account IDs, policy names, window timestamps, and counts. Do not log client messages, filenames, or invention descriptions for quota monitoring.

`npm test` exercises the actual migration in embedded PostgreSQL (PGlite, a pinned development-only dependency), SQL quotas/reset/privileges, endpoint admission before privileged work, MFA/ownership regression tests, and frontend quota messages. The GitHub validation workflow type-checks all seven deployed functions.

Supabase Auth sign-in/email limits and gateway rejection of invalid tokens remain separate. This change does not implement a network firewall or IP throttling for requests rejected before user authentication. It uses verified account identity and deliberately does not trust caller-supplied IP/user headers. Turnstile enrollment protection in Section 5 is still needed to reduce abuse through large numbers of accounts.

## 15. Database least-privilege access

Apply `supabase/migrations/20261003021321_customer_liaison_database_privileges.sql` after the existing schema and rate-limit migration. The fresh-project `supabase/schema.sql` includes the same SQL. No frontend or Edge Function redeployment is required for this permissions-only update.

The migration removes **all** table privileges from `PUBLIC`, `anon`, and `authenticated` on `order_requests`, `project_discussions`, `quote_requests`, `admin_users`, `request_replies`, `request_status_history`, `request_status_views`, `request_documents`, and `app_rate_limits`. Earlier request-table migrations removed only SELECT/INSERT/UPDATE/DELETE, leaving unnecessary TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN permissions. Column grants were also checked before applying this migration; the live application had none.

Authenticated Edge Functions continue to validate account ownership, administrator membership, and MFA before using their server-side admin client. Explicit SELECT/INSERT/UPDATE/DELETE grants preserve server access even when Supabase stops granting automatic privileges to new tables. Existing service-role permissions remain intact. RLS remains enabled, and no browser access policies are added. An "RLS Enabled No Policy" informational notice is expected for tables that intentionally deny all browser access; do not add permissive policies merely to remove it.

The optional `project_maintenance` table and its ID sequence receive the same browser restrictions when present. SQL Editor/database-owner maintenance and server operations continue to work. `auth`, `storage`, and their policies/grants are not changed, so signed document uploads and downloads retain their existing access model.

Future `public` tables and sequences created by `postgres` no longer automatically grant privileges to browser roles. This default change affects future objects only and is scoped to that creator and schema; review grants explicitly if another role creates objects. For each new server-only table, enable RLS and explicitly grant the service role only the access needed by its functions. Changing default privileges does not itself enable RLS on future tables. Avoid blanket browser grants or disabling the Data API: the Edge Functions still use it through the server client.

`npm test` executes the actual permissions migration in PostgreSQL and verifies browser operation rejection, server CRUD and sequence access, future object defaults, optional maintenance objects, idempotent application, and preservation of unrelated schema access. After applying it, verify effective grants with `has_table_privilege`, `has_column_privilege`, and `has_sequence_privilege`, and test harmless queries with `SET LOCAL ROLE anon`, `authenticated`, and `service_role` inside a rolled-back transaction.

Reference: [Supabase API security and explicit grants](https://supabase.com/docs/guides/api/securing-your-api).

## 16. Private malware scanning before document downloads

Section 8 is prepared in this revision and requires a running private scanner before activation. Follow [the private scanner setup and rollout instructions](security/document-scanner/README.md). Do not deploy the changed `admin-orders` and `my-requests` functions before configuring and testing the scanner: missing configuration intentionally denies downloads.

All six original order/quote and workspace download actions authorize the caller before sending document bytes to the privately hosted scanner. Only a clean result matching the SHA-256 digest and byte length, a supported engine, and current definitions can issue a 60-second signed link. Malware, encrypted documents, Office macros, and scanning limits block downloads. Failures and stale signatures return a readable temporary-unavailability message. Existing private files are checked on their next download; no database migration or manual clean-status assignment is required.

Keep uploaded objects immutable: use new unique paths and `upsert: false` for replacements, and retain the absence of browser Storage UPDATE/DELETE privileges. This requirement also applies to privileged dashboard/service-role operations. Files stay private in Storage, and this integration submits no documents to public scanning services. Scanner hosting, its server-only secrets, and the commissioning tests must be completed before declaring Section 8 active.
