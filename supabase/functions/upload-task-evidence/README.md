# Photo evidence: upload and cleanup deployment

Phase 2 contains `upload-task-evidence`, `cleanup-task-evidence`, bucket setup and migration 028. It does not change the frontend or Telegram messages. Phase 3 adds the frontend locally without another migration/deployment. Phase 4 adds notification counts and sign-in-required links locally; its [separate rollout](../../../README.md#phase-4-rollout-not-performed) requires publishing the updated page, setting `DAILYOPS_APP_URL` and redeploying the two notification functions, not upload/cleanup. Keep production photo requirements off until deployment and hosted smoke checks are complete. The user has requested one holistic hosted smoke test after implementation; the checks below remain the acceptance checklist.

## 1. Apply the migration

After 027, apply [028_photo_evidence_cleanup_retries.sql](../../migrations/028_photo_evidence_cleanup_retries.sql) in the Supabase SQL Editor. It adds cleanup retry fields/index and service-only RPCs for failed uploads, cleanup failures and late-arriving objects. It does not change migration 027, create the bucket, schedule work or remove bytes.

## 2. Provision private Storage

From the repository root, first run the safe default (no credentials needed and no project changes):

```sh
deno run --no-lock scripts/setup-task-evidence-storage.ts
```

To apply, supply `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) through a trusted local shell environment, then run:

```sh
deno run --no-lock --allow-env --allow-net scripts/setup-task-evidence-storage.ts --apply
```

Never commit these values or put them in `index.html`, browser configuration, screenshots or logs. The script creates only `task-evidence`, or restricts an existing private bucket to the settings below. It refuses an unexpectedly public bucket; investigate its contents/access before making it private yourself. Repeating successful setup makes no changes.

Alternatively configure these exact values in the Storage dashboard:

| Setting | Value |
|---|---|
| Bucket name/ID | `task-evidence` |
| Public | Off |
| Maximum file size | `5242880` bytes (5 MiB) |
| Allowed MIME types | `image/jpeg` only |

Migration 027 already defines Storage RLS. Do not add broad public/upload/delete policies. Pending raw uploads cannot be viewed or used as evidence; only the validator can mark them ready. The official upload endpoint stores only its re-encoded JPEG output. There are no browser overwrite/delete rights.

## 3. Prepare and deploy the functions

Install Deno and Supabase CLI, and start Docker for local bundling. From the repository root:

```sh
deno run --no-lock --allow-read --allow-write=supabase/functions/_shared/photo-decoder scripts/prepare-photo-decoder.ts
supabase functions deploy upload-task-evidence --project-ref YOUR_PROJECT_REF --use-api=false
supabase functions deploy cleanup-task-evidence --project-ref YOUR_PROJECT_REF --use-api=false
```

The preparation script copies the JS/types/licences from pinned `@imagemagick/magick-wasm@0.0.43` and compresses only its x86 WASM binary into the ignored `_shared/photo-decoder/` directory. `supabase/config.toml` includes that compressed binary and licences as static assets. The function decompresses it locally once per worker; it does not fetch a decoder at request time. Do not commit generated assets. Re-run preparation before deployment from a fresh checkout. This is a backend packaging step, not a frontend build.

Use Docker-backed CLI bundling, not the Dashboard editor or `--use-api`: Supabase documents static-asset deployment through local bundling and different bundle limits. See [WASM bundling](https://supabase.com/docs/guides/functions/wasm) and [function limits](https://supabase.com/docs/guides/functions/limits). The whole npm package contains two large WASM binaries, so importing it directly from the runtime would unnecessarily inflate the bundle.

Both functions have `verify_jwt = false` in config intentionally. Upload verifies the user's Bearer token with Supabase Auth `getUser`, then reserves/uploads as that user and finalises through a service-only RPC. Cleanup requires `x-dailyops-cron-secret`; it does not accept an ordinary user token as scheduler authority. Supabase supplies the server-side URL/API keys. No service key is returned to the browser.

Reuse the existing `DAILYOPS_CRON_SECRET` used by `end-of-day`. The function secret and Vault's `dailyops_cron_secret` must match. Do not replace or rotate one independently: that would break EOD delivery. If scheduling has never been configured, use the existing root README's Vault/secret setup first.

## 4. Add the separate cleanup schedule

With `pg_cron`, `pg_net` and Vault already enabled, run this in the SQL Editor. It reuses existing Vault entries and touches only the new photo-cleanup job, not `dailyops-end-of-day`:

```sql
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'dailyops_project_url')
    or not exists (select 1 from vault.decrypted_secrets where name = 'dailyops_cron_secret') then
    raise exception 'Configure the existing DailyOps Vault URL and scheduler secret first';
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'dailyops-photo-evidence-cleanup';
end;
$$;

select cron.schedule(
  'dailyops-photo-evidence-cleanup',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'dailyops_project_url') || '/functions/v1/cleanup-task-evidence',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dailyops-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dailyops_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);
```

Each run queues up to 500 expired/abandoned records, requeues up to 100 known deleted paths with late-arriving Storage objects, and attempts up to 50 due deletions. It stops starting new deletes after roughly 50 seconds. Paths come only from the database, never request input. The worker calls Storage removal first, then confirms deletion only once Storage metadata is absent. It never SQL-deletes `storage.objects`.

Failures keep the row queued with an attempt count, timestamp, safe error code and exponential retry delay capped at one hour. A partial failure returns HTTP 503. Inspect HTTP results/function logs, not just Cron's successful SQL invocation. Monitor `batch_full`/`deferred` responses and the queue below; increase schedule frequency if the queue consistently grows. Concurrent runs are retry-safe, but can duplicate removal attempts.

```sql
select state, count(*) as photos, min(deletion_requested_at) as oldest_requested,
  max(cleanup_attempts) as max_attempts
from public.task_evidence
group by state;

select id, cleanup_attempts, cleanup_last_attempt_at, cleanup_next_attempt_at, cleanup_last_error
from public.task_evidence
where state = 'delete_pending'
order by cleanup_next_attempt_at
limit 50;
```

The default 30-day retention comes from the organisation setting at finalisation. Expiry immediately denies normal downloads and use as new completion evidence; physical bytes are removed on a later successful cleanup. Changing retention does not rewrite existing expiry dates. Audit rows/submission snapshots remain, including uploader and expiry/deletion times. Removal, reset and abandoned uploads use the same queue. Disabling Cron does not restore access to expired photos, but does prevent physical cleanup.

## Upload API contract for phase 3

`POST /functions/v1/upload-task-evidence?task_id=<uuid>&evidence_id=<uuid>`

- Headers: `Authorization: Bearer <user access token>`, `apikey: <public project key>`, and `Content-Type: image/jpeg`, `image/png`, `image/webp` or `application/octet-stream`.
- Body: raw image bytes, not multipart or JSON. Maximum 5 MiB, 4,000,000 pixels, 4096 pixels per side. Actual decoding is mandatory; a MIME label/extension alone is insufficient. Animated images, SVG, PDF, GIF and raw HEIC are rejected.
- Phase 3 should resize on-device to a maximum 1600-pixel side, preserve orientation and encode JPEG before sending. Camera/gallery selection is a frontend concern; where HEIC cannot be decoded on-device, show a conversion/format message.
- Generate one evidence UUID per selected photo. Reuse it and the same bytes on transient retries. Never use it for a replacement photo. At most three live reservations/photos per task; failed uploads can be queued for removal using the existing authenticated removal RPC.
- Success: `{ ok: true, evidence: <database record>, reused: <boolean> }`. Only `ready` evidence counts; the client must not mark Done after a network error. Retrying an already-ready ID returns that existing record, never replaces it. For a pending ID with stored bytes, the normalized SHA-256 must match before finalisation.
- Errors: `{ ok: false, code, error }`; 401 sign-in, 400/413/415 request issues, 422 invalid image, 409 reservation/conflict/shift changed, 503 transient infrastructure failure. Refresh authoritative task/evidence state after ambiguous results. Invalid-photo rejection ends that reservation: use a new ID for another image.
- The server auto-orients, scales down, flattens transparency onto white, strips metadata/profiles and writes JPEG quality 82. No raw original or GPS metadata is retained by this endpoint.
- Success contains no public/signed URL. The later UI can download a ready, unexpired object with the signed-in Supabase Storage client under RLS and display a temporary local Blob URL. Notification links remain a later phase; do not send images/service credentials to Telegram.

## Verification before production enablement

Run the Deno checks and Node regression commands in the root README. Unit/integration fixtures never contact production. Image decoding uses actual JPEG/PNG/WebP bytes; HTTP tests mock Supabase API responses; PGlite provides synthetic Storage metadata, not a real Storage service.

On 2026-09-23, Docker-backed bundling and deployment succeeded for both functions; each is active version 1. Read-only preflight confirmed the migration-028 cleanup columns, correct private bucket settings and matching hosted/local cron-secret digest. Both endpoints rejected unauthenticated POST requests with 401; upload OPTIONS returned 200. The user reports running the cleanup schedule SQL; scheduled HTTP success remains unchecked. Actual hosted image decoding/CPU/memory limits, real object deletion and multi-session locking have **not** been validated. After all implementation phases, use an isolated Supabase test project/venue:

1. Deploy both functions and check decoder initialisation with an authenticated JPEG/PNG/WebP upload. Inspect the stored JPEG for orientation, stripped metadata and correct dimensions; verify it is private and actually downloadable by an authorised user. Check cold and warm requests with representative phone photos resized to 1600px.
2. Reject malformed/oversized/animated images and confirm they never become ready. Retry one ID after a lost response; matching data must not duplicate or overwrite. Different pending content must conflict. A required Done transition must fail before verification and succeed afterwards.
3. Anonymous, cross-organisation, inactive and access-revoked users must not reserve, upload or download. Employees must not create exemptions or call finalisation/cleanup RPCs. A direct raw Storage upload alone must not count as evidence.
4. Use **test-only** data to exercise remove/reset/expiry. Invoke cleanup with the scheduler secret; verify physical object absence, deleted metadata and preserved audit. Repeat cleanup and simulate a failed Storage response; failures must remain queued for retry. Check Cron HTTP results.
5. Use separate sessions to race upload/finalise against submit, reset, access revocation and cleanup. Stale operations must fail/refresh, not falsely report completion; late objects must be reconciled on a later run.
6. With a dedicated test Telegram recipient, submit complete/incomplete shifts with photos and acknowledged exemptions. Verify snapshot counts, resubmission revision links, existing recipient preferences and delivery idempotency. Reopen and EOD messages must distinguish current from submitted counts; long EOD messages must retain both shift links. No images, Storage URLs or link previews should appear.
7. Open links signed out, already signed in, and as an unauthorised/revoked user. Confirm sign-in resumes the exact venue/date/shift/revision, read-only viewing, no automatic image download, reset/old revision access and expired-photo audit. Invalid or unavailable targets must not display another shift. Check a real phone and Telegram's in-app browser as well as Safari/Chrome.

Also exercise the finished employee/manager UI and phase-4 notification links end to end, including a real phone camera/gallery, before enabling photo requirements in production. No production data or files were removed during implementation.
