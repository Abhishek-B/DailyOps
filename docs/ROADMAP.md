# Roadmap

## Now
- Stable single-file local demo
- Refined DailyOps visual theme
- Multi-venue workflows
- Local sample data

## Backend MVP
- Supabase Auth
- Organisation / venue membership
- Persistent recurring shift-task templates, rosters, daily operations and task history
- RLS policies
- Realtime completion updates (implemented for the selected venue/current date)

## Notifications
- Immediate Telegram messages when a shift is fully complete, with per-venue recipients (implemented through `notify-manager`)
- Scheduled venue end-of-day Telegram report (implemented through `end-of-day` + Supabase Cron)
- Manager Telegram recipient configuration and delivery audit/status in the Alerts page (implemented)
- SMS, push, email fallback, optional CSV attachment, and cover-request email delivery

## Later
- CSV roster importer UI
- File/photo evidence on tasks
- organisation branding/logo upload
- audit trail
- analytics dashboard
- PWA/offline support if needed
