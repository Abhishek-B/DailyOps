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
- records the employee-confirmed cover notification for a venue/date/shift
- managers can read and mark requests seen only for venues they manage
- the current implementation is an in-app alert; email/SMS and realtime delivery are deferred

Notification event
- reserves an auditable record for future Edge Function delivery

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

## Authorization boundary

The browser key is publishable. RLS policies use the signed-in Auth UUID, organisation memberships, venue memberships, active profiles, and the platform-admin helper to decide access. Ordinary managers inherit access to all venues in their organisation; active platform admins inherit management access across organisations; employees require an active venue membership. Managers can administer members, profiles, venue memberships, and rosters only within managed organisations/venues. Migrations 006 and 007 narrow venue-membership reads and require manager-created memberships/rosters to stay within the target organisation; migration 008 records the authenticated helper grant required for manager profile updates; migration 009 makes the active platform-admin capability explicit in RLS; migration 010 scopes cover-request alerts to managed venues; migration 011 only adds the three live operational tables to the standard Realtime publication and does not broaden RLS. Disabling a profile or removing venue access clears future roster assignments but preserves historical rows and attribution. The browser does not create Auth users or yet assign unassociated Auth users to an organisation by email. That workflow is intentionally deferred to a manager-scoped Edge Function or narrowly scoped SECURITY DEFINER RPC. Database triggers prevent employees from changing task definition fields or attributing a completion to another user.

## Snapshot invariant

`ensure_daily_checklists(venue_id, work_date)` is a legacy-named database helper. It creates an open and/or close daily operation instance only when an active Supabase template exists and copies template tasks, including their stable IDs, only when the instance is first created. Later template edits do not change existing daily tasks. The frontend's explicit re-apply action only adds missing routine snapshots and never resets existing state or one-off tasks.

The current `checklist_type` enum is intentionally retained for the deployed `open`/`close` data model. A future operation-section migration should be additive and backward compatible when sections such as Mid Shift, Kitchen Opening, Bar Opening, FOH Opening, Cleaning, or Maintenance become product requirements; this cleanup does not introduce that migration.

## Planned backend work

- phase 2: Edge Functions and scheduled end-of-day notifications
