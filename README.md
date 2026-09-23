# DailyOps Starter v2

**Photo-evidence handoff (2026-09-23):** the feature passed 89 local regression checks and read-only hosted configuration checks. The notification functions are deployed and match this source; the production GitHub Pages frontend is still the older version. Publish/test the updated page before enabling operational photo requirements. See [the current verification status](docs/PROJECT_STATUS.md#photo-evidence-pre-merge-verification--2026-09-23); phase-by-phase status notes below describe their original completion point.

DailyOps is a framework-free, multi-venue daily-operations app for opening and closing shifts. It remains a single static `index.html` suitable for GitHub Pages.

## Project status

[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) is the canonical reference for the current architecture, migration state, product terminology, roadmap, and technical debt. Update it when those project-level decisions change.

## Current phase

Supabase currently supplies authentication, organisation/venue identity, team membership, weekly roster planning, today's live shift-operation instances, and historical reporting:

- username/password sign-in and sign-out through the Supabase email/password adapter;
- persisted sessions across browser refreshes;
- the signed-in user's `public.profiles` row;
- the user's organisation memberships and organisation names;
- the venues returned by the deployed RLS policies;
- organisation members, profiles, active state, and organisation role;
- organisation-wide employee visibility for managers, employee venue memberships, and Opening/Closing Shift roster assignments across the selected week;
- active platform-admin access across organisations and venues, employee weekly roster/venue visibility, and shift-cover requests with in-app manager Alerts plus optional Telegram delivery;
- platform-admin global profile directory and organisation-membership administration, including users with no current organisation access;
- the selected venue's recurring Opening/Closing Shift templates and routine tasks; and
- today's `public.daily_checklists` Opening/Closing Shift rows and `public.daily_tasks` routine/one-off tasks, status, completion attribution/timestamps, notes, and incomplete reasons;
- prior venue operation days, read-only historical shift/task review, Supabase-backed summary metrics, and client-side CSV export from stored daily snapshots.
- live current-venue/current-date task, shift-submission, and roster updates through Supabase Realtime; the client refetches authorised rows after each relevant change.

Submit-gated shift-complete, reopen, shift-cover, and scheduled end-of-day Telegram delivery now run through Supabase Edge Functions and Supabase Cron. The old simulated notification inbox remains localStorage-backed only when `DEMO_MODE: true`; production defaults to Supabase mode.

## Venue administration and UI cleanup (feature branch)

Apply migrations [025](supabase/migrations/025_venue_organisation_administration.sql) and [026](supabase/migrations/026_preserve_completion_and_atomic_submission.sql), in order after 024, **before publishing this frontend**. These changes do not require a build step, another host, or Edge Function changes. The migrations have not been applied to production by this implementation.

- Managers can add venues and edit name, tagline, colour, timezone, report cutoff, and notification rules within their own organisations. Platform admins can also create organisations. Organisation role assignment stays in the existing admin-only Team workflow.
- Venue creation is transactional and retry-safe, with two empty active shift-template headers. New venues never inherit demo routines. Add or copy routine tasks, then use **Add new routine tasks to today** to populate today's snapshots. Existing snapshot titles, progress and one-off tasks are unchanged.
- Admins with no organisations and managers with no venues can reach setup. One venue's unavailable daily operations no longer block Settings or other venues.
- Shift submission uses an atomic, revision-checked RPC. Note edits and submissions preserve existing completion attribution; a submitted review is read-only until explicitly reopened. Migration 026 also records the authenticated `can_access_task` helper permission required by existing task policies.
- Venue-day rollover refreshes on focus and a 30-second check. History boundaries and roster editing use venue dates. The operational date changes at local midnight, independently of the report cutoff.
- **View report delivery** opens Alerts; it does not manually send EOD. Live venue deletion/demo-wipe controls are hidden. Cover success is separate from Telegram delivery status.

## Photo evidence — phase 1: database and permissions

Branch: `feature/task-photo-evidence`. The user reports [027_task_photo_evidence.sql](supabase/migrations/027_task_photo_evidence.sql) applied after migrations 001–026. It remains unchanged in phase 2; live migration state was not independently checked.

The migration can precede the frontend release: existing photo requirements default to off and existing three-argument submission calls continue to work. **Do not enable photo requirements in production yet.** Phase 2 implements upload validation and physical cleanup below. Phases 3 and 4 add frontend controls and notification links locally. Hosted smoke tests remain pending deployment of the completed implementation, at the user's request.

- Managers/admins configure `template_tasks.requires_photo` using existing scoped template permissions. A task-insert trigger snapshots that value during employee initialisation, Reset Today and template-linked daily inserts, including inserts from the old frontend. Daily requirements are immutable after creation; an exception requires an audited approval rather than disabling an existing requirement. One-off tasks accept the requirement at creation.
- `organisations.photo_retention_days` defaults to 30 and accepts 1–365 days under the existing manager/admin organisation permissions. Each finalized upload gets its own expiry; later setting changes do not rewrite existing expiries.
- `task_evidence` tracks reserved uploads, verified photos and the deletion queue. `task_evidence_exemptions` records scoped manager approvals/revocations. `task_evidence_submissions` preserves immutable per-task evidence/exemption snapshots for each submission revision, including after expiry and Reset Today. Authenticated users can read these records only for accessible venues; neither browser users nor the service role can directly write them.
- Required tasks need an unexpired, verified private Storage object or a current-revision manager exemption before Done. Submission checks again, including direct checklist updates. Blocked/NA/Skipped tasks do not require photos. Ordinary task/evidence changes are blocked after submission; routine-template deletion can still unlink its foreign key without changing the daily snapshot.
- Removing the last photo or revoking the only exemption returns an unsubmitted required Done task to Pending. Reopening rechecks requirements under the new revision: still-valid photos can be reused, but old exemptions cannot. Expiry never rewrites an already-submitted task or its audit snapshot.
- Private-bucket RLS policies target `task-evidence`, including restrictive boundaries against pre-existing broad Storage policies. Uploads are limited to the uploader's live reservation; downloads require venue access and unexpired verified evidence. Browser overwrites/deletes are denied. These policies remain dormant until the private bucket is provisioned through the phase-2 setup script or dashboard.

### Database contracts for subsequent phases

| Caller | RPC | Contract |
|---|---|---|
| Signed-in venue user | `reserve_task_evidence(task_id, evidence_id)` | Client-generated UUID gives retry identity; server derives venue/organisation/path/owner. At most three live reservations/photos per task. Reservations expire after one hour. |
| Venue manager/admin | `approve_task_photo_exemption(task_id, reason)` | Non-empty reason, 1–1000 characters; approver/time recorded by the database. Revoke before replacing an approval. |
| Venue manager/admin | `revoke_task_photo_exemption(exemption_id)` | Open current revision only; preserves the original approval and records revocation. |
| Uploader or venue manager/admin | `remove_task_evidence(evidence_id)` | Open shift only; queues file removal and rechecks completion. Does not delete bytes. |
| Signed-in venue user | `submit_daily_checklist(checklist_id, notification_revision, changes, exemption_ids)` | Last argument is optional for old clients. Supply exactly the approved exemption IDs needed by Done tasks without valid photos. Guards apply even to direct table submission. |
| Trusted validator only | `finalize_task_evidence(evidence_id, uploaded_by, byte_size, mime_type, sha256)` | Service-role-only. Upload Edge Function authenticates the uploader and validates actual image bytes **before** calling. DB rechecks live access, revision, private Storage metadata, size (up to 5 MiB), image MIME type and digest format. Storage metadata is not image validation. |
| Cleanup worker only | `queue_expired_task_evidence(limit)` | Service-role-only; queues expired photos/abandoned uploads in batches of 1–500 and rechecks open-task completion. |
| Cleanup worker only | `confirm_task_evidence_deleted(evidence_id)` | Call only after the Storage API removes the object. DB requires queued state and absence of Storage metadata, then stamps deletion. Retry-safe. |

RPC parameter names use the `p_` prefix shown in the migration. The worker reads `state = 'delete_pending'` and calls the Storage API; it must not SQL-delete Storage objects. Audit identifiers deliberately do not cascade with task/checklist deletion, so reset/deletion cannot lose the paths needed for cleanup. No signed URLs or image bytes are stored in audit snapshots.

## Photo evidence — phase 2: private uploads and retention cleanup

Both functions were deployed on **2026-09-23** and read back as active version 1. Read-only preflight confirmed the migration-028 cleanup columns and the correctly restricted private bucket. The hosted scheduler-secret digest matches the local configuration; existing functions and secrets were unchanged. Unauthenticated requests to both new endpoints correctly return 401, and upload CORS preflight succeeds. The user reports running the cleanup schedule SQL in [deployment-guide step 4](supabase/functions/upload-task-evidence/README.md#4-add-the-separate-cleanup-schedule); a successful scheduled HTTP response has not yet been checked. Actual authenticated upload/deletion smoke tests remain outstanding.

- `upload-task-evidence` authenticates the user, reserves through RLS, decodes JPEG/PNG/WebP, auto-orients, strips metadata, resizes to at most 1600 pixels and stores a JPEG using the caller's Storage permissions. Only successful validation/finalisation counts as evidence; retries never overwrite an existing object.
- Input is limited to 5 MiB, 4 megapixels and 4096 pixels per side. Phase 3 must prepare camera/gallery photos on the device before calling this endpoint, including conversion where the browser supports it; raw HEIC and animated images are not accepted.
- `cleanup-task-evidence` uses the existing scheduler secret, removes database-queued objects through the Storage API, and retains audit rows. Migration 028 adds persistent retry/backoff fields, rejected-upload cleanup, and reconciliation of uploads that arrive after deletion. Expired photos become inaccessible immediately at expiry; physical removal follows the next successful scheduled cleanup.
- A generated, ignored decoder asset is prepared only for the upload Edge Function. The GitHub Pages frontend still needs no build step. Existing functions and Telegram behaviour are unchanged. UI toggles, upload/viewing controls and notification links are not part of phase 2.

Local Deno tests exercise real image bytes with injected caller identities and mocked Supabase HTTP responses. They cover format/size limits, EXIF removal/orientation, authentication boundaries, retry conflicts, private bucket setup and cleanup failures. The PGlite suite also covers migration 028. These checks do **not** prove hosted deployment, Storage byte deletion or multi-session concurrency; complete the deployment guide's isolated smoke test before enabling photo requirements.

With Deno installed, prepare the pinned decoder and run the phase-2 checks from the repository root:

```sh
deno run --no-lock --allow-read --allow-write=supabase/functions/_shared/photo-decoder scripts/prepare-photo-decoder.ts
deno check --no-lock supabase/functions/upload-task-evidence/index.ts supabase/functions/cleanup-task-evidence/index.ts scripts/setup-task-evidence-storage.ts
deno test --no-lock --allow-read tests/photo-evidence.test.ts
```

The preparation command downloads a pinned public dependency when uncached; it does not contact the DailyOps project. Decoder files are generated rather than committed. Run it again on a fresh checkout before testing or deploying.

## Photo evidence — phase 3: frontend controls

Implemented locally on `feature/task-photo-evidence`; **not committed, pushed or published**. This phase changes the static `index.html` and local tests only, plus documentation. **No new migration or Edge Function deployment is required** beyond 027/028 and the phase-2 functions. Photo settings remain off until a manager explicitly enables them. Leave production requirements off pending the final hosted smoke test.

- In **Templates → Add/Edit routine task**, managers/admins can switch **Photo required** on or off. It applies to new daily snapshots, not existing tasks. Copying templates preserves the setting. **One-off task** creation has the same switch; an existing daily requirement cannot be disabled as a workaround.
- Every live task has a **Photos** control, including read-only submitted tasks and History. Missing evidence opens the panel before individual or bulk Done actions. Photo evidence is optional on tasks without a requirement; Blocked/N/A/Skipped remain available without a photo.
- **Take photo** requests camera capture where supported; **Choose photos** uses the device's picker. Up to three live photos/reservations are allowed per task. The browser handles files up to 30 MiB, resizes to a maximum 1600-pixel side, preserves EXIF orientation and converts to JPEG before the server validates it. HEIC works only where the browser can decode it; otherwise a conversion message is shown. Animated PNG/WebP are rejected.
- Uploads show preparation/verification status. Unconfirmed uploads keep the same ID and bytes in memory for retry and can be discarded. A task is not marked Done automatically after uploading. Closing the panel discards the local retry copy; a server-side reservation/file may still finish and can be refreshed or removed later. No photo bytes or private URLs are saved to localStorage.
- Private images are downloaded through the signed-in Storage client only when **View photo** is pressed. Blob previews are released on close, venue/organisation switch, sign-out/access loss, removal or expiry. Metadata displays uploader, timestamp, expiry and unavailable/deleted states. Refresh failures disable evidence editing until recovered.
- Managers can approve an exemption with a reason or revoke it on an open shift. Submission requires explicitly checking every exemption being used instead of a photo. A reopened revision needs a new exemption approval. Only the uploader or a venue manager can remove an open-shift photo; database rules remain authoritative.
- **Evidence audit** in manager Today and History exposes immutable submission records, including prior revisions/reset tasks and expired-photo metadata. Historical evidence is read-only. **Settings → Organisations → Photo retention** accepts 1–365 whole days (default 30) and changes expiry for new uploads only.

The existing 15-second Today refresh also reloads evidence metadata; the photo panel has an explicit **Refresh evidence** action. Evidence reads are paginated. Local browser tests cover real canvas conversion/orientation, retry identity, limits, exemptions/acknowledgement, removal, expired previews, access changes, history, retention and phone layouts. The demo remains localStorage-backed with its existing behaviour; production-only photo controls are hidden there. Phase 4 below adds photo counts and sign-in-required links to Telegram, without sending image copies.

## Photo evidence — phase 4: notifications and private app links

Implemented locally on `feature/task-photo-evidence`, **not committed, pushed or deployed**. No new database migration, bucket policy or Cron SQL is needed. This phase changes the two notification functions, their shared message helper, and the static frontend.

- Complete/incomplete submission messages include the photo and manager-exemption counts recorded in the immutable **submitted revision**. Expiry or a later reset/reopen does not change that historical count. Legacy submissions without an evidence snapshot say that evidence was not recorded rather than claiming an audited zero.
- Reopen messages show the current unexpired ready-photo count. End-of-day reports include a count and link for each existing shift: a submitted snapshot when submitted, otherwise current evidence. Current counts describe the time the notification was prepared, not an immutable submission.
- Links use the configured app URL plus `#evidence?venue=…&date=…&shift=…&checklist=…&revision=…`. Only submitted links carry a revision. The fragment contains record identifiers, not tokens, image URLs or exemption reasons. The static GitHub Pages path is unchanged.
- A signed-out recipient signs in first; the same link then opens a read-only evidence list for the authorised venue/date/shift. Submitted links stay pinned to that revision, including reset tasks and dates beyond the normal History list. Existing RLS controls all metadata and image reads; a forwarded link grants no access. Invalid/unavailable links show an error, not another shift. Photos still load only on **View photo**. **Back to shift evidence** returns to the linked list.
- Telegram receives text only. No image attachments, public/signed Storage URLs or image bytes are sent. Link previews are disabled using Telegram's [documented preview option](https://core.telegram.org/bots/api#linkpreviewoptions). Evidence summaries/links are retained when long task details are truncated. Recipient preferences and existing idempotency keys are unchanged; database errors are not reported as zero photos.

### Phase-4 rollout (not performed)

1. Publish the phase-3/4 static page to the intended app URL before sending links. Keep photo requirements off until the final hosted checks. Do not deploy these notification changes until migrations 027/028 and the phase-2 services are ready.
2. Set **`DAILYOPS_APP_URL`** under Supabase Edge Function secrets to the full HTTPS page URL, including the GitHub Pages repository path. It must have no credentials, query or fragment, and at most 500 encoded characters. This is a public destination setting, not a privileged credential. The backend never derives it from a request header/body. An absent/invalid setting causes affected notification requests to fail rather than send a broken link.
3. Redeploy the two notification functions sequentially. Existing bot/cron secrets and schedules remain unchanged; there is no need to redeploy upload/cleanup for this phase.

```sh
supabase secrets set DAILYOPS_APP_URL=https://abhishek-b.github.io/DailyOps/ --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy notify-manager --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy end-of-day --project-ref zwebxycbrfwtlmqwxwwe
```

4. Run the [holistic hosted smoke checklist](supabase/functions/upload-task-evidence/README.md#verification-before-production-enablement) against isolated test data. Include actual Telegram delivery, signed-out and already-signed-in links, another-organisation/revoked-access denial, old/reset revisions and expired photos. Confirm submission/exemption counts and both EOD links, no previews/images, existing recipient preferences, delivery audit and retry idempotency. Do not send these tests to operational staff chats. Then enable requirements for the intended production templates.

### Local regression checks

Tests use a temporary PostgreSQL-compatible PGlite database and headless Chrome with mocked Supabase responses. They never contact the live project. PGlite runs the complete migration chain with synthetic Auth identities, authenticated/service roles and minimal Storage metadata tables for policy checks. It does not simulate real image bytes, the Storage API, Supabase Auth, Edge Functions, realtime transport or multi-session PostgreSQL concurrency. A deployed two-session smoke test remains necessary after migration.

Photo evidence tests cover defaults/snapshots, completion and direct-submission bypasses, exemption acknowledgement, cross-organisation/inactive/revoked access, upload reservations, immutable audit, expiry/reopen/reset/removal and restrictive Storage policies alongside a deliberately broad existing policy. Before production enablement, also test actual uploads/downloads/deletion and simultaneous submit-versus-remove/finalize/reset operations against an isolated Supabase test venue. Mutations lock the parent shift; conflicting direct SQL edits can be aborted by PostgreSQL and must be refreshed/retried rather than reported as saved.

With Node.js and Google Chrome installed:

```sh
test_deps=$(mktemp -d)
npm install --prefix "$test_deps" --no-audit --no-fund @electric-sql/pglite@0.5.8 playwright@1.63.0
NODE_PATH="$test_deps/node_modules" node --test tests/*.test.cjs
```

Set `DAILYOPS_SCREENSHOT_DIR` to an existing temporary directory to capture the desktop/phone Today and Settings screens. Test dependencies are separate from the static app.

Notification handler tests use fake credentials and mocked Supabase/Telegram HTTP; they send no real messages. Run them with Deno:

```sh
deno test --no-lock --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_PUBLISHABLE_KEY,SUPABASE_SERVICE_ROLE_KEY,TELEGRAM_BOT_TOKEN,DAILYOPS_CRON_SECRET,DAILYOPS_APP_URL tests/notifications.test.ts
deno check --no-lock supabase/functions/notify-manager/index.ts supabase/functions/end-of-day/index.ts
```

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

### Username-first login

The login form asks for a username and password. The frontend uses the single constant `USERNAME_AUTH_DOMAIN = "dailyops.invalid"` in `index.html`: entering `jsmith` signs in through Supabase Auth as `jsmith@dailyops.invalid`. Usernames are trimmed, lowercased, must be 3–32 characters, must start and end with a letter or number, and may contain only letters, numbers, dots, underscores, and hyphens without consecutive separators. Invalid usernames are rejected in the browser.

Existing administrator or test accounts remain compatible: any login identifier containing `@` is passed through as an existing Supabase Auth email address. The generated synthetic email is not shown in normal login errors. This is an Auth naming convention, not a second user system; passwords remain managed only by Supabase Auth.

Active platform admins can create staff from **Team → Create user**. The secure Edge Function creates the ordinary Auth user with internal email `jsmith@dailyops.invalid`, provisions the selected organisation membership, and leaves venue access unassigned for employees. New users do not receive an email because synthetic identities cannot receive mail. Do not create public signup or put privileged Auth credentials in the browser.

## Supabase organisation and venue loading

After authentication, the app reads the signed-in user's rows from `public.organisation_members` and loads the related `public.organisations` rows. For ordinary users, the `organisation_members.role` value (`manager` or `employee`) determines the manager or employee UI for the selected venue. An active profile with `platform_role = 'admin'` is a separate platform-level capability that can manage all organisations/venues through RLS; it does not change ordinary organisation roles.

The app then queries `public.venues`. RLS is the access boundary: ordinary managers receive venues in organisations they manage, active platform admins receive all organisations/venues through the deployed helper functions, and employees receive only venues allowed by the deployed membership policies. The organisation picker exposes every organisation membership available to the signed-in user, with the organisation role shown for context; it does not hide employee-only organisations when the same user manages another organisation. The selected organisation and real venue IDs are remembered in user-specific local preferences and restored only if the user still has access. The effective manager/employee UI is recalculated from the selected venue's organisation, so a user can be a manager in one organisation and an employee in another during the same session.

Team and roster data now load from Supabase. Managers see every member of the selected organisation regardless of venue; managers of multiple organisations and platform admins can select `All organisations` to see the combined staff and venue scope for their manager organisations. Shared employees remain visible with each organisation membership and their weekly assignments are shown across all accessible venues. The Team page is focused on People and access; weekly staffing lives in the dedicated **Roster** page with Week and Day views over the same `roster_assignments` rows. Managers can manage profile active state and `venue_members` access, and plan Opening/Closing Shift assignments across a seven-day window for every eligible venue in their manager scope. Managers may roster any active employee in the venue's organisation even when that employee does not have permanent `venue_members` access; removing permanent venue access therefore does not erase future roster assignments. Deactivating an employee or removing their organisation membership still clears relevant future roster and cover rows while retaining historical records. Roster conflicts are advisory warnings, while the exact duplicate venue/employee/date/operation remains blocked by the database unique constraint. Employees load only their permitted venues, can view their weekly roster across those venues, and can confirm a current self-cover action; confirmation adds the assignment and creates an in-app manager alert plus optional server-side Telegram delivery without an approval step. The older simulated notification inbox remains local/deferred. Real venue rows are still mapped to temporary local operations contexts only for legacy demo screens, so real Supabase IDs do not overwrite or get persisted into the old demo state.

## Supabase team, venue memberships, and roster

`auth.users` is the login identity, `profiles` is the app profile, `organisation_members` supplies the `manager`/`employee` organisation role, `venue_members` grants employee venue access, and `roster_assignments` records a user assigned to a venue/date/shift. RLS enforces these boundaries; the UI is not the security boundary.

The browser does not use Auth Admin APIs. An active platform admin can create a new Auth user through the protected `create-user` Edge Function, then manage that profile's complete organisation/platform access draft through the protected `manage-user-access` Edge Function. Organisation role is stored separately on each `organisation_members` row, so one user may be an employee in one organisation and a manager in another. Managers can assign or remove employee venue access only within organisations they manage, while platform admins can manage organisation membership and platform role across the global profile directory. Venue access remains separate from user creation; employees start without venue access. Users removed from their final organisation remain active profiles and remain discoverable by platform admins.

Organisation managers cannot add, remove, or change organisation memberships through browser table writes. They can continue using the existing venue controls for employee members in their managed organisation. A manager target shows inherited access to all venues; an employee target has explicit per-venue controls. Removing organisation access also clears that organisation's venue access and current/future roster and cover assignments while preserving historical attribution. Removing only permanent venue access does not clear future roster assignments.

### Team access editing

Migration `021_access_hardening.sql` records the protected master-administrator profile by UUID, adds database guards for its active/platform-admin state and organisation/venue memberships, and replaces the organisation-access RPC with a caller-aware service-role-only signature. Apply it only after migrations `001`–`020`; do not edit those earlier migrations. Deploy the updated `manage-user-access` function after the migration so it passes the verified caller UUID.

While a user is signed in, the frontend revalidates the small access/identity state on profile or organisation-membership Realtime events, tab visibility/focus, and a 45-second timer. A denied manager operation also triggers a fail-closed recheck. The database helpers use current `profiles` and `organisation_members` rows, so a stale browser session does not retain backend manager permissions after a downgrade. If the account becomes inactive or loses all organisation/venue access, operational data is cleared and the existing access state is shown.

The protected master administrator is resolved once by migration 021 from the existing Auth email and stored internally as a UUID. Other admins and managers see the account as protected and cannot change its access, roles, activation, or venue memberships. The master account remains an ordinary `platform_role = 'admin'` account; no new secret or frontend credential is required.

The platform-admin Team People view opens a local access draft. Organisation membership, per-organisation role, employee venue access, active state, and platform role changes remain local until **Save changes**. Closing a dirty draft requires explicit discard confirmation; the save calls the authenticated `manage-user-access` Edge Function with the desired final state, which invokes the service-role-only atomic `admin_apply_user_access(...)` RPC. Platform-role changes are restricted to active platform admins, self-demotion is blocked, and migration 021's protected-master guards remain authoritative. The Team page's weekly planner is under a separate **Roster** view so the People directory stays compact.

Migrations `supabase/migrations/006_restrict_venue_member_reads.sql`, `007_scope_team_and_roster_writes.sql`, `008_grant_can_manage_profile_execute.sql`, `009_platform_admin_access.sql`, and `010_add_shift_cover_requests.sql` narrow employee membership reads, scope manager-created venue memberships and roster assignments to active employees inside the target venue organisation, enable manager profile active-state updates, give active platform admins global management access through RLS helpers, and add venue-scoped in-app cover alerts. Apply those after migrations `001` through `005`; apply `020_user_organisation_access.sql` after migrations `011` through `019`, then `021`, `022`, `023`, and `024` in order.

## Supabase recurring shift templates

In Supabase mode, managers load and manage `public.checklist_templates` and `public.template_tasks` for the selected venue. The deployed RLS policies allow managers to insert, update, reorder, and delete only templates/tasks belonging to venues they manage; employees can read templates where their venue access permits it but do not receive template-management controls.

If a manager opens a venue with no remote Opening or Closing template yet, the browser performs a one-time compatibility bootstrap from that venue's existing local/demo routine definitions. It creates the missing remote template rows and tasks without overwriting existing remote templates. After that, Supabase is the source of truth. Template changes affect future daily operations; today's task rows remain snapshots. “Apply to today” adds missing tasks by stable `template_task_id`, preserves task state and one-off tasks, and does not delete existing daily tasks.

## Supabase today's operation loading

For each accessible real venue, the app loads the venue's current local date using its configured IANA timezone, then loads `public.daily_checklists` rows for `list_type = open` and `list_type = close` and their `public.daily_tasks`. If either row is missing, `ensure_daily_checklists(uuid, date)` creates it and copies the active Supabase template tasks as snapshots. Active employees with venue access may initialise only the venue's current local date; managers retain their existing date permissions. Repeated page loads and simultaneous employee logins are idempotent because of the database unique key `(venue_id, work_date, list_type)`. A manager is required only when an active Opening or Closing template is missing.

Task changes use the schema's existing `pending`, `done`, `blocked`, `na`, and `skipped` values. Completion writes `completed_by` and `completed_at`; reopening clears those fields. Notes, reasons, and shift submission metadata are written to Supabase. Managers can add and remove `source = adhoc` one-off tasks, while routine tasks remain non-deletable. Re-apply routine tasks reads the Supabase template, adds only missing routine snapshots, and preserves existing state and one-off tasks. In Supabase mode, notification delivery is no longer simulated in the browser.

Managers can use **Reset today** to perform a destructive, atomic reset of both shifts for the selected venue. A database RPC determines the venue-local date, preserves the daily operation IDs, advances their notification revisions, removes all current task snapshots and rebuilds them from the active templates. One-off tasks, progress, notes, reasons and submission state are cleared; notification audit history is retained and the reset itself sends no Telegram notification.

## Supabase historical operations and CSV

In normal Supabase mode, History queries recent prior `daily_checklists` rows for the selected venue, then loads their `daily_tasks`, roster assignments, and referenced `profiles`. The UI is read-only and uses stored daily task snapshots, so later template edits do not rewrite historical records. Summary metrics and completion attribution are calculated from those Supabase rows. Export CSV downloads the currently loaded venue history with organisation, venue, date, shift, task, critical/source, status, completion and submission attribution, reasons, and notes. A failed query shows an error instead of falling back to local demo history.

## Supabase Realtime

Apply `supabase/migrations/011_enable_daily_operations_realtime.sql` after migrations `001` through `010`. It adds only `daily_checklists`, `daily_tasks`, and `roster_assignments` to the standard `supabase_realtime` publication; it does not change RLS or grant table access.

If the migration reports that `supabase_realtime` is not present, open **Supabase > Database > Publications**, select `supabase_realtime`, and add these three public tables. Do not enable unrelated tables. If the dashboard uses a **Realtime** table-settings screen instead, enable Realtime for the same three tables. The frontend continues to work through normal Supabase queries if Realtime is unavailable.

Migration `021_access_hardening.sql` additionally adds `profiles`, `organisation_members`, and `venue_members` to that same publication for signed-in access revalidation. These access subscriptions are filtered to the current user's rows; they do not replace RLS or expose global access data. If publication editing is being done manually, enable those three tables as well.

The browser subscribes only to the selected venue and today's two operation IDs. An event triggers an authoritative Supabase refetch, and the channel is removed when the venue, tab, session, or access context changes. A small selected-venue/day refetch timer covers deletion events, which cannot be column-filtered by Postgres Changes without broadening the subscription. Realtime is not used for notifications or historical/template screens in this phase.

## Supabase production Telegram notifications and scheduled EOD

Apply [`supabase/migrations/012_add_notification_delivery_and_timezone.sql`](supabase/migrations/012_add_notification_delivery_and_timezone.sql), [`supabase/migrations/013_add_telegram_notification_recipients.sql`](supabase/migrations/013_add_telegram_notification_recipients.sql), [`supabase/migrations/014_fix_notification_service_role_grants.sql`](supabase/migrations/014_fix_notification_service_role_grants.sql), [`supabase/migrations/015_notification_workflow_and_admin_cutoff.sql`](supabase/migrations/015_notification_workflow_and_admin_cutoff.sql), [`supabase/migrations/016_incomplete_submission_notifications.sql`](supabase/migrations/016_incomplete_submission_notifications.sql), [`supabase/migrations/017_reset_today_operations.sql`](supabase/migrations/017_reset_today_operations.sql), [`supabase/migrations/018_platform_admin_user_provisioning.sql`](supabase/migrations/018_platform_admin_user_provisioning.sql), [`supabase/migrations/019_fix_create_user_compensation.sql`](supabase/migrations/019_fix_create_user_compensation.sql), [`supabase/migrations/020_user_organisation_access.sql`](supabase/migrations/020_user_organisation_access.sql), [`supabase/migrations/021_access_hardening.sql`](supabase/migrations/021_access_hardening.sql), [`supabase/migrations/022_team_access_editor.sql`](supabase/migrations/022_team_access_editor.sql), [`supabase/migrations/023_relax_roster_venue_eligibility.sql`](supabase/migrations/023_relax_roster_venue_eligibility.sql), and [`supabase/migrations/024_allow_employee_daily_initialisation.sql`](supabase/migrations/024_allow_employee_daily_initialisation.sql), in that order after migrations `001` through `011`.

Migration 012 adds venue IANA `timezone` (existing venues default to `Australia/Sydney`), notification retry/idempotency fields, and service-role-only claim/finalize/fail functions. Migration 013 adds the venue-scoped `venue_notification_recipients` table, recipient RLS, the `telegram` audit channel, and per-recipient claim/idempotency support. Migration 014 records service-role reads for recipients and profiles. Migration 015 records the required service-role reads for venues, daily operations, and shift-cover validation; adds submit/reopen lifecycle revision fields; adds optional covered-person and recipient preference fields; and protects cutoff/timezone edits at the database boundary. Migration 016 adds incomplete-submission notifications. Migration 017 adds the manager-only atomic Reset Today RPC. Migration 018 adds the service-role-only `provision_created_user(...)` RPC. Migration 019 corrects synthetic-email validation and adds the service-role-only `cleanup_failed_created_user_profile(uuid)` compensation RPC. Migration 020 adds the service-role-only `admin_manage_user_organisation_access(...)` RPC, removes direct authenticated organisation-membership writes, protects browser platform-role changes, and tightens venue-membership writes. Migration 022 adds the service-role-only `admin_apply_user_access(...)` RPC for atomic final-state Team access saves, including platform-role changes. Migration 023 changes manager roster eligibility to active same-organisation employees without requiring permanent venue membership and preserves future roster rows when permanent venue access changes. Migration 024 permits employees with venue access to lazily create missing daily snapshots for the venue's current local date. Chat IDs are not stored in `notification_events`.

The Edge Functions are [`notify-manager`](supabase/functions/notify-manager/index.ts) for authenticated submit-complete/reopen/cover/test requests, [`end-of-day`](supabase/functions/end-of-day/index.ts) for the scheduled cutoff processor, and [`create-user`](supabase/functions/create-user/index.ts) for active platform-admin-only Auth user creation. Notification functions resolve recipients from Supabase and use the shared Telegram sender. The browser sends only visible IDs or create-user form values; it never sends a service key, Chat ID, bot token, Auth UUID, or `created_by` identity. If Auth creation succeeds but provisioning fails, `create-user` removes the trigger-created profile through the service-role-only compensation RPC before attempting Auth deletion.

The notification lifecycle is submit-gated. Completing the final task shows **Ready to submit** but does not send Telegram. A complete Submit Shift sends one concise `list-complete` event per enabled recipient. An incomplete Submit Shift sends one actionable `list-incomplete` event to recipients with **Incomplete submissions** enabled, including outstanding task statuses, reasons and notes. The detailed report remains the End-of-Day summary. Reopening a submitted shift increments the database-managed `notification_revision` and sends one `list-reopened` event; a later submission uses that revision in its idempotency key and is labelled as a resubmission. Shift-cover delivery uses `shift-cover:<cover_request_id>:<recipient_id>` and can identify the person being covered for.

### Deploy functions and set secrets

From the repository root, after installing/authenticating the Supabase CLI:

For an existing deployment upgrading to photo evidence, use the [phase-4 rollout](#phase-4-rollout-not-performed) instead of replacing existing bot/cron secrets. Current notification code also requires migration 027 and the updated frontend.

```sh
supabase login
supabase link --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy notify-manager --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy end-of-day --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy create-user --project-ref zwebxycbrfwtlmqwxwwe
supabase functions deploy manage-user-access --project-ref zwebxycbrfwtlmqwxwwe
supabase secrets set \
  TELEGRAM_BOT_TOKEN=replace-with-the-token-from-BotFather \
  DAILYOPS_CRON_SECRET=replace-with-a-long-random-secret \
  DAILYOPS_APP_URL=https://abhishek-b.github.io/DailyOps/ \
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

1. Apply migrations 012 through 018 in order, deploy `notify-manager`, `end-of-day`, and `create-user`, add your own Telegram Chat ID under Settings, and set `notify_complete = true` and `notify_end_of_day = true` for the venue. Enable the recipient preferences you want.
2. Use the recipient's **Test** button. Confirm the fixed Telegram test message arrives and a `test` row becomes `sent` in `notification_events`.
3. Complete the final task in one shift. Confirm no Telegram is sent and the UI says the shift is ready to submit. Submit the shift, then confirm one concise `list-complete` row per enabled recipient becomes `sent` and exactly one Telegram message arrives per recipient.
4. Reopen the submitted shift. Confirm one `list-reopened` event/message. Submit with at least one incomplete task and a reason/note; confirm one `list-incomplete` event/message per recipient with Incomplete Submissions enabled. Change or complete the task and submit again; confirm one new completion event/message labelled as a resubmission. Repeat browser actions or use two clients; revision/recipient idempotency must prevent duplicates.
5. Confirm Shift Cover is enabled for a recipient, have an employee cover a shift for a rostered person, and confirm one `shift-cover` event/message identifies both people. Disable the preference and confirm no new Telegram is sent.
6. After migration 025, change a venue's timezone/cutoff as its manager and as a platform admin, then refresh. Confirm both persist. Employee and cross-organisation manager writes must fail; ordinary edits must not move venue ownership.
7. Set a temporary venue `cutoff_time` a few minutes ahead, wait for the 15-minute schedule, and confirm one `end-of-day` row/message per enabled recipient. Restore the normal cutoff (Braddon's production value is `23:30`) and re-run Cron; successful events must not send again.
8. Temporarily use an invalid Chat ID or disabled/unstarted recipient. Confirm that recipient has a `failed` event while valid recipients still receive their messages. Fix the recipient and retry before the five-attempt cap.
9. Open Alerts in the manager UI to see Telegram sent, pending, and failed delivery status. Employees cannot query manager notification events or recipient Chat IDs through the existing RLS policies.
10. Create a test Auth user such as `jsmith@dailyops.invalid` through **Team → Create user**, then sign in using `jsmith`. Confirm leading/trailing whitespace and uppercase input normalize correctly, invalid username characters are rejected, wrong passwords fail generically, and an existing administrator can still sign in with their full email address.
11. For Reset Today, create current template tasks A/B/C, add one-off D, complete A/B and add notes, then reset. Confirm only pending A/B/C remain and submission state is cleared. Change the template to A/C/E, reset again, and confirm the result is exactly A/C/E. Submit before and after a reset and confirm the second legitimate completion notification is new while the old audit row remains.
12. As a platform admin, create an employee and confirm no venue membership exists, then assign a venue in Team. Create an organisation manager and a second platform admin. Confirm a manager, employee, and unauthenticated browser cannot successfully invoke `create-user`.

### Team access editor

After applying migration 022 and redeploying `manage-user-access`, Team defaults to **People**. Open a person to edit a local draft of active state, platform access, organisation roles, memberships, and employee venue access. Toggle several venues and organisations, close the modal, and confirm the discard warning; then save and verify all changes persist together. Open the separate **Roster** tab to plan the same assignments in Week or Day view, use the venue filter and assignment drawer, and test Copy previous week. A normal platform admin cannot demote their own account, and the protected master administrator remains read-only to other administrators.

To test locally, open the app with VS Code Live Server in two browser contexts, sign in with users who can access the same venue, and follow the two-client test sequence in `docs/PROJECT_STATUS.md`. A refresh remains a valid recovery path if a browser sleeps or loses its connection.

Before testing one-off deletion, apply `supabase/migrations/005_allow_managers_delete_adhoc_daily_tasks.sql` in the Supabase SQL Editor. It adds only a manager-scoped delete policy for `source = 'adhoc'` daily tasks.

### Create the first manager account

Create the first bootstrap administrator as an ordinary Supabase Auth user under **Authentication > Users**. The existing full email address can be used at login. The deployed profile trigger should create the matching `public.profiles` row; then set `platform_role = 'admin'` and add the first organisation manager using an appropriately protected SQL Editor workflow. After that, use **Team → Create user** for normal staff creation. Do not put an admin or service-role key in the frontend.

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

### Responsive browser view

DailyOps defaults to **Automatic** view. The browser uses its device pointer/touch characteristics and viewport to choose the responsive mobile or desktop layout. On a real phone, the app uses the full browser viewport rather than rendering a phone-shaped frame inside the page. The view choice is local to the browser and does not affect Supabase data.

The phone/desktop button in the top bar remains available for testing: on automatic mode it previews the opposite layout, and clicking it again returns to automatic detection. Existing `dailyops.mobile` preferences are migrated to the new local view preference automatically.

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

- ordinary manager-side Auth-user creation and arbitrary email-based Auth assignment; user creation is intentionally restricted to active platform admins through the `create-user` Edge Function;
- SMS, push notifications, and email delivery for shift-cover requests;
- roster CSV import;
- automated Auth-user invitation/organisation assignment;
- Storage, offline support, and PWA behaviour.

The existing localStorage implementation remains available as the compatibility/demo repository while those adapters are developed incrementally.
