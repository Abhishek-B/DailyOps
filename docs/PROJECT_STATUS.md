# DailyOps project status

This is the canonical project status and architecture reference for DailyOps. It records the terminology, deployed schema boundary, current implementation, deferred work, roadmap, and development workflow.

## 1. Project overview

DailyOps is a static browser application for managing a venue's Daily Operations. It helps managers and employees work through recurring and one-off operational tasks across Opening and Closing Shifts, record task outcomes, and retain operational history.

The intended product supports multiple organisations, venues, managers, and employees. The current Supabase model is organisation-aware even though the first deployment is small and may contain only one organisation.

## 2. Product terminology

- **Daily Operations**: the operational work for one venue and work date.
- **Opening Shift**: the opening operational section for a venue/date.
- **Closing Shift**: the closing operational section for a venue/date.
- **Routine Task**: recurring work supplied by a Supabase-backed shift-task template.
- **One-off Task**: an ad-hoc task added for a particular operation/date.
- **Daily Operation / shift-operation instance**: the dated snapshot of work for one operational section. It owns task instances and submission metadata.

The product language intentionally avoids presenting DailyOps as a checklist product. The current schema still uses legacy names such as `checklist_type`, `checklist_templates`, `template_tasks`, and `daily_checklists`. Those names are retained because they are deployed, referenced by foreign keys, RLS policies, triggers, helper functions, and frontend adapters. In the current model, a `daily_checklists` row represents a shift-operation instance, not a mutable live view of a template.

The current `checklist_type` enum contains `open` and `close`. The frontend presents these as Opening Shift and Closing Shift. No database rename or enum expansion was made during this terminology pass. When additional sections such as Mid Shift, Kitchen Opening, Bar Opening, FOH Opening, Cleaning, or Maintenance become active requirements, the change should be additive and backward compatible.

## 3. Current architecture

- Production frontend: static `index.html` hosted on GitHub Pages.
- Browser database client: Supabase JS v2 loaded from a CDN.
- Authentication: Supabase Auth email/password sessions.
- Database: Supabase Postgres.
- Authorisation: Postgres Row Level Security and deployed helper functions.
- Future backend: Supabase Edge Functions and scheduled jobs for server-side notifications and end-of-day processing.

Production URL:

`https://abhishek-b.github.io/DailyOps/`

The browser uses only the Supabase project URL and publishable key from `supabase/config.js`. Demo/localStorage mode remains available only when explicitly enabled with `DEMO_MODE: true`.

## 4. Authentication and authorisation model

- `auth.users` is the Supabase Auth identity source.
- `public.profiles.id` is the profile row linked to `auth.users.id`.
- `public.profiles.platform_role` is the platform-level `user`/`admin` status. It is not the organisation operating role.
- `public.organisation_members.role` is the organisation operating role: `manager` or `employee`.
- A manager membership grants organisation-level management access, including the organisation's venues under the deployed RLS policies.
- An employee membership identifies the user as an employee; venue access is additionally constrained by the deployed venue membership/access model.

The frontend uses `organisation_members.role` to select manager or employee UI. It does not use `platform_role` to infer that role. RLS is the real security boundary; UI visibility is not authorisation.

## 5. Current database model

The deployed initial schema currently contains these important public tables:

- `organisations`: organisation/business records.
- `profiles`: authenticated user profile data, active state, contact fields, and platform role.
- `organisation_members`: the user's membership and `manager`/`employee` organisation role.
- `venues`: venues belonging to an organisation, including subtitle, accent, cutoff, and notification settings.
- `venue_members`: explicit employee-to-venue access memberships.
- `checklist_templates`: recurring template headers for the legacy `open`/`close` operation types.
- `template_tasks`: ordered routine tasks belonging to a template.
- `daily_checklists`: dated operation/shift instances keyed by venue, work date, and legacy `list_type`; stores submitted state and submission attribution.
- `daily_tasks`: snapshot task instances belonging to a dated operation; stores definition, status, completion attribution/time, notes, and incomplete reasons.
- `roster_assignments`: dated venue and shift assignments using the legacy `shift_type` field.
- `notification_events`: reserved notification/audit records for future delivery; the current frontend notification experience is still local/demo.

Important deployed enums include `app_role` (`manager`, `employee`), `checklist_type` (`open`, `close`), `task_status` (`pending`, `done`, `blocked`, `na`, `skipped`), `task_source` (`template`, `adhoc`), and `platform_role` (`user`, `admin`).

The schema also contains SECURITY DEFINER access helpers, task/checklist update guards, and `ensure_daily_checklists(uuid, date)`. These helpers and guards remain part of the RLS boundary and are not renamed by this cleanup.

Migration history currently consists of `001_initial_schema.sql`, `002_add_platform_role.sql`, `003_grant_helper_function_execute.sql`, `004_grant_can_update_task_execute.sql`, and `005_allow_managers_delete_adhoc_daily_tasks.sql`. Already-applied schema migrations remain immutable.

## 6. What is live/real today

**REAL NOW**

- Supabase Auth email/password login, logout, and persisted session restoration.
- The authenticated `profiles` row, including `id`, `display_name`, `email`, `active`, and `platform_role`.
- Organisation membership loading from `organisation_members`.
- Organisation role selection from `organisation_members.role`.
- RLS-filtered venue loading, real venue switching, accent display, and selected-venue persistence.
- Today's Opening Shift and Closing Shift operation instances from `daily_checklists`.
- Today's task rows from `daily_tasks`.
- Task status persistence using the deployed `pending`, `done`, `blocked`, `na`, and `skipped` values.
- Completion attribution and timestamps through `completed_by` and `completed_at`.
- Task notes and incomplete reasons through `note` and `reason`.
- Operation submission metadata through `submitted`, `submitted_by`, and `submitted_at`.
- Manager-created one-off tasks in `daily_tasks`, including title, detail, critical flag, `source = 'adhoc'`, ordering, and `added_by`/`added_at`.
- Manager deletion of one-off tasks only; routine daily tasks remain protected from deletion by RLS.
- Recurring Opening Shift and Closing Shift templates from `checklist_templates` and `template_tasks`.
- Manager template task CRUD, critical flags, ordering, and venue-to-venue copy through Supabase.
- Template-to-daily-operation snapshot generation through `ensure_daily_checklists(uuid, date)`.
- Manager re-application of missing routine tasks from the Supabase template, using stable `template_task_id` references without replacing existing state or removing one-off tasks.
- Manager task controls for individual updates, notes/reasons, bulk completion, one-off tasks, shift submission, and reopening.
- Today's progress, outstanding, critical-outstanding, per-shift progress, and submitted counts from the in-memory view loaded from Supabase `daily_tasks` and `daily_checklists`.

## 7. What is still local/demo/deferred

**DEMO/LOCAL STILL**

- The explicit `DEMO_MODE: true` path retains localStorage-backed templates for standalone demo use.
- A one-time manager bootstrap may read the existing local/demo routine definitions only when a venue has no remote template rows; normal Supabase operation does not use them as a source of truth.
- Roster management and roster CSV import.
- Historical days, reporting, and CSV history export.
- Simulated notification inbox and notification previews.

**DEFERRED**

- Realtime subscriptions.
- Production email/SMS notification delivery.
- Edge Functions.
- Scheduled end-of-day processing.
- Full venue, employee, organisation-membership, and roster administration from the frontend.
- Offline/PWA support and evidence/photo attachments.

## 8. Completed milestones

Steps 1–10 are complete in the current migration history and frontend implementation:

1. Initial multi-organisation Postgres schema, indexes, constraints, triggers, and RLS model.
2. Additive `platform_role` schema migration for platform-level `user`/`admin` status.
3. Public Supabase browser configuration, Supabase JS v2 client, Auth login/logout, session persistence, and profile loading.
4. Authenticated EXECUTE grants for the deployed RLS helper functions, including `can_update_task`.
5. Real organisation membership and venue loading, with organisation role driving manager/employee views.
6. Real venue selection/persistence with a temporary local demo bridge for still-deferred template/roster/history screens.
7. Today's Supabase daily operation instances and task rows, including idempotent manager bootstrap for missing Opening/Closing rows.
8. Supabase task status, completion metadata, notes, incomplete reasons, and operation submission/review flow.
9. Today's complete Supabase operation workflow: one-off tasks, safe routine re-apply, manager controls, shift submission/reopening, and real progress/critical counts.
10. Supabase-backed recurring Opening/Closing Shift templates, manager template CRUD/order/copy, stable template-task references, and template-based daily snapshot generation.

The repository does not use a separate generated milestone registry; this list reflects the current project history and implementation state.

## 9. Known technical debt

- Live tables, enum values, foreign keys, RLS policies, triggers, and adapter constants retain legacy `checklist` naming.
- `docs/original-peachy-demo.html` remains a historical reference artifact and is not the production application.
- The current operational type model is still hard-coded to `open` and `close` in the deployed enum and several frontend loops. Additional operation sections need an additive design before implementation.
- Existing daily rows created before Step 10 may need a one-time manager-side title match to backfill their `template_task_id`; unmatched legacy rows are preserved rather than rewritten.
- The one-time template bootstrap still uses local/demo definitions when a venue has no remote template. It does not overwrite existing remote template data.
- Deferred roster, history, and notification screens still depend on localStorage state and the temporary real-venue-to-demo-context mapping.
- Realtime is not implemented, so another browser's task changes are not pushed into an already-open screen.
- There is no production notification backend or scheduled end-of-day job.
- RLS helper EXECUTE grants were initially missing in the live project and were corrected in migrations `003_grant_helper_function_execute.sql` and `004_grant_can_update_task_execute.sql`. The one-off delete capability is isolated in `005_allow_managers_delete_adhoc_daily_tasks.sql`. Keep these grants/policies and verify them when provisioning another Supabase project.
- The frontend has been validated through repository/static checks and the existing development workflow; a full authenticated browser regression suite is still follow-up work.

## 10. Next milestones

Use this order for the next phases:

1. Roster, employees, and venue memberships.
2. History, reporting, and CSV.
3. Realtime.
4. Notifications.
5. Scheduled end-of-day processing.
6. Final security testing.
7. Custom domain and polish.

## 11. Git workflow

```text
feature/<name>
      ↓
   develop
      ↓
     main
```

- `main` is stable production.
- `develop` is the integration branch.
- `feature/*` branches isolate feature work.
- Feature branches merge into `develop`.
- `develop` is tested before it is merged into `main`.
- GitHub Pages deploys from `main`.
- GitHub settings are changed manually; this repository does not change them automatically.

## 12. Local development

Use the VS Code Live Server extension. Right-click `index.html`, choose **Open with Live Server**, and use the URL shown by VS Code, commonly:

`http://127.0.0.1:5500/`

The exact local origin must be allowed in Supabase Authentication URL Configuration. Do not open the app with `file://`. Keep `DEMO_MODE: false` for Supabase testing; use `DEMO_MODE: true` only for the explicit localStorage demo.

## 13. Deployment

GitHub Pages deploys the static site from `main`. The production URL is:

`https://abhishek-b.github.io/DailyOps/`

Supabase Authentication URL Configuration must include the production site and the local Live Server origin. Auth redirect configuration must match the production domain exactly, including the repository path used by GitHub Pages.

## 14. Security rules

- Never expose a Supabase secret key, service-role key, database password, or provider secret in browser-visible files.
- The Supabase URL and publishable key are browser-safe project credentials; RLS still controls all data access.
- Never rely on hiding a button or navigation item for authorisation.
- Every exposed public table must remain protected by RLS, with policies scoped to organisation and venue access.
- Do not add broad authenticated read/write policies to make frontend errors disappear.
- Put schema changes in a new sequential migration.
- Treat already-applied migrations as immutable; do not edit them to repair live history.
- Keep SECURITY DEFINER helper functions narrowly scoped, with explicit authenticated EXECUTE grants where required.
