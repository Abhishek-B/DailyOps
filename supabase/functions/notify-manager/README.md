# notify-manager Edge Function

This function accepts an authenticated `list-complete` request after a shift
has been submitted, derives whether the stored tasks are complete or
incomplete, a `list-reopened` request after a submitted shift is
reopened, a `shift-cover` request containing a visible cover-request ID, or a
fixed test request containing a visible venue ID and configured recipient
record ID. It verifies the caller with the caller's RLS-scoped client, derives
the operation, participants, and Telegram recipients from the database, and
never accepts a browser-supplied Chat ID, destination, bot token, or message
body.

Complete-submission, incomplete-submission, reopen, and shift-cover delivery is
independent per venue recipient. The recipient ID is part of each idempotency
key. Complete and incomplete submission keys use the database-managed
checklist notification revision, so a resubmission after reopen is a new event
while repeated requests remain safe. Incomplete submissions include stored
task statuses, reasons, and notes and use the recipient's
`notify_incomplete_submission` preference.

Required function secrets/settings:

- `TELEGRAM_BOT_TOKEN`
- `DAILYOPS_APP_URL` — full HTTPS static page URL including the GitHub Pages repository path, without credentials/query/fragment (maximum 500 encoded characters).

The function also relies on the Supabase-provided service role and the
service-role SELECT grants recorded in migrations 014, 015 and 027.

Phase 4 appends photo and exemption counts from the immutable submission
revision, plus a sign-in-required app link. Reopened shifts use current
ready/unexpired photo counts and a current-shift link instead. Legacy
submissions without snapshots are labelled as not recorded. No photos,
Storage URLs or tokens go to Telegram, and previews are disabled. Long task
details are truncated before the evidence footer so the link remains intact.
Missing app URL configuration or an evidence-query failure returns 500 before
delivery; it does not send a broken link or claim zero photos.

These changes require redeploying this function after publishing the updated
frontend and setting `DAILYOPS_APP_URL`; they require no new migration beyond
the existing photo feature. See the [phase-4 rollout](../../../README.md#phase-4-rollout-not-performed).
The implementation is local; phase-4 deployment/live delivery checks have not
been performed. The fixed Test and shift-cover messages remain unchanged.

The function is deployed with `verify_jwt = false` because the shared handler
validates the user bearer token itself. This allows the separate scheduled
function to use its private scheduler header; ordinary browser calls still
require a valid signed-in Supabase user.
