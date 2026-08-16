# DailyOps Starter v2

DailyOps is a framework-free, multi-venue daily-operations app for opening and closing shifts. It remains a single static `index.html` suitable for GitHub Pages.

## Project status

[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) is the canonical reference for the current architecture, migration state, product terminology, roadmap, and technical debt. Update it when those project-level decisions change.

## Current phase

Supabase currently supplies authentication, organisation/venue identity, team membership, today's roster, and today's live shift-operation instances:

- email/password sign-in and sign-out;
- persisted sessions across browser refreshes;
- the signed-in user's `public.profiles` row;
- the user's organisation memberships and organisation names;
- the venues returned by the deployed RLS policies;
- organisation members, profiles, active state, and organisation role;
- employee venue memberships and today's Opening/Closing Shift roster assignments;
- the selected venue's recurring Opening/Closing Shift templates and routine tasks; and
- today's `public.daily_checklists` Opening/Closing Shift rows and `public.daily_tasks` routine/one-off tasks, status, completion attribution/timestamps, notes, and incomplete reasons.

History, CSV export, and simulated notifications remain localStorage-backed. Production defaults to Supabase mode. The original demo can be enabled explicitly with `DEMO_MODE: true`.

## Supabase frontend auth setup

### Configuration

The public browser configuration is in [`supabase/config.js`](supabase/config.js):

```js
window.DAILYOPS_SUPABASE_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...',
  DEMO_MODE: false
};
```

Paste the project URL and publishable key from **Supabase > Project Settings > API** into that file. In this checkout, the values are already configured for the DailyOps project. Set `DEMO_MODE` to `true` only when you explicitly want the localStorage demo and fake user switcher.

The URL and publishable key are public browser credentials. They identify the Supabase project; database access is still controlled by RLS. Never put a `service_role` key, secret key, database password, Edge Function secret, or other privileged credential in `supabase/config.js`, `index.html`, or GitHub Pages.

### Supabase Auth settings

In the Supabase dashboard:

1. Enable the **Email** provider under **Authentication > Providers**.
2. For local testing, either disable email confirmation or confirm the test user's email.
3. Under **Authentication > URL Configuration**, allow the local URL used by Live Server, such as `http://127.0.0.1:5500`, and the production URL below.

The app loads the authenticated user's profile with a query constrained to `profiles.id = auth.users.id`, then loads organisation memberships, organisation names, and RLS-filtered venues. Today's shift-operation/task data is loaded only after that identity step succeeds.

## Supabase organisation and venue loading

After authentication, the app reads the signed-in user's rows from `public.organisation_members` and loads the related `public.organisations` rows. The `organisation_members.role` value (`manager` or `employee`) determines the manager or employee UI for the selected venue. `platform_role` is a separate platform-level field and is not used for this decision.

The app then queries `public.venues`. RLS is the access boundary: managers receive venues in organisations they manage, while employees receive only venues allowed by the deployed membership policies. The venue switcher uses the real venue name, subtitle, accent, cutoff time, and notification settings. The selected real venue ID is remembered in a user-specific local preference and is restored only if the user still has access.

Team and roster data now load from Supabase. Managers see members in their organisation, manage employee profile active state and `venue_members` access, and assign active employees to today's Opening/Closing Shift through `roster_assignments`. Employees load only their permitted venues and can use the existing secure self-cover action. History, notifications, and related demo screens remain local/deferred. Real venue rows are still mapped to temporary local operations contexts only for those deferred screens, so real Supabase IDs do not overwrite or get persisted into the old demo state.

## Supabase team, venue memberships, and roster

`auth.users` is the login identity, `profiles` is the app profile, `organisation_members` supplies the `manager`/`employee` organisation role, `venue_members` grants employee venue access, and `roster_assignments` records a user assigned to a venue/date/shift. RLS enforces these boundaries; the UI is not the security boundary.

The browser does not create Auth users. For this MVP, create an employee under **Supabase → Authentication → Users**, then run the organisation-membership insert shown by the Team screen (or use the SQL Editor) with that Auth user's UUID. The Auth trigger creates `profiles`; after the membership exists, the manager can refresh the Team screen, assign venues, enable/disable access, and roster the employee. Role changes remain an administrator/manual operation in this pass, and `platform_role` is never edited by the Team UI.

Migrations `supabase/migrations/006_restrict_venue_member_reads.sql`, `007_scope_team_and_roster_writes.sql`, and `008_grant_can_manage_profile_execute.sql` narrow employee membership reads, scope manager-created venue memberships/roster assignments to active employees with access to the target venue, and enable manager profile active-state updates. Apply them after migrations `001` through `005`.

## Supabase recurring shift templates

In Supabase mode, managers load and manage `public.checklist_templates` and `public.template_tasks` for the selected venue. The deployed RLS policies allow managers to insert, update, reorder, and delete only templates/tasks belonging to venues they manage; employees can read templates where their venue access permits it but do not receive template-management controls.

If a manager opens a venue with no remote Opening or Closing template yet, the browser performs a one-time compatibility bootstrap from that venue's existing local/demo routine definitions. It creates the missing remote template rows and tasks without overwriting existing remote templates. After that, Supabase is the source of truth. Template changes affect future daily operations; today's task rows remain snapshots. “Apply to today” adds missing tasks by stable `template_task_id`, preserves task state and one-off tasks, and does not delete existing daily tasks.

## Supabase today's operation loading

For each accessible real venue, the app loads today's `public.daily_checklists` rows for `list_type = open` and `list_type = close`, representing the Opening and Closing Shifts, then loads their `public.daily_tasks`. When a manager opens a date with missing rows, the existing `ensure_daily_checklists(uuid, date)` SECURITY DEFINER helper creates the missing instances and copies the current Supabase template tasks as snapshots. Repeated page loads are idempotent because of the database unique key `(venue_id, work_date, list_type)`. Employees cannot bootstrap missing rows; RLS remains the boundary and they see an explicit initialisation message.

Task changes use the schema's existing `pending`, `done`, `blocked`, `na`, and `skipped` values. Completion writes `completed_by` and `completed_at`; reopening clears those fields. Notes, reasons, and shift submission metadata are written to Supabase. Managers can add and remove `source = adhoc` one-off tasks, while routine tasks remain non-deletable. Re-apply routine tasks reads the Supabase template, adds only missing routine snapshots, and preserves existing state and one-off tasks. Notifications and history remain deferred or local/demo.

Before testing one-off deletion, apply `supabase/migrations/005_allow_managers_delete_adhoc_daily_tasks.sql` in the Supabase SQL Editor. It adds only a manager-scoped delete policy for `source = 'adhoc'` daily tasks.

### Create the first manager account

Create an email/password user under **Authentication > Users**. The deployed profile trigger should create the matching `public.profiles` row. If the row is missing, repair it using an appropriately protected administrative workflow in the Supabase dashboard; do not put an admin or service-role key in the frontend.

Bootstrap the first manager's organisation membership in the SQL Editor with the Auth user's UUID:

```sql
insert into public.organisation_members (organisation_id, user_id, role)
values ('YOUR_ORGANISATION_UUID', 'YOUR_AUTH_USER_UUID', 'manager')
on conflict (organisation_id, user_id) do update set role = 'manager';
```

Managers inherit access to venues in that organisation; no `venue_members` row is required for the manager.

The frontend stores `id`, `display_name`, `email`, `active`, and `platform_role` in memory after login. The displayed role is not an authorization boundary. RLS must enforce all future organisation and venue permissions.

### Run locally with VS Code Live Server

Install the **Live Server** extension in VS Code, then right-click [`index.html`](index.html) and choose **Open with Live Server**. Open the URL shown by VS Code, for example:

```text
http://127.0.0.1:5500/
```

Make sure the exact local origin is included in Supabase **Authentication > URL Configuration**. Do not open `index.html` directly with a `file://` URL.

### Test login and logout

1. Open the local URL. With no session, only the DailyOps login screen should be visible.
2. Try an invalid password and confirm the Supabase error is shown on the login screen.
3. Sign in with the test user and confirm the profile display name appears in the existing user area.
4. Refresh the page and confirm the session is restored without signing in again.
5. Select the sign-out action and confirm the app returns to the login screen.
6. Open Templates and Team. Confirm remote Opening/Closing Shift templates, organisation members, venue memberships, and today's roster load; history and notification changes remain deferred/local.

Production URL:

```text
https://abhishek-b.github.io/DailyOps/
```

### Verify RLS

Use an authenticated browser session or the Supabase client with a test user's session when checking access. Do not use the SQL Editor as proof of RLS behavior because dashboard SQL runs with elevated privileges. Confirm that memberships and venues returned to a signed-in user match their organisation/venue access, and that a user cannot read or update another user's profile unless the deployed RLS policies explicitly allow it.

## Intentionally deferred

- role editing and automated Auth-user invitation/creation;
- historical days, reporting, and CSV export migration;
- realtime subscriptions;
- notification delivery and scheduled jobs;
- roster CSV import;
- Postgres-backed reporting and CSV export;
- Edge Functions, Storage, offline support, and PWA behaviour.

The existing localStorage implementation remains available as the compatibility/demo repository while those adapters are developed incrementally.
