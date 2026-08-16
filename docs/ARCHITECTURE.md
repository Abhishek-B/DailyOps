# DailyOps architecture

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
- owns open/close checklist templates and daily checklist instances

Checklist template and template tasks
- define future routine work
- are copied into daily task instances when a daily checklist is created

Daily checklist and daily tasks
- are keyed by venue, local work date and `open`/`close` list type
- keep title, detail, critical flag and task state as a snapshot
- retain completion user/time, notes and incomplete reasons

Roster assignment
- records a user, venue, date and open/close shift

Notification event
- reserves an auditable record for future Edge Function delivery

## Authorization boundary

The browser key is publishable. RLS policies use the signed-in Auth UUID, organisation memberships, venue memberships, and active profiles to decide access. Managers inherit access to all venues in their organisation; employees require an active venue membership. Database triggers prevent employees from changing task definition fields or attributing a completion to another user.

## Snapshot invariant

`ensure_daily_checklists(venue_id, work_date)` creates an open and/or close checklist only when an active template exists and only copies template tasks when the checklist is first created. Later template edits do not change existing daily tasks. Explicit template synchronisation will be implemented in phase 2.

## Planned backend work

- phase 2: template, roster, employee, settings, history and CSV adapters
- phase 3: Realtime task subscriptions
- phase 4: Edge Functions and scheduled end-of-day notifications
