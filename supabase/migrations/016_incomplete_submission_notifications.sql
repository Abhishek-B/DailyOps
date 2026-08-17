-- Add actionable Telegram notifications for submitted shifts with incomplete tasks.
-- Existing recipients receive this notification by default; managers can disable
-- it per recipient in DailyOps Settings.

alter table public.venue_notification_recipients
  add column if not exists notify_incomplete_submission boolean not null default true;

alter table public.notification_events
  drop constraint if exists notification_events_kind_check;

alter table public.notification_events
  add constraint notification_events_kind_check
  check (kind in (
    'list-complete',
    'list-incomplete',
    'list-reopened',
    'shift-cover',
    'end-of-day',
    'test'
  ));
