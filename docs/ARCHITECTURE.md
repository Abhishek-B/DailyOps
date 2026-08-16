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

`index.html` keeps the rendering and interaction model but replaces the source of truth for the first vertical slice. The configured public URL/key selects this path; placeholders select demo mode.

## Core relational model

Organisation
- owns venues and organisation memberships
- manager membership grants administration of the organisation's venues

Venue
- belongs to one organisation
- has venue settings and venue memberships
- owns recurring Opening/Closing Shift task templates and daily operation instances

Recurring shift-task template and template tasks
- define future routine work
- are copied into daily task instances when a daily operation is created

Daily operation instance and daily tasks
- are keyed by venue, local work date and the legacy `open`/`close` list type
- keep title, detail, critical flag and task state as a snapshot
- retain completion user/time, notes and incomplete reasons

Roster assignment
- records a user, venue, date and Opening/Closing Shift assignment

Notification event
- reserves an auditable record for future Edge Function delivery

## Authorization boundary

The browser key is publishable. RLS policies use the signed-in Auth UUID, organisation memberships, venue memberships, and active profiles to decide access. Managers inherit access to all venues in their organisation; employees require an active venue membership. Database triggers prevent employees from changing task definition fields or attributing a completion to another user.

## Snapshot invariant

`ensure_daily_checklists(venue_id, work_date)` is a legacy-named database helper. It creates an open and/or close daily operation instance only when an active template exists and only copies template tasks when the instance is first created. Later template edits do not change existing daily tasks. Explicit recurring shift-task synchronisation will be implemented in phase 2.

The current `checklist_type` enum is intentionally retained for the deployed `open`/`close` data model. A future operation-section migration should be additive and backward compatible when sections such as Mid Shift, Kitchen Opening, Bar Opening, FOH Opening, Cleaning, or Maintenance become product requirements; this cleanup does not introduce that migration.

## Planned backend work

- phase 2: template, roster, employee, settings, history and CSV adapters
- phase 3: Realtime task subscriptions
- phase 4: Edge Functions and scheduled end-of-day notifications
