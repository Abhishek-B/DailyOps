# notify-manager Edge Function

Future responsibility:
- receive a trusted notification event
- fetch required venue/checklist details server-side
- send email through Resend/Postmark/etc.
- optionally send SMS through a provider
- record delivery status in `notification_events`

Do not put provider secrets in `index.html`.
