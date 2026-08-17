# DailyOps Starter v2

DailyOps is a framework-free, multi-venue daily-operations app for opening and closing shifts. It remains a single static `index.html` suitable for GitHub Pages.

## Project status

[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) is the canonical reference for the current architecture, migration state, product terminology, roadmap, and technical debt. Update it when those project-level decisions change.

## Current phase

Supabase currently supplies authentication, organisation/venue identity, team membership, weekly roster planning, today's live shift-operation instances, and historical reporting:

- email/password sign-in and sign-out;
- persisted sessions across browser refreshes;
- the signed-in user's `public.profiles` row;
- the user's organisation memberships and organisation names;
- the venues returned by the deployed RLS policies;
- organisation members, profiles, active state, and organisation role;
- organisation-wide employee visibility for managers, employee venue memberships, and Opening/Closing Shift roster assignments across the selected week;
- active platform-admin access across organisations and venues, employee weekly roster/venue visibility, and shift-cover requests with in-app manager Alerts plus optional Telegram delivery;
- the selected venue's recurring Opening/Closing Shift templates and routine tasks; and
- today's `public.daily_checklists` Opening/Closing Shift rows and `public.daily_tasks` routine/one-off tasks, status, completion attribution/timestamps, notes, and incomplete reasons;
- prior venue operation days, read-only historical shift/task review, Supabase-backed summary metrics, and client-side CSV export from stored daily snapshots.
- live current-venue/current-date task, shift-submission, and roster updates through Supabase Realtime; the client refetches authorised rows after each relevant change.

Submit-gated shift-complete, reopen, shift-cover, and scheduled end-of-day Telegram delivery now run through Supabase Edge Functions and Supabase Cron. The old simulated notification inbox remains localStorage-backed only when `DEMO_MODE: true`; production defaults to Supabase mode.

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

After authentication, the app reads the signed-in user's rows from `public.organisation_members` and loads the related `public.organisations` rows. For ordinary users, the `organisation_members.role` value (`manager` or `employee`) determines the manager or employee UI for the selected venue. An active profile with `platform_role = 'admin'` is a separate platform-level capability that can manage all organisations/venues through RLS; it does not change ordinary organisation roles.

The app then queries `public.venues`. RLS is the access boundary: ordinary managers receive venues in organisations they manage, active platform admins receive all organisations/venues through the deployed helper functions, and employees receive only venues allowed by the deployed membership policies. Manager-capable users can filter the UI to `All organisations` or one managed organisation; the venue picker and manager group summary include organisation names when more than one organisation is available. The selected organisation and real venue IDs are remembered in user-specific local preferences and restored only if the user still has access.

Team and roster data now load from Supabase. Managers see every member of the selected organisation regardless of venue; managers of multiple organisations and platform admins can select `All organisations` to see the combined staff and venue scope. Shared employees remain visible with each organisation membership and their weekly assignments are shown across all accessible venues. Managers can manage profile active state and `venue_members` access, and plan Opening/Closing Shift assignments across a seven-day window for every eligible venue in their manager scope. Deactivating an employee or removing venue access clears future roster assignments while retaining historical records. Employees load only their permitted venues, can view their weekly roster across those venues, and can confirm a current self-cover action; confirmation adds the assignment and creates an in-app manager alert plus optional server-side Telegram delivery without an approval step. The older simulated notification inbox remains local/deferred. Real venue rows are still mapped to temporary local operations contexts only for legacy demo screens, so real Supabase IDs do not overwrite or get persisted into the old demo state.

## Supabase team, venue memberships, and roster

`auth.users` is the login identity, `profiles` is the app profile, `organisation_members` supplies the `manager`/`employee` organisation role, `venue_members` grants employee venue access, and `roster_assignments` records a user assigned to a venue/date/shift. RLS enforces these boundaries; the UI is not the security boundary.

The browser does not create Auth users or yet assign an unassociated Auth user to an organisation by email. For this MVP, create an employee under **Supabase → Authentication → Users**, then run the organisation-membership insert shown by the Team screen (or use the SQL Editor) with that Auth user's UUID. The Auth trigger creates `profiles`; after the membership exists, the manager can refresh the Team screen, assign or remove venues, enable/disable access, and plan the employee across the weekly roster. Role changes remain an administrator/manual operation, and `platform_role` is never edited by the Team UI. A future manager-scoped Edge Function or SECURITY DEFINER RPC will add the missing email-based organisation-assignment workflow; no service-role key belongs in the browser.

Migrations `supabase/migrations/006_restrict_venue_member_reads.sql`, `007_scope_team_and_roster_writes.sql`, `008_grant_can_manage_profile_execute.sql`, `009_platform_admin_access.sql`, and `010_add_shift_cover_requests.sql` narrow employee membership reads, scope manager-created venue memberships/roster assignments to active employees with access to the target venue, enable manager profile active-state updates, give active platform admins global management access through RLS helpers, and add venue-scoped in-app cover alerts. Apply them after migrations `001` through `005`.

## Supabase recurring shift templates

In Supabase mode, managers load and manage `public.checklist_templates` and `public.template_tasks` for the selected venue. The deployed RLS policies allow managers to insert, update, reorder, and delete only templates/tasks belonging to venues they manage; employees can read templates where their venue access permits it but do not receive template-management controls.

If a manager opens a venue with no remote Opening or Closing template yet, the browser performs a one-time compatibility bootstrap from that venue's existing local/demo routine definitions. It creates the missing remote template rows and tasks without overwriting existing remote templates. After that, Supabase is the source of truth. Template changes affect future daily operations; today's task rows remain snapshots. “Apply to today” adds missing tasks by stable `template_task_id`, preserves task state and one-off tasks, and does not delete existing daily tasks.

## Supabase today's operation loading

For each accessible real venue, the app loads today's `public.daily_checklists` rows for `list_type = open` and `list_type = close`, representing the Opening and Closing Shifts, then loads their `public.daily_tasks`. When a manager opens a date with missing rows, the existing `ensure_daily_checklists(uuid, date)` SECURITY DEFINER helper creates the missing instances and copies the current Supabase template tasks as snapshots. Repeated page loads are idempotent because of the database unique key `(venue_id, work_date, list_type)`. Employees cannot bootstrap missing rows; RLS remains the boundary and they see an explicit initialisation message.

Task changes use the schema's existing `pending`, `done`, `blocked`, `na`, and `skipped` values. Completion writes `completed_by` and `completed_at`; reopening clears those fields. Notes, reasons, and shift submission metadata are written to Supabase. Managers can add and remove `source = adhoc` one-off tasks, while routine tasks remain non-deletable. Re-apply routine tasks reads the Supabase template, adds only missing routine snapshots, and preserves existing state and one-off tasks. In Supabase mode, notification delivery is no longer simulated in the browser.

## Supabase historical operations and CSV

In normal Supabase mode, History queries recent prior `daily_checklists` rows for the selected venue, then loads their `daily_tasks`, roster assignments, and referenced `profiles`. The UI is read-only and uses stored daily task snapshots, so later template edits do not rewrite historical records. Summary metrics and completion attribution are calculated from those Supabase rows. Export CSV downloads the currently loaded venue history with organisation, venue, date, shift, task, critical/source, status, completion and submission attribution, reasons, and notes. A failed query shows an error instead of falling back to local demo history.

## Supabase Realtime

Apply `supabase/migrations/011_enable_daily_operations_realtime.sql` after migrations `001` through `010`. It adds only `daily_checklists`, `daily_tasks`, and `roster_assignments` to the standard `supabase_realtime` publication; it does not change RLS or grant table access.

If the migration reports that `supabase_realtime` is not present, open **Supabase > Database > Publications**, select `supabase_realtime`, and add these three public tables. Do not enable unrelated tables. If the dashboard uses a **Realtime** table-settings screen instead, enable Realtime for the same three tables. The frontend continues to work through normal Supabase queries if Realtime is unavailable.

The browser subscribes only to the selected venue and today's two operation IDs. An event triggers an authoritative Supabase refetch, and the channel is removed when the venue, tab, session, or access context changes. A small selected-venue/day refetch timer covers deletion events, which cannot be column-filtered by Postgres Changes without broadening the subscription. Realtime is not used for notifications or historical/template screens in this phase.

## Supabase production Telegram notifications and scheduled EOD

Apply [`supabase/migrations/012_add_notification_delivery_and_timezone.sql`](supabase/migrations/012_add_notification_delivery_and_timezone.sql), [`supabase/migrations/013_add_telegram_notification_recipients.sql`](supabase/migrations/013_add_telegram_notification_recipients.sql), [`supabase/migrations/014_fix_notification_service_role_grants.sql`](supabase/migrations/014_fix_notification_service_role_grants.sql), [`supabase/migrations/015_notification_workflow_and_admin_cutoff.sql`](supabase/migrations/015_notification_workflow_and_admin_cutoff.sql), and [`supabase/migrations/016_incomplete_submission_notifications.sql`](supabase/migrations/016_incomplete_submission_notifications.sql), in that order after migrations `001` through `011`.

Migration 012 adds venue IANA `timezone` (existing venues default to `Australia/Sydney`), notification retry/idempotency fields, and service-role-only claim/finalize/fail functions. Migration 013 adds the venue-scoped `venue_notification_recipients` table, recipient RLS, the `telegram` audit channel, and per-recipient claim/idempotency support. Migration 014 records service-role reads for recipients and profiles. Migration 015 records the required service-role reads for venues, daily operations, and shift-cover validation; adds submit/reopen lifecycle revision fields; adds optional covered-person and recipient preference fields; and protects cutoff/timezone edits at the database boundary. Chat IDs are not stored in `notification_events`.

The Edge Functions are [`notify-manager`](supabase/functions/notify-manager/index.ts) for authenticated submit-complete/reopen/cover/test requests and [`end-of-day`](supabase/functions/end-of-day/index.ts) for the scheduled cutoff processor. Both resolve recipients from Supabase and use the shared Telegram sender. The browser sends only a visible checklist or cover-request ID, or a configured recipient record ID for the fixed test message; it never sends a Chat ID, bot token, recipient destination, completion totals, or notification body.

The notification lifecycle is submit-gated. Completing the final task shows **Ready to submit** but does not send Telegram. A complete Submit Shift sends one concise `list-complete` event per enabled recipient. An incomplete Submit Shift sends one actionable `list-incomplete` event to recipients with **Incomplete submissions** enabled, including outstanding task statuses, reasons and notes. The detailed report remains the End-of-Day summary. Reopening a submitted shift increments the database-managed `notification_revision` and sends one `list-reopened` event; a later submission uses that revision in its idempotency key and is labelled as a resubmission. Shift-cover delivery uses `shift-cover:<cover_request_id>:<recipient_id>` and can identify the person being covered for.

### Deploy functions and set secrets

From the repository root, after installing/authenticating the Supabase CLI:

```sh
supabase login
supabase link --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy notify-manager --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy end-of-day --project-ref zwebxycbrfwtlmqwxwwe
supabase secrets set \
  TELEGRAM_BOT_TOKEN=replace-with-the-token-from-BotFather \
  DAILYOPS_CRON_SECRET=replace-with-a-long-random-secret \
  --project-ref zwebxycbrfwtlmqwxwwe
```

Use the real values only in the command or Supabase Edge Function Secrets UI. Never commit them, place them in `supabase/config.js`, or put them in `index.html`. The Supabase service-role/secret key is automatically available to Edge Functions and is not required in the repository.

### Configure Telegram

1. Open Telegram and message **@BotFather**.
2. Create one bot for DailyOps and copy the token once.
3. Store that token only as the `TELEGRAM_BOT_TOKEN` Supabase Edge Function secret.
4. Give authorised recipients the bot username. Each recipient must open the bot and press **Start** before messages can be delivered.
5. Retrieve each recipient's Telegram Chat ID through a trusted admin workflow, then add it in **Settings → Telegram recipients**. DailyOps does not automatically process `/start` messages or ask for the bot token.

One bot can send to many venue recipients. Each recipient is linked to an existing DailyOps profile and has independent Shift Complete, Incomplete Submissions, Shift Reopened, Shift Cover, and End of Day switches. Existing rows default to Incomplete Submissions enabled by migration 016, Shift Reopened enabled, and Shift Cover disabled; adjust these per recipient in Settings. A global `TELEGRAM_CHAT_ID` is not used.

The recipient table can also be populated by a trusted SQL administrator if necessary:

```sql
insert into public.venue_notification_recipients (
  venue_id,
  profile_id,
  telegram_chat_id,
  enabled,
  notify_shift_complete,
  notify_end_of_day,
  created_by
)
values (
  'YOUR_VENUE_UUID',
  'YOUR_MANAGER_PROFILE_UUID',
  'YOUR_TELEGRAM_CHAT_ID',
  true,
  true,
  true,
  'YOUR_ADMIN_PROFILE_UUID'
);
```

Chat IDs belong in this protected table only. Do not put them in frontend configuration, localStorage, Git, or `notification_events`.

### Create the Cron job

Enable `pg_cron`, `pg_net`, and Vault under **Supabase → Database → Extensions** if they are not already enabled. Store the project URL and the same scheduler secret used above in Vault, then run this once in the Supabase SQL Editor. Replace the placeholder secret before running it; do not put the secret in the repository:

```sql
select vault.create_secret('https://zwebxycbrfwtlmqwxwwe.supabase.co', 'dailyops_project_url');
select vault.create_secret('replace-with-the-same-long-random-secret', 'dailyops_cron_secret');

select cron.schedule(
  'dailyops-end-of-day',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyops_project_url') || '/functions/v1/end-of-day',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dailyops-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dailyops_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
```

If the job already exists, run `select cron.unschedule('dailyops-end-of-day');` before recreating it. The processor uses each venue's IANA timezone and cutoff, reads existing daily operation rows, and records a single idempotent EOD event per venue/date. It does not create an empty operation solely to send a report.

### Test safely

1. Apply migrations 012 through 016 in order, deploy `notify-manager` and `end-of-day`, add your own Telegram Chat ID under Settings, and set `notify_complete = true` and `notify_end_of_day = true` for the venue. Enable the recipient preferences you want.
2. Use the recipient's **Test** button. Confirm the fixed Telegram test message arrives and a `test` row becomes `sent` in `notification_events`.
3. Complete the final task in one shift. Confirm no Telegram is sent and the UI says the shift is ready to submit. Submit the shift, then confirm one concise `list-complete` row per enabled recipient becomes `sent` and exactly one Telegram message arrives per recipient.
4. Reopen the submitted shift. Confirm one `list-reopened` event/message. Submit with at least one incomplete task and a reason/note; confirm one `list-incomplete` event/message per recipient with Incomplete Submissions enabled. Change or complete the task and submit again; confirm one new completion event/message labelled as a resubmission. Repeat browser actions or use two clients; revision/recipient idempotency must prevent duplicates.
5. Confirm Shift Cover is enabled for a recipient, have an employee cover a shift for a rostered person, and confirm one `shift-cover` event/message identifies both people. Disable the preference and confirm no new Telegram is sent.
6. As an active platform admin, change a venue cutoff under Settings and refresh. Confirm the database value changes. A manager/employee direct update of `cutoff_time` must be rejected by the database trigger.
7. Set a temporary venue `cutoff_time` a few minutes ahead, wait for the 15-minute schedule, and confirm one `end-of-day` row/message per enabled recipient. Restore the normal cutoff (Braddon's production value is `23:30`) and re-run Cron; successful events must not send again.
8. Temporarily use an invalid Chat ID or disabled/unstarted recipient. Confirm that recipient has a `failed` event while valid recipients still receive their messages. Fix the recipient and retry before the five-attempt cap.
9. Open Alerts in the manager UI to see Telegram sent, pending, and failed delivery status. Employees cannot query manager notification events or recipient Chat IDs through the existing RLS policies.

To test locally, open the app with VS Code Live Server in two browser contexts, sign in with users who can access the same venue, and follow the two-client test sequence in `docs/PROJECT_STATUS.md`. A refresh remains a valid recovery path if a browser sleeps or loses its connection.

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
6. Open Templates, Team, History, and Alerts. Confirm remote Opening/Closing Shift templates, every member of the selected organisation, or every managed organisation when `All organisations` is selected, venue memberships, cross-venue assignments, the seven-day roster planner, prior operation days, historical CSV export, and notification delivery status load.

Production URL:

```text
https://abhishek-b.github.io/DailyOps/
```

### Verify RLS

Use an authenticated browser session or the Supabase client with a test user's session when checking access. Do not use the SQL Editor as proof of RLS behavior because dashboard SQL runs with elevated privileges. Confirm that memberships and venues returned to a signed-in user match their organisation/venue access, and that a user cannot read or update another user's profile unless the deployed RLS policies explicitly allow it.

## Intentionally deferred

- role editing, automated Auth-user invitation/creation, and manager-side assignment of a pre-created Auth user to an organisation by email; the future implementation must use a manager-scoped Edge Function or narrowly scoped SECURITY DEFINER RPC;
- SMS, push notifications, and email delivery for shift-cover requests;
- roster CSV import;
- automated Auth-user invitation/organisation assignment;
- Storage, offline support, and PWA behaviour.

The existing localStorage implementation remains available as the compatibility/demo repository while those adapters are developed incrementally.
