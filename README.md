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
   `https://toptierpatentsearch.github.io/search-order-form/`
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

