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
- Authentication: Supabase Auth email/password sessions behind a username-first frontend adapter.
- Database: Supabase Postgres.
- Authorisation: Postgres Row Level Security and deployed helper functions.
- Live synchronisation: Supabase Realtime for the selected venue and current operation date, with authoritative Supabase refetches after relevant row changes.
- Supabase Edge Functions and Supabase Cron now provide server-side Telegram notifications and end-of-day processing.

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

The frontend exposes all accessible organisation memberships, while `managedOrganisationIds()` remains a manager-only scope for Team, roster, template, history, and notification administration. `organisation_members.role` for the selected venue's organisation determines the current manager or employee UI. An active `platform_role = 'admin'` profile is additionally treated as globally manager-capable, and the corresponding RLS helpers enforce that capability. RLS is the real security boundary; UI visibility is not authorisation. Active platform admins use a separate authenticated `manage-user-access` Edge Function for organisation-membership administration; organisation role remains per membership row and is never collapsed into `platform_role`.

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
- `shift_cover_requests`: employee-confirmed current-shift cover notifications for managers, including an optional `covered_for_user_id`.
- `notification_events`: server-side Telegram delivery audit rows for complete submission, incomplete submission, shift-reopened, shift-cover, end-of-day, and test events, including recipient profile, idempotency, retry state, provider ID, and failure detail. Telegram Chat IDs are not copied into audit rows.
- `venue_notification_recipients`: venue-scoped Telegram Chat IDs linked to active manager/platform-admin profiles, with independent enabled, Shift Complete, Incomplete Submissions, Shift Reopened, Shift Cover, and End of Day preferences.

Important deployed enums include `app_role` (`manager`, `employee`), `checklist_type` (`open`, `close`), `task_status` (`pending`, `done`, `blocked`, `na`, `skipped`), `task_source` (`template`, `adhoc`), and `platform_role` (`user`, `admin`).

The schema also contains SECURITY DEFINER access helpers, task/checklist update guards, and `ensure_daily_checklists(uuid, date)`. These helpers and guards remain part of the RLS boundary and are not renamed by this cleanup.

Migration history currently consists of `001_initial_schema.sql`, `002_add_platform_role.sql`, `003_grant_helper_function_execute.sql`, `004_grant_can_update_task_execute.sql`, `005_allow_managers_delete_adhoc_daily_tasks.sql`, `006_restrict_venue_member_reads.sql`, `007_scope_team_and_roster_writes.sql`, `008_grant_can_manage_profile_execute.sql`, `009_platform_admin_access.sql`, `010_add_shift_cover_requests.sql`, `011_enable_daily_operations_realtime.sql`, `012_add_notification_delivery_and_timezone.sql`, `013_add_telegram_notification_recipients.sql`, `014_fix_notification_service_role_grants.sql`, `015_notification_workflow_and_admin_cutoff.sql`, `016_incomplete_submission_notifications.sql`, `017_reset_today_operations.sql`, `018_platform_admin_user_provisioning.sql`, `019_fix_create_user_compensation.sql`, and `020_user_organisation_access.sql`. Already-applied schema migrations remain immutable.

Migration `012_add_notification_delivery_and_timezone.sql` adds an IANA `venues.timezone` field (existing venues default to `Australia/Sydney`), notification event idempotency/retry/audit fields, and service-role-only claim/finalize/fail functions. It does not add browser write access to `notification_events` or broaden RLS.

Migration `006_restrict_venue_member_reads.sql` replaces the initial broad `venue_members` select policy with a manager-or-own-membership policy. It does not change venue-membership write policies or roster access.

Migration `007_scope_team_and_roster_writes.sql` keeps manager-created venue memberships and roster assignments inside the target venue's organisation, requires manager-rostered employees to be active and explicitly assigned to the venue, and preserves the existing authenticated self-cover insert path.

Migration `008_grant_can_manage_profile_execute.sql` grants authenticated EXECUTE on the existing `can_manage_profile(uuid)` helper so manager active-state/profile updates can pass the existing `profiles_update` policy.

Migration `009_platform_admin_access.sql` keeps `platform_role` separate from the organisation operating role while allowing an active platform admin to administer all organisations and venues through the existing helper functions and RLS policies. Ordinary users still require an active `organisation_members` manager membership for management access.

Migration `010_add_shift_cover_requests.sql` stores an employee's confirmed current-shift cover request and gives managers a venue-scoped in-app alert. It does not send email/SMS and does not add a manager approval step.

Migration `013_add_telegram_notification_recipients.sql` adds venue-scoped Telegram recipient configuration, manager/platform-admin-only RLS, the `telegram` notification channel, and a service-role-only per-recipient claim function. It preserves legacy email/SMS columns and audit rows without using them for active production delivery.

Migration `014_fix_notification_service_role_grants.sql` records the narrow service-role SELECT grants required by the Telegram Edge Functions for `venue_notification_recipients` and `profiles`. Telegram test notifications have been successfully verified in production.

Migration `015_notification_workflow_and_admin_cutoff.sql` records the service-role reads required by the new notification paths, adds checklist reopen/revision metadata, adds optional cover attribution and recipient preferences, extends notification event kinds, and protects venue cutoff/timezone changes with an active platform-admin-only database trigger. Existing recipient rows default to reopen notifications enabled and shift-cover notifications disabled. Braddon's temporary EOD test cutoff has been restored to `23:30`.

Migration `016_incomplete_submission_notifications.sql` adds the per-recipient `notify_incomplete_submission` preference (defaulting existing and new recipients to enabled) and records the `list-incomplete` notification event kind. A submitted shift now produces either a concise complete-submission message or an actionable incomplete-submission message; the detailed report remains the scheduled End-of-Day summary.

Migration `017_reset_today_operations.sql` adds the manager-only `reset_today_operations(uuid)` SECURITY DEFINER RPC. It uses the selected venue's IANA timezone, atomically rebuilds both current-day operation rows from active templates, preserves checklist IDs, advances notification revisions, clears task/submission state, and leaves notification audit history untouched.

Migration `018_platform_admin_user_provisioning.sql` adds the service-role-only `provision_created_user(...)` SECURITY DEFINER RPC. It validates the Auth user, synthetic username email, roles, and organisation, then upserts the profile and organisation membership without creating venue memberships. No authenticated or anonymous EXECUTE grant is added.

Migration `019_fix_create_user_compensation.sql` corrects the synthetic email validation to `username@dailyops.invalid` and adds the service-role-only `cleanup_failed_created_user_profile(uuid)` RPC. The compensation RPC can remove only a matching synthetic-email profile with no organisation or venue memberships; it cannot remove an established DailyOps user.

Migration `020_user_organisation_access.sql` removes direct authenticated writes to `organisation_members`, protects browser changes to `profiles.platform_role`, and limits `venue_members` inserts, updates, and deletes to employee memberships in organisations managed by the caller. It adds the service-role-only `admin_manage_user_organisation_access(...)` RPC, which atomically upserts or removes one user's organisation membership and cleans current/future venue access, roster assignments, cover requests, and non-platform-admin notification recipients when access is removed. Active platform-admin authorisation is performed by the `manage-user-access` Edge Function before it calls the RPC.

## 6. What is live/real today

**REAL NOW**

- Supabase Auth username/password login, logout, and persisted session restoration. New usernames use `USERNAME_AUTH_DOMAIN = "dailyops.invalid"`; existing full email login identifiers remain supported.
- The authenticated `profiles` row, including `id`, `display_name`, `email`, `active`, and `platform_role`.
- Organisation membership loading from `organisation_members`.
- Organisation role selection from `organisation_members.role`, evaluated for the currently selected organisation/venue so mixed-role users can move between manager and employee contexts without signing out.
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
- Manager Reset Today for both Opening and Closing Shifts through the atomic, venue-authorised `reset_today_operations(uuid)` RPC.
- Today's progress, outstanding, critical-outstanding, per-shift progress, and submitted counts from the in-memory view loaded from Supabase `daily_tasks` and `daily_checklists`.
- Organisation member loading and the manager Team view from `organisation_members` and `profiles`.
- Employee active/inactive state updates through `profiles` while retaining historical profile rows.
- Manager venue membership administration through `venue_members`.
- Organisation-wide manager Team visibility for every member of the selected organisation, including employees who have no access to the selected venue.
- Combined Team visibility for managers of multiple organisations and active platform admins when `All organisations` is selected; shared employees retain organisation-specific membership rows and venue access context.
- Cross-venue and cross-organisation roster assignment summaries for managers, loaded from `roster_assignments` for the current manager scope and week.
- Seven-day Opening/Closing Shift roster planning through `roster_assignments`, with controls for every eligible venue in the current manager scope and week navigation.
- Employee active/inactive changes and venue-access removal clear future roster assignments while retaining historical records.
- Today's Opening/Closing Shift roster assignments through `roster_assignments`, including persistence and secure employee self-cover.
- Employee roster-aware shift context and manager on-shift counts from real roster rows.
- Platform-admin organisation and venue visibility, with database-enforced global management access for active `platform_role = 'admin'` profiles.
- Platform-admin-only user creation through the authenticated `create-user` Edge Function, including synthetic `dailyops.invalid` Auth identities, profile provisioning, organisation role selection, platform role selection, no automatic employee venue membership, and protected compensation for failed provisioning.
- Platform-admin global profile directory, including profiles with no organisation memberships, with per-organisation role and venue-access context.
- Platform-admin organisation access administration through the authenticated `manage-user-access` Edge Function: add memberships, change a user's role per organisation, and remove organisation access without deleting the Auth account or historical attribution.
- Manager-scoped venue membership administration enforced by RLS: managers can change employee venue access only inside organisations they manage; organisation membership mutations are not available to ordinary managers.
- Manager-capable users can filter the venue context by `All organisations` or a managed organisation; ordinary managers cannot select organisations outside their manager memberships.
- Multi-organisation venue labels show the organisation name alongside the venue in the venue picker and manager cross-venue summary.
- Employee weekly roster and accessible-venue view across the current planning week.
- Employee-confirmed cover requests persisted in `shift_cover_requests` and displayed as manager Alerts; confirmation adds the employee to the shift and does not require manager approval.
- Historical Daily Operations for prior dates, loaded from `daily_checklists` and `daily_tasks` for the selected venue.
- Read-only historical Opening/Closing Shift review, including task snapshot titles, statuses, critical flags, sources, notes, reasons, submission metadata, roster context, and profile attribution.
- Historical completion, outstanding, critical-missed, submission, and per-profile summary metrics from Supabase rows.
- Manual CSV export for the selected venue's loaded historical operations, including organisation, venue, shift, task, status, attribution, submission metadata, reasons, and notes.
- Realtime task synchronisation for the selected venue and current operation date. `daily_tasks` changes trigger an authorised refetch, so status, notes, reasons, one-off additions, and eligible deletions appear without a manual refresh.
- Realtime Opening/Closing Shift submission and reopening state from `daily_checklists`.
- Realtime current-day roster updates from `roster_assignments`, including manager counts and employee roster context where the current view uses them.
- Realtime channel cleanup on venue/tab/session changes, with normal query loading retained as the fallback when a channel disconnects. A small selected-venue/day refetch timer also catches deletes, because Postgres Changes cannot column-filter delete events without broadening the subscription scope.
- Server-side shift-complete Telegram delivery through `notify-manager`, with authenticated checklist visibility checks and venue-derived recipient Chat IDs.
- Submit-gated server-side Shift Complete Telegram delivery: completing the last task only makes a shift ready to submit; the canonical notification event is a successful submitted shift.
- Submit-gated incomplete-submission Telegram delivery: an incomplete submitted shift sends stored task statuses, reasons, and notes to recipients who enable Incomplete Submissions.
- Per-revision Shift Reopened and resubmitted Shift Complete Telegram delivery, with independent per-recipient idempotency keys.
- Venue-scoped Telegram recipient management for active managers/platform admins, with independent Shift Complete, Incomplete Submissions, Shift Reopened, Shift Cover, and End of Day preferences.
- Server-validated employee Shift Cover Telegram delivery with optional covered-person attribution and independent per-recipient idempotency.
- Idempotent notification event claiming/finalization/failure recording per recipient in `notification_events`, with a bounded retry path and Telegram message IDs.
- Supabase Cron-compatible `end-of-day` Edge Function that evaluates each venue in its configured IANA timezone after its cutoff and sends a stored-operation Telegram summary to each enabled recipient.
- Active platform admins can edit a venue's EOD cutoff in Settings; the database trigger rejects cutoff/timezone changes from ordinary managers and employees.
- Manager Alerts delivery status for server-sent, pending, and failed Telegram events. The browser no longer treats the local notification stub as production data.
- Telegram test notifications, employee Shift Complete delivery, pg_cron invocation, pg_net request delivery, Vault project URL/Cron secret usage, timezone/cutoff evaluation, and End-of-Day Telegram delivery have been successfully verified in production.

## 7. What is still local/demo/deferred

**DEMO/LOCAL STILL**

- The explicit `DEMO_MODE: true` path retains localStorage-backed templates for standalone demo use.
- A one-time manager bootstrap may read the existing local/demo routine definitions only when a venue has no remote template rows; normal Supabase operation does not use them as a source of truth.
- Roster CSV import.
- The explicit `DEMO_MODE: true` path retains the simulated local notification inbox and previews.
- Shift-cover alerts remain Supabase-backed in-app alerts with optional Telegram delivery; cover-request email/SMS delivery is still deferred.

**DEFERRED**

- SMS, push notifications, email fallback, and cover-request email delivery.
- Ordinary manager/employee Auth-user creation and arbitrary email-based assignment remain restricted. Active platform admins can create users through the authenticated `create-user` Edge Function; organisation role and platform role are selected there, while employee venue access remains a separate Team action.
- Realtime cover alerts and manager push notifications. The current cover flow is an in-app database-backed alert only.
- Offline/PWA support and evidence/photo attachments.

## 8. Completed milestones

Steps 1–14 plus the platform-admin user-provisioning follow-up are complete, with the organisation-wide team, weekly roster, historical reporting, current-day realtime follow-ups, and server-side notification foundation now implemented:

1. Initial multi-organisation Postgres schema, indexes, constraints, triggers, and RLS model.
2. Additive `platform_role` schema migration for platform-level `user`/`admin` status.
3. Public Supabase browser configuration, Supabase JS v2 client, Auth login/logout, session persistence, and profile loading.
4. Authenticated EXECUTE grants for the deployed RLS helper functions, including `can_update_task`.
5. Real organisation membership and venue loading, with organisation role driving manager/employee views.
6. Real venue selection/persistence with a temporary local demo bridge for the remaining explicitly deferred notification/demo screens.
7. Today's Supabase daily operation instances and task rows, including idempotent manager bootstrap for missing Opening/Closing rows.
8. Supabase task status, completion metadata, notes, incomplete reasons, and operation submission/review flow.
9. Today's complete Supabase operation workflow: one-off tasks, safe routine re-apply, manager controls, shift submission/reopening, and real progress/critical counts.
10. Supabase-backed recurring Opening/Closing Shift templates, manager template CRUD/order/copy, stable template-task references, and template-based daily snapshot generation.
11. Supabase-backed organisation members/profiles, employee active state, venue memberships, today's roster assignments, manager Team controls, and employee roster-aware views.
12. Organisation-wide manager staff visibility, cross-venue assignment summaries, seven-day roster planning, and future-roster cleanup when access is disabled or removed.
13. Platform-admin access across organisations, employee weekly roster/venue visibility, and employee-confirmed in-app shift-cover notifications.
14. Combined multi-organisation Team visibility and cross-organisation roster planning for managers with multiple manager memberships and platform admins.
15. Supabase-backed historical Daily Operations, read-only historical shift/task review, profile attribution, manager reporting metrics, and manual CSV export.
16. Supabase Realtime for selected-venue/current-day tasks, shift submission state, and roster changes, using scoped channels and authoritative refetches.
17. Supabase Edge Functions/Telegram shift-complete delivery, venue-scoped recipient configuration, idempotent notification audit state, timezone-aware scheduled end-of-day summaries, and manager delivery-status Alerts.
18. Submit-gated completion notifications, reopen/resubmit lifecycle revisions, shift-cover Telegram delivery, and platform-admin-only EOD cutoff editing.
19. Platform-admin-only Auth user creation through `create-user`, service-role-only profile/membership provisioning, and `dailyops.invalid` username identities.
20. Platform-admin global profile directory and secure per-organisation membership administration through `manage-user-access`, plus manager-scoped venue membership enforcement.

The repository does not use a separate generated milestone registry; this list reflects the current project history and implementation state.

## 9. Known technical debt

- Live tables, enum values, foreign keys, RLS policies, triggers, and adapter constants retain legacy `checklist` naming.
- `docs/original-peachy-demo.html` remains a historical reference artifact and is not the production application.
- The current operational type model is still hard-coded to `open` and `close` in the deployed enum and several frontend loops. Additional operation sections need an additive design before implementation.
- Existing daily rows created before Step 10 may need a one-time manager-side title match to backfill their `template_task_id`; unmatched legacy rows are preserved rather than rewritten.
- The one-time template bootstrap still uses local/demo definitions when a venue has no remote template. It does not overwrite existing remote template data.
- The explicit demo mode still uses localStorage seed data; normal Supabase history/reporting no longer falls back to it.
- The real-venue-to-demo-context mapping remains only for any legacy screens that are still explicitly local/demo.
- The static browser never uses Supabase Auth Admin APIs or a service-role key. New staff use the `username@dailyops.invalid` convention through the platform-admin-only `create-user` Edge Function. Rare Auth-created/database-provisioning failures use server-side compensation; an orphan Auth UUID is logged for protected administrator cleanup if deletion also fails.
- The current organisation/venue repair is a one-time SQL cleanup when duplicate organisation rows exist; the production model should retain one organisation row with multiple venue rows.
- Organisation membership changes are platform-admin-only and must go through `manage-user-access` and the service-role-only `admin_manage_user_organisation_access(...)` RPC. Ordinary managers retain venue/team/roster administration inside managed organisations but cannot write `organisation_members` or promote users.
- Employees may insert their own current roster assignment through the existing RLS policy for the explicit "I'm covering" flow; they cannot update or delete roster rows.
- Migration `006_restrict_venue_member_reads.sql` narrows employee reads of venue membership data while preserving manager administration.
- Migration `007_scope_team_and_roster_writes.sql` prevents cross-organisation venue membership/roster writes through raw browser requests.
- Migration `008_grant_can_manage_profile_execute.sql` records the required authenticated EXECUTE grant for manager profile updates.
- Realtime is scoped to the selected venue and current operation date. Notification delivery is server-side and not part of the Realtime channel; the browser retains normal query loading if a realtime channel disconnects.
- Edge Functions and Cron must be deployed/configured separately from GitHub Pages. The repository cannot prove Telegram bot secrets or Cron health until the manual Supabase setup is completed.
- Submit/reopen and shift-cover notifications are initiated by successful frontend writes and then revalidated server-side. A direct external database write that bypasses the frontend will not create the corresponding notification event until a database webhook/outbox integration is added.
- The `notification_revision` trigger is server-managed. Service-role notification finalization is explicitly allowed to update the legacy `complete_notified` field, while browser callers cannot choose lifecycle revisions or reopen timestamps.
- The venue cutoff editor is UI-gated for active platform admins and database-enforced by `enforce_venue_admin_settings_update`; ordinary managers retain other permitted venue updates but cannot change cutoff/timezone.
- The first EOD processor reports existing daily operation rows. It does not create an empty operation solely to send a Telegram report when nobody has opened that venue/date yet.
- Automated notifications are capped at five attempts per event. A permanently failed event requires operator review/repair before another retry path is introduced.
- Shift-cover requests currently use two client writes: the employee roster assignment and the notification row. If the first write succeeds and the second fails, the UI reports the failure and the manager should verify the assignment before retrying.
- RLS helper EXECUTE grants were initially missing in the live project and were corrected in migrations `003_grant_helper_function_execute.sql` and `004_grant_can_update_task_execute.sql`. The one-off delete capability is isolated in `005_allow_managers_delete_adhoc_daily_tasks.sql`. Keep these grants/policies and verify them when provisioning another Supabase project.
- The frontend has been validated through repository/static checks and the existing development workflow; a full authenticated browser regression suite is still follow-up work.

## 10. Next milestones

Use this order for the next phases:

1. Cover-request email/SMS delivery and optional push notifications.
2. Final security testing, provider failure drills, and database/outbox coverage for non-frontend writes.
3. Custom domain and polish.

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

### Step 13 two-client Realtime test

1. Apply migration `011_enable_daily_operations_realtime.sql`, or enable the same three tables in the `supabase_realtime` publication from the Supabase dashboard.
2. Open the Live Server URL in a normal window as a manager and a second browser/private window as an employee. Sign both users into the same organisation and venue, and leave both on Today's Operations.
3. In the employee window, complete or reopen a task and add a note/reason. Confirm the manager window updates without a manual refresh and that progress, status, note, and reason match.
4. In the manager window, add a one-off task, then delete it. Confirm the employee window reflects both changes. The delete may arrive through the selected-venue/day refetch fallback rather than an immediate change event.
5. Submit Opening Shift in one window and confirm the other window shows the submitted/read-only state. Reopen it as manager and confirm the other window unlocks without resetting task state. Repeat for Closing Shift if needed.
6. Change today's roster assignment in Team from one client and confirm on-shift/roster context updates in the other client where that view is visible.
7. Switch one client to another venue or a non-Today tab. Change a task in the original venue from the other client and confirm the switched-away client does not visibly update until it returns to that venue/day.
8. Log out and back in, switch venues several times, and confirm there is one current channel, no repeated reloads, and no browser console 403/500 errors.

### Step 14 notification/EOD setup and test

1. Apply migrations `012_add_notification_delivery_and_timezone.sql`, `013_add_telegram_notification_recipients.sql`, `014_fix_notification_service_role_grants.sql`, `015_notification_workflow_and_admin_cutoff.sql`, `016_incomplete_submission_notifications.sql`, `017_reset_today_operations.sql`, `018_platform_admin_user_provisioning.sql`, `019_fix_create_user_compensation.sql`, and `020_user_organisation_access.sql` in that order.
2. Create one Telegram bot with BotFather, deploy the notification functions, `create-user`, and `manage-user-access`, and configure `TELEGRAM_BOT_TOKEN` and a long random `DAILYOPS_CRON_SECRET` as Edge Function secrets. Redeploy `create-user` after applying migration 019. The exact commands and recipient workflow are in the README.
3. Enable `pg_cron`, `pg_net`, and Vault, and create the single `dailyops-end-of-day` Cron job. The job invokes the function every 15 minutes; the function applies each venue's IANA timezone and cutoff.
4. Have the first recipient open the bot and press Start, retrieve their Chat ID through a trusted admin workflow, and add it under manager Settings. Confirm the recipient row persists after refresh.
5. Use the recipient Test button. Confirm one `test` event/message. Complete the final task in a test shift and confirm no Telegram is sent until Submit Shift is pressed; then confirm one concise `list-complete` event/message per enabled recipient.
6. Reopen the submitted shift and confirm one `list-reopened` event/message. Submit it with an incomplete task and a reason/note; confirm one `list-incomplete` event/message per recipient with Incomplete Submissions enabled. Resubmit a complete shift and confirm one new completion event/message labelled as a resubmission. Repeat from two browser clients and confirm revision/recipient idempotency prevents duplicates.
7. Enable Shift Cover, have an employee cover for a rostered person, and confirm one `shift-cover` event/message containing the venue, shift/date, covering person, and covered person. Disable the preference and confirm no new cover message is sent.
8. As an active platform admin, change a venue cutoff in Settings and confirm it persists. Confirm a direct manager/employee cutoff update is rejected by the database trigger. Braddon's production cutoff is `23:30`.
9. Set a temporary cutoff shortly ahead, wait for Cron, and confirm one `end-of-day` event/message per enabled recipient. Run Cron again and confirm it does not send again.
10. Break a test Chat ID or use a recipient who has not started the bot. Confirm `failed` plus `error_message`, while valid recipients continue receiving messages. Fix the recipient and retry before the five-attempt cap.
11. Confirm an employee cannot invoke the test path, read recipient Chat IDs, or choose an arbitrary destination, and confirm no bot/service key appears in browser source or network requests.

### Reset Today and username login

1. Create a venue with current template tasks A/B/C. Add one-off task D, complete A/B, add notes, and submit if appropriate. As a manager, choose **Reset today**, confirm the destructive warning, and verify both shifts contain only current-template tasks in `pending` state with no one-off tasks, notes, reasons, completion attribution, or submission metadata.
2. Remove B from the template and add E. Reset again and verify the resulting routine set is exactly A/C/E, with no stale B.
3. Submit a shift before a reset and confirm its Telegram event remains in `notification_events`. Reset, complete the rebuilt shift, and submit again; confirm the second completion uses a new notification event and the old audit row remains.
4. Attempt `select * from public.reset_today_operations('<venue uuid>');` as an employee or with an unauthorised authenticated session. The RPC must reject the call.
5. Create `jsmith@dailyops.invalid` through **Team → Create user** and sign in as `jsmith`. Verify whitespace trimming, lowercase matching, allowed-character validation, generic wrong-password failure, and continued full-email login for existing administrators.

### Platform-admin user creation

1. Deploy `create-user` with JWT verification enabled and apply migration `018_platform_admin_user_provisioning.sql`.
2. Sign in as an active profile with `platform_role = 'admin'`. Team should show **Create user** and organisations should come from the platform-admin organisation query.
3. Create an employee. The Edge Function creates `<username>@dailyops.invalid`, confirms the Auth email internally, provisions the profile and selected organisation membership, and creates no `venue_members` row. Assign venue access separately in Team.
4. Create an organisation manager and a second platform admin. The manager receives normal manager access through `organisation_members.role`; the second admin receives existing cross-organisation platform capabilities through `profiles.platform_role`.
5. Managers, employees, and unauthenticated callers must receive `403`/`401` and cannot create Auth users through the function. The browser never receives or stores the initial password.
6. If Auth creation succeeds but provisioning fails, the function first removes only the unprovisioned trigger-created profile through the service-role-only cleanup RPC, then deletes the new Auth user. If either compensation step fails, use the server log's orphan Auth UUID in a protected Supabase dashboard cleanup workflow; never paste service-role credentials into the frontend.

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
- Provider secrets and the Supabase service-role/secret key belong only in Edge Function secrets; the static frontend may contain only the URL and publishable key.
- The scheduled function is protected by `DAILYOPS_CRON_SECRET`; do not put that secret in GitHub Pages, `index.html`, or `supabase/config.js`.
