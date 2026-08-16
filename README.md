# DailyOps Starter v2

DailyOps is a framework-free, multi-venue opening/closing checklist app. It remains a single static `index.html` suitable for GitHub Pages. With Supabase configured, Auth and Postgres become the source of truth for the phase 1 vertical slice; with the placeholder config left unchanged, the original localStorage demo remains available.

## What works in phase 1

- Supabase email/password sign-in and sign-out
- Persisted Supabase Auth sessions across browser refreshes
- Profile and organisation role loading
- Venue access enforced by database RLS
- Venue switching for the signed-in user
- Today's separate opening and closing checklists
- Daily task snapshots created once from active templates
- Task completion, completion attribution, notes, and incomplete-task reasons persisted to Postgres
- Existing localStorage demo mode, including the fake user switcher

The remaining demo screens are deliberately read-only placeholders in Supabase mode until their database adapters are implemented. This prevents a phase 1 screen from appearing to save local changes that are not yet persisted remotely.

## Supabase setup - phase 1

### 1. Run the migration

In the Supabase dashboard, open **SQL Editor**, create a new query, paste the complete contents of [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql), and run it once on a new project.

The migration creates organisations, profiles, organisation and venue memberships, venues, templates, template tasks, daily checklist snapshots, daily task instances, roster assignments, notification event storage, indexes, constraints, helper functions, an Auth-to-profile trigger, and RLS policies.

### 2. Configure Supabase Auth

In **Authentication > Providers**, enable **Email**. For a first local test, either disable email confirmation or confirm the manager email after creating the account. In **Authentication > URL Configuration**, add the URL where the static app will run, for example:

```text
http://localhost:8080
```

Add the eventual GitHub Pages URL before deploying. Do not enable or rely on anonymous access for this app.

### 3. Add the public browser configuration

Copy the values from **Project Settings > API** into [`supabase/config.js`](supabase/config.js):

```js
window.DAILYOPS_SUPABASE_CONFIG = {
  url: 'https://your-project.supabase.co',
  publishableKey: 'your-publishable-or-anon-key'
};
```

These two values are intentionally browser-visible credentials. They identify the project but do not bypass RLS. Never paste a `service_role` key, database password, Edge Function secret, email provider key, or SMS provider key into this file, `index.html`, or GitHub Pages.

### 4. Create the first manager and seed one venue

In **Authentication > Users**, create an email/password user. The migration trigger creates the matching `public.profiles` row automatically.

Copy the new user's UUID from the Auth user record and run this in **SQL Editor**, replacing the values in the first three lines. This creates one organisation, makes the user its manager, creates a venue, assigns the manager to it, and creates empty open/close templates:

```sql
-- Replace these values before running.
select 'AUTH_USER_UUID'::uuid as manager_id;

with manager as (
  select 'AUTH_USER_UUID'::uuid as user_id
), org as (
  insert into public.organisations (name)
  values ('My Organisation')
  returning id
), membership as (
  insert into public.organisation_members (organisation_id, user_id, role)
  select org.id, manager.user_id, 'manager'
  from org cross join manager
  returning organisation_id
), venue as (
  insert into public.venues (organisation_id, name, subtitle, accent_key)
  select membership.organisation_id, 'Main Venue', 'Daily checklist', 'indigo'
  from membership
  returning id, organisation_id
), venue_access as (
  insert into public.venue_members (venue_id, user_id)
  select venue.id, manager.user_id
  from venue cross join manager
  returning venue_id
)
insert into public.checklist_templates (venue_id, list_type, name)
select venue.id, list_type, initcap(list_type::text) || ' Shift'
from venue cross join (values ('open'::public.checklist_type), ('close'::public.checklist_type)) as lists(list_type);
```

Add at least one task to each template before signing in, or the app will correctly show empty lists. For example:

```sql
insert into public.template_tasks (template_id, sort_order, title, detail, critical)
select id, 1, 'Unlock and walk the venue', 'Check the floor before service.', true
from public.checklist_templates
where list_type = 'open';

insert into public.template_tasks (template_id, sort_order, title, detail, critical)
select id, 1, 'Lock doors and set the alarm', 'Complete the final walk-through.', true
from public.checklist_templates
where list_type = 'close';
```

On the first manager sign-in, the app calls `ensure_daily_checklists` for each accessible venue. That function creates today's open/close checklist rows and copies the current template tasks into immutable daily task instances.

### 5. Run and test locally

From the repository root:

```bash
python -m http.server 8080
```

Open `http://localhost:8080`. In Supabase mode, the app shows the login screen. Sign in with the manager account, switch venues if more than one is available, tick a task, add a note or incomplete reason through the existing submit flow, refresh the browser, and confirm the state remains.

To use the original demo, restore the placeholders in `supabase/config.js` or leave them unchanged before loading the page. The demo uses `localStorage` and is intentionally not an authenticated security boundary.

### 6. Verify RLS is protecting data

Use two test users: a manager assigned to one organisation and an employee assigned to only one venue. Sign in as the employee and verify that a query such as the following only returns the employee's venue:

```js
const { data, error } = await db.from('venues').select('id,name');
```

Then use the Supabase SQL Editor or a second browser session to verify that the employee cannot read another venue's checklist and cannot update a task in that venue. Also verify that an employee cannot update `completed_by` to another user's UUID: the database trigger must reject it. The SQL Editor runs with elevated database privileges, so use an authenticated browser session or the Supabase client with the employee's session when testing policies.

## Current data mapping

The old local state remains a useful compatibility model: `S.venues` maps to `venues`, `S.users` to `profiles` plus memberships, `S.templates` to `checklist_templates` and `template_tasks`, `S.days[venue][date].lists[type]` to `daily_checklists`, and each task object to `daily_tasks`. `roster` arrays become `roster_assignments`; `notifications` becomes `notification_events` in the schema. Daily tasks carry their own title/detail/critical values so template edits do not mutate history.

## Phase 2 intentionally left open

- Template, venue, employee, and roster administration adapters
- Full historical reporting and CSV export from Postgres
- Realtime task subscriptions
- Notification delivery and scheduled end-of-day jobs
- Roster CSV import
- File/photo evidence, Storage, audit UI, analytics, and offline/PWA behaviour

The existing demo continues to exercise those workflows locally.
