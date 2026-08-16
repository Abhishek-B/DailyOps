# end-of-day scheduled function

Future responsibility:
- run on a schedule
- find venues whose cutoff has passed and whose report has not been sent
- compose a summary from the database
- optionally generate CSV content
- call the notification function/provider
- mark the report as sent idempotently
