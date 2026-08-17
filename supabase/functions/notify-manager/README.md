# notify-manager Edge Function

This function accepts either a `list-complete` request containing a visible
`checklist_id`, or a fixed test request containing a visible venue ID and a
configured recipient record ID. It verifies the caller with the caller's
RLS-scoped client, resolves Telegram recipients from the database, and never
accepts a browser-supplied Chat ID, destination, bot token, or message body.

Shift-complete delivery is independent per venue recipient. The
`venue_notification_recipients` ID is part of the idempotency key, so one
recipient's success or failure cannot suppress another recipient's delivery.

Required function secret:

- `TELEGRAM_BOT_TOKEN`

The function is deployed with `verify_jwt = false` because the shared handler
validates the user bearer token itself. This allows the separate scheduled
function to use its private scheduler header; ordinary browser calls still
require a valid signed-in Supabase user.
