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
- `DAILYOPS_APP_URL` — full HTTPS static page URL, including its repository path, without credentials/query/fragment (maximum 500 encoded characters).

Phase 4 adds photo evidence summaries and sign-in-required links for each
existing shift. Submitted shifts use immutable photo/exemption counts from
their current submitted revision; unsubmitted shifts use current unexpired
ready-photo counts. Earlier-submission counts are not substituted for an open
shift. Both links survive truncation of long task details. Images, Storage URLs
and tokens are never attached, and Telegram previews are disabled.

This uses the evidence SELECT grants in migration 027 and adds no migration or
schedule change. Missing app URL configuration or evidence-query failures are
recorded as failed, retryable reports, not zero-photo summaries. Publish the
updated static frontend, set the app URL, and redeploy this function and
`notify-manager` sequentially; see the [phase-4 rollout](../../../README.md#phase-4-rollout-not-performed).
Phase-4 deployment and hosted smoke checks have not been performed.

This first version processes existing daily operation rows. It does not create
an operation with no activity merely to send an empty report.

Migration 015 records the service-role SELECT grants required to read venues,
daily operations, daily tasks, and roster data. It also leaves the existing
Cron schedule unchanged: future runs read the current `venues.cutoff_time` and
`venues.timezone`, including values changed by an active platform admin in
DailyOps Settings. Database query failures are returned as server failures and
are not reported as an empty/no-recipient result.
