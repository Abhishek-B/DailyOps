# Supabase implementation plan

The implementation is incremental. The static UI and localStorage demo stay in place while one authenticated daily-operations path is proven end to end.

## Phase 1 — implemented in this checkout

- `supabase/migrations/001_initial_schema.sql` creates the multi-organisation relational model, constraints, indexes, Auth profile trigger, daily snapshot function, and RLS policies.
- `supabase/config.js` contains only public browser configuration placeholders.
- `index.html` loads Supabase JS v2 from a CDN when configured, uses Supabase Auth, loads the signed-in profile/role and accessible venues, supports active platform-admin access across organisations, manages organisation-wide team visibility, venue memberships, seven-day cross-venue roster planning, employee weekly roster views, recurring Opening/Closing Shift templates, today's operation/task changes, and in-app shift-cover requests.
- Migrations `002` through `009` record additive role/helper and team-access changes; migration `010` adds the RLS-scoped in-app cover-request table. Cover email/SMS delivery remains a future Edge Function concern.
- The existing demo is selected automatically while the public config contains placeholders.

The first manager must still be created in the Supabase dashboard and assigned to an organisation and venue using the setup instructions in `README.md`. If the venue has no recurring templates, the manager's first app load performs the documented one-time local-template bootstrap.

## Phase 2 — next adapters

Replace the remaining phase 2 placeholder screens with repository-style functions for:

- historical reporting and CSV export
- the older notification event inbox and delivery path

Employee Auth-user creation and initial organisation membership bootstrap remain manual in the MVP. Email-based assignment of an existing Auth user to an organisation is also intentionally deferred. Add it later through a manager-scoped Edge Function or narrowly scoped SECURITY DEFINER RPC; the browser must not use Supabase Auth admin APIs or a service-role key.

## Phase 3 — realtime and notifications

- Subscribe to `template_tasks`, `daily_tasks`, and legacy `daily_checklists` instance changes for the selected venue/date.
- Move notification composition and delivery to Edge Functions.
- Run cutoff/end-of-day summaries as scheduled server-side work so they do not depend on an open browser.

## Secrets

The frontend may contain only the Supabase project URL and publishable/anon key. Provider secrets and Supabase service-role credentials belong in Edge Function or Supabase project secrets and must never be committed to this repository.
