# DailyOps architecture

DailyOps models a venue's work as Daily Operations, divided into operational sections such as the Opening Shift and Closing Shift. The current production schema still contains legacy `checklist_*` names; those names are compatibility details, not the product's user-facing model.

## Current demo path

```text
Browser -> index.html -> localStorage
```

The demo seeds venues, staff, templates, today's tasks, historical days and simulated notifications in the browser. User switching is intentionally fake and is not an authorization boundary.

## Supabase phase 1 path

```text
Browser on GitHub Pages
  -> Supabase JS v2 CDN client
  -> Supabase Auth session
  -> Postgres tables protected by RLS
```

`index.html` keeps the rendering and interaction model while using Supabase for identity, organisation membership, venue access, organisation-wide manager team visibility, weekly cross-venue roster planning, recurring templates, today's operational instances, historical review, reporting metrics, CSV export, and scoped current-day Realtime synchronisation. The configured public URL/key selects this path; placeholders select demo mode.

Authentication remains Supabase email/password internally. The frontend presents a username-first form and maps a username such as `jsmith` to `jsmith@dailyops.invalid` through one `USERNAME_AUTH_DOMAIN` constant. Identifiers containing `@` remain compatible with existing administrator/test email accounts. The matching Edge Function normalization rules are kept in `supabase/functions/_shared/username.ts`.

## Core relational model

Organisation
- owns venues and organisation memberships
- manager membership grants administration of the organisation's venues

Venue
- belongs to one organisation
- has venue settings and venue memberships
- owns recurring Opening/Closing Shift task templates and daily operation instances
- is presented through an organisation filter for manager-capable users; the filter only contains organisations permitted by the authenticated RLS-backed manager context

Team and roster scope
- is one managed organisation when an organisation filter is selected
- spans all organisations in the manager membership set when `All organisations` is selected
- gives active platform admins the combined organisation and venue scope through the existing platform-admin RLS helpers
- aggregates shared employees for cross-venue weekly planning while retaining organisation-specific memberships and venue access
- gives active platform admins a global profile directory, including profiles with no organisation memberships, enriched with every organisation membership and its venue context

Recurring shift-task template and template tasks
- define future routine work
- are copied into daily task instances when a daily operation is created

Daily operation instance and daily tasks
- are keyed by venue, local work date and the legacy `open`/`close` list type
- keep title, detail, critical flag and task state as a snapshot
- retain completion user/time, notes and incomplete reasons

Roster assignment
- records a user, venue, date and Opening/Closing Shift assignment
- managers create/remove assignments through RLS-scoped writes
- managers can view assignments across all managed venues for a selected seven-day planning window
- employees may insert their own explicit current cover assignment after confirming the in-app prompt; they cannot update or delete roster rows

Shift cover request
- records the employee-confirmed cover notification for a venue/date/shift, with an optional covered employee
- managers can read and mark requests seen only for venues they manage
- the browser creates the in-app alert and requests a server-validated Telegram delivery; email/SMS remains deferred

Notification event
- records server-side Telegram delivery status, recipient profile, provider message ID, failure detail, and a per-recipient idempotency key for complete submission, incomplete submission, reopen, cover, end-of-day, and test messages

Venue notification recipient
- links one active manager or platform-admin profile to one venue and a Telegram Chat ID
- stores independent enabled, Shift Complete, Incomplete Submissions, Shift Reopened, Shift Cover, and End of Day preferences
- is readable and writable only by authorised venue managers/platform admins through RLS
- Chat IDs are not copied into notification audit rows

Server-side notifications
- `notify-manager` receives only an authenticated, RLS-visible checklist/cover-request ID after a successful submit, reopen, or cover write, or a configured recipient record ID for a fixed manager test
- after a submitted shift request, it derives whether the stored tasks are complete; complete submissions use the concise Shift Complete preference, while incomplete submissions use the Incomplete Submissions preference and include stored task reasons/notes
- it derives all recipient Chat IDs and task messages from Supabase, then sends through the single Telegram bot
- `end-of-day` is invoked by Supabase Cron, applies each venue's IANA timezone/cutoff, and records one idempotent summary event per venue/date/recipient
- a database-managed `daily_checklists.notification_revision` distinguishes first submission from resubmission after reopen; browser callers cannot choose the revision
- a database trigger allows only active platform admins to change `venues.cutoff_time` or `venues.timezone`, while preserving other permitted manager venue updates
- `reset_today_operations(uuid)` is a SECURITY DEFINER RPC that checks `can_manage_venue`, calculates the venue-local date, rebuilds both current-day operation snapshots from active templates in one transaction, and advances notification revisions without sending notifications
- `create-user` requires an authenticated bearer token, verifies an active platform-admin profile, creates an Auth user with the server-only Admin API, and calls the service-role-only `provision_created_user(...)` RPC for profile/membership provisioning
- `manage-user-access` requires an authenticated bearer token, verifies an active platform-admin profile, and calls the service-role-only `admin_manage_user_organisation_access(...)` RPC for atomic organisation-membership changes

Historical operations and CSV
- query recent prior daily operation instances for the selected venue
- use stored daily task snapshots and profile attribution for read-only review
- calculate manager summaries in the browser from the authorised Supabase rows
- export the selected venue's loaded history client-side without privileged credentials

Live operational synchronisation
- subscribes only to `daily_checklists`, `daily_tasks`, and `roster_assignments` for the selected venue/current date
- treats Postgres changes as a refetch signal rather than a second state store
- removes the channel on venue, tab, session, or access changes
- keeps ordinary query loading and manual recovery available if Realtime is disconnected

Access revalidation uses a separate current-user channel for `profiles`, `organisation_members`, and `venue_members`. It is combined with focus/visibility refresh and a 45-second identity/access poll, so access changes do not depend exclusively on Postgres DELETE event delivery.

## Authorization boundary

The browser key is publishable. RLS policies use the signed-in Auth UUID, organisation memberships, venue memberships, active profiles, and the platform-admin helper to decide access. Ordinary managers inherit access to all venues in their organisation; active platform admins inherit management access across organisations; employees require an active venue membership. Managers can administer profiles, venue memberships, and rosters only within managed organisations/venues; they cannot write `organisation_members`. Migration 020 restricts venue membership inserts/updates/deletes to employee memberships in the target venue organisation and protects browser platform-role changes. Migration 020 also exposes only the service-role-only organisation-access RPC, which is called by the authenticated platform-admin `manage-user-access` Edge Function. The browser does not create Auth users directly. `create-user` and `manage-user-access` independently verify active platform-admin callers. Database triggers prevent employees from changing task definition fields, attributing a completion to another user, selecting a notification revision, changing protected venue timing settings, or changing `platform_role` through the browser.

Migration 021 adds a UUID-backed `protected_accounts` configuration for the master administrator. The migration resolves the existing bootstrap Auth user once, validates its profile is active and `platform_role = 'admin'`, and stores only the UUID and protection kind. Database triggers prevent other callers or privileged application paths from deactivating/demoting/deleting the protected profile or mutating its organisation/venue membership rows. The caller-aware organisation-access RPC and Edge Function reject attempts to target it from another account. The frontend reads only a safe protected flag through `is_protected_master_admin(uuid)`; it never contains the master UUID or email as a security rule.

Access is live-revalidated separately from operational data. The browser subscribes to the current user's `profiles`, `organisation_members`, and `venue_members` rows, refreshes on visibility/focus, and polls the small identity/access set every 45 seconds. It preserves a legal organisation/venue selection, redirects away from manager-only tabs after a downgrade, clears stale manager data, and fails closed while rechecking. Backend RLS and current-row helper checks remain mandatory; the frontend state is only a convergence mechanism.

## Snapshot invariant

`ensure_daily_checklists(venue_id, work_date)` is a legacy-named database helper. It creates an open and/or close daily operation instance only when an active Supabase template exists and copies template tasks, including their stable IDs, only when the instance is first created. Later template edits do not change existing daily tasks. The frontend's explicit re-apply action only adds missing routine snapshots and never resets existing state or one-off tasks.

Reset Today is intentionally different from re-apply: the manager-only reset RPC discards the current task snapshots and rebuilds both shifts from the current active templates. It preserves each daily operation ID, advances `notification_revision`, and retains `notification_events` so a later submission has a new idempotency identity.

The current `checklist_type` enum is intentionally retained for the deployed `open`/`close` data model. A future operation-section migration should be additive and backward compatible when sections such as Mid Shift, Kitchen Opening, Bar Opening, FOH Opening, Cleaning, or Maintenance become product requirements; this cleanup does not introduce that migration.

## Planned backend work

- cover-request email/SMS and push delivery
- database outbox/webhook coverage for task writes made outside the frontend
