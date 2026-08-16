# DailyOps Starter v2

DailyOps is a framework-free, multi-venue daily-operations app for opening and closing shifts. It remains a single static `index.html` suitable for GitHub Pages.

## Project status

[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) is the canonical reference for the current architecture, migration state, product terminology, roadmap, and technical debt. Update it when those project-level decisions change.

## Current phase

Supabase currently supplies authentication, organisation/venue identity, and today's live shift-operation instances:

- email/password sign-in and sign-out;
- persisted sessions across browser refreshes; and
- the signed-in user's `public.profiles` row;
- the user's organisation memberships and organisation names; and
- the venues returned by the deployed RLS policies;
- today's `public.daily_checklists` Opening/Closing Shift rows; and
- today's `public.daily_tasks` status, completion attribution/timestamps, notes, and incomplete reasons.

Recurring shift-task templates, roster data, history, CSV export, and simulated notifications remain localStorage-backed. Production defaults to Supabase mode. The original demo can be enabled explicitly with `DEMO_MODE: true`.

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

Recurring shift-task templates, roster assignments, history, notifications, and related demo screens still use the existing localStorage state. Real venue rows are mapped to temporary local operations contexts so real Supabase IDs do not overwrite or get persisted into the old demo state. The live daily operation/task state is kept in a separate in-memory Supabase view and is never silently replaced with local task state.

## Supabase today's operation loading

For each accessible real venue, the app loads today's `public.daily_checklists` rows for `list_type = open` and `list_type = close`, representing the Opening and Closing Shifts, then loads their `public.daily_tasks`. A manager can temporarily bootstrap missing rows: the legacy instance rows are inserted with the schema's unique `(venue_id, work_date, list_type)` key, and empty task lists are seeded from the matching local demo template. The seed tasks intentionally have `template_task_id = null`; this is temporary phase-1 bootstrap data until recurring shift-task snapshots are migrated. Repeated page loads see the existing rows/tasks and do not seed them again. Employees cannot bootstrap missing rows; RLS remains the boundary and they see an explicit initialisation message.

Task changes use the schema's existing `pending`, `done`, `blocked`, `na`, and `skipped` values. Completion writes `completed_by` and `completed_at`; reopening clears those fields. Notes, reasons, and shift submission metadata are written to Supabase. One-off task creation, template sync/copy, reset, notifications, rosters, and history remain deferred or local/demo.

### Create the first manager account

Create an email/password user under **Authentication > Users**. The deployed profile trigger should create the matching `public.profiles` row. If the row is missing, repair it using an appropriately protected administrative workflow in the Supabase dashboard; do not put an admin or service-role key in the frontend.

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
6. Confirm the existing demo/template UI still works after successful login and that its deferred changes remain in localStorage.

Production URL:

```text
https://abhishek-b.github.io/DailyOps/
```

### Verify RLS

Use an authenticated browser session or the Supabase client with a test user's session when checking access. Do not use the SQL Editor as proof of RLS behavior because dashboard SQL runs with elevated privileges. Confirm that memberships and venues returned to a signed-in user match their organisation/venue access, and that a user cannot read or update another user's profile unless the deployed RLS policies explicitly allow it.

## Intentionally deferred

- organisation and venue administration mutations;
- database-backed recurring shift-task template administration and snapshots;
- roster migration and roster administration;
- historical days, reporting, and CSV export migration;
- realtime subscriptions;
- notification delivery and scheduled jobs;
- roster CSV import;
- Postgres-backed reporting and CSV export;
- Edge Functions, Storage, offline support, and PWA behaviour.

The existing localStorage implementation remains available as the compatibility/demo repository while those adapters are developed incrementally.
