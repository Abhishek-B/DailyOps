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
- Immediate manager email when a shift is fully complete (implemented through `notify-manager` + Resend)
- Scheduled venue end-of-day report (implemented through `end-of-day` + Supabase Cron)
- Manager delivery audit/status in the Alerts page (implemented)
- Optional CSV attachment, SMS, push, and cover-request email delivery

## Later
- CSV roster importer UI
- File/photo evidence on tasks
- organisation branding/logo upload
- audit trail
- analytics dashboard
- PWA/offline support if needed
