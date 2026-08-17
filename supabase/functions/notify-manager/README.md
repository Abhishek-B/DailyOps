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

Required function secret:

- `TELEGRAM_BOT_TOKEN`

The function also relies on the Supabase-provided service role and the
service-role SELECT grants recorded in migrations 014 and 015. No new secret
is required.

The function is deployed with `verify_jwt = false` because the shared handler
validates the user bearer token itself. This allows the separate scheduled
function to use its private scheduler header; ordinary browser calls still
require a valid signed-in Supabase user.
