# end-of-day scheduled function

This function is called by Supabase Cron every 10–15 minutes. It authenticates
the request with `DAILYOPS_CRON_SECRET`, reads each venue's IANA `timezone` and
`cutoff_time`, and processes only venues whose local cutoff has passed.

It reads the stored `daily_checklists` and `daily_tasks` snapshots, resolves
enabled Telegram recipients with End of Day enabled, sends each recipient a
concise summary through the shared Telegram sender, and records each result in
`notification_events`. The per-recipient
`end-of-day:<venue_id>:<date>:<recipient_id>` idempotency key prevents repeated
reports. Failed deliveries are retained for retry, with the database claim
function capping automated attempts at five.

Required function secrets:

- `TELEGRAM_BOT_TOKEN`
- `DAILYOPS_CRON_SECRET`

This first version processes existing daily operation rows. It does not create
an operation with no activity merely to send an empty report.
