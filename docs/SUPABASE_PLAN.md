# Supabase implementation plan

The implementation is incremental. The static UI and localStorage demo stay in place while one authenticated daily-operations path is proven end to end.

## Phase 1 — implemented in this checkout

- `supabase/migrations/001_initial_schema.sql` creates the multi-organisation relational model, constraints, indexes, Auth profile trigger, daily snapshot function, and RLS policies.
- `supabase/config.js` contains only public browser configuration placeholders.
- `index.html` loads Supabase JS v2 from a CDN when configured, uses Supabase Auth, loads the signed-in profile/role and accessible venues, manages organisation members, venue memberships, today's roster, recurring Opening/Closing Shift templates, and today's operation/task changes.
- The existing demo is selected automatically while the public config contains placeholders.

The first manager must still be created in the Supabase dashboard and assigned to an organisation and venue using the setup instructions in `README.md`. If the venue has no recurring templates, the manager's first app load performs the documented one-time local-template bootstrap.

## Phase 2 — next adapters

Replace the remaining phase 2 placeholder screens with repository-style functions for:

- historical reporting and CSV export
- notification event inbox

Employee Auth-user creation and initial organisation membership bootstrap remain manual in the MVP. The browser must not use Supabase Auth admin APIs or a service-role key.

## Phase 3 — realtime and notifications

- Subscribe to `template_tasks`, `daily_tasks`, and legacy `daily_checklists` instance changes for the selected venue/date.
- Move notification composition and delivery to Edge Functions.
- Run cutoff/end-of-day summaries as scheduled server-side work so they do not depend on an open browser.

## Secrets

The frontend may contain only the Supabase project URL and publishable/anon key. Provider secrets and Supabase service-role credentials belong in Edge Function or Supabase project secrets and must never be committed to this repository.
