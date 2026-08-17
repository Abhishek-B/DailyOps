# notify-manager Edge Function

This function accepts only a `list-complete` request containing a visible
`checklist_id`. It verifies the caller with the caller's RLS-scoped client,
loads the venue recipient and task state with the service role, and sends the
configured manager email through Resend. It never accepts a browser-supplied
recipient, subject, or message.

`notification_events.idempotency_key` and Resend's `Idempotency-Key` prevent
duplicate sends when multiple clients report the same completed shift.

Required function secrets:

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- optional `RESEND_FROM_NAME`

The function is deployed with `verify_jwt = false` because the shared handler
validates the user bearer token itself. This allows the separate scheduled
function to use its private scheduler header; ordinary browser calls still
require a valid signed-in Supabase user.
