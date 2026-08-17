# end-of-day scheduled function

This function is called by Supabase Cron every 10–15 minutes. It authenticates
the request with `DAILYOPS_CRON_SECRET`, reads each venue's IANA `timezone` and
`cutoff_time`, and processes only venues whose local cutoff has passed.

It reads the stored `daily_checklists` and `daily_tasks` snapshots, sends a
manager summary through the shared Resend delivery code, and records the result
in `notification_events`. The `end-of-day:<venue_id>:<date>` idempotency key
prevents repeated reports. Failed deliveries are retained for retry, with the
database claim function capping automated attempts at five.

This first version processes existing daily operation rows. It does not create
an operation with no activity merely to send an empty report.
