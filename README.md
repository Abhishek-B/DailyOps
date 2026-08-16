# DailyOps Starter v2

DailyOps is a framework-free, multi-venue opening/closing checklist app. It remains a single static `index.html` suitable for GitHub Pages.

## Current phase

Supabase currently supplies authentication only:

- email/password sign-in and sign-out;
- persisted sessions across browser refreshes; and
- the signed-in user's `public.profiles` row.

The existing application data, demo user switcher, checklists, venues, templates, rosters, history, CSV export, and simulated notifications remain localStorage-backed. Production defaults to Supabase Auth. The original demo can be enabled explicitly with `DEMO_MODE: true`.

## Supabase frontend auth setup

### Configuration

The public browser configuration is in [`supabase/config.js`](supabase/config.js):

```js
window.DAILYOPS_SUPABASE_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...',
  DEMO_MODE: false
};
```

Paste the project URL and publishable key from **Supabase > Project Settings > API** into that file. In this checkout, the values are already configured for the DailyOps project. Set `DEMO_MODE` to `true` only when you explicitly want the localStorage demo and fake user switcher.

The URL and publishable key are public browser credentials. They identify the Supabase project; database access is still controlled by RLS. Never put a `service_role` key, secret key, database password, Edge Function secret, or other privileged credential in `supabase/config.js`, `index.html`, or GitHub Pages.

### Supabase Auth settings

In the Supabase dashboard:

1. Enable the **Email** provider under **Authentication > Providers**.
2. For local testing, either disable email confirmation or confirm the test user's email.
3. Under **Authentication > URL Configuration**, allow the local URL used by Live Server, such as `http://127.0.0.1:5500`, and the production URL below.

The app loads the authenticated user's profile with a query constrained to `profiles.id = auth.users.id`. The browser does not query venues, memberships, checklists, templates, rosters, or other application tables in this phase.

### Create the first manager account

Create an email/password user under **Authentication > Users**. The deployed profile trigger should create the matching `public.profiles` row. If the row is missing, repair it using an appropriately protected administrative workflow in the Supabase dashboard; do not put an admin or service-role key in the frontend.

The frontend stores `id`, `display_name`, `email`, `active`, and `platform_role` in memory after login. The displayed role is not an authorization boundary. RLS must enforce all future organisation and venue permissions.

### Run locally with VS Code Live Server

Install the **Live Server** extension in VS Code, then right-click [`index.html`](index.html) and choose **Open with Live Server**. Open the URL shown by VS Code, for example:

```text
http://127.0.0.1:5500/
```

Make sure the exact local origin is included in Supabase **Authentication > URL Configuration**. Do not open `index.html` directly with a `file://` URL.

### Test login and logout

1. Open the local URL. With no session, only the DailyOps login screen should be visible.
2. Try an invalid password and confirm the Supabase error is shown on the login screen.
3. Sign in with the test user and confirm the profile display name appears in the existing user area.
4. Refresh the page and confirm the session is restored without signing in again.
5. Select the sign-out action and confirm the app returns to the login screen.
6. Confirm the existing checklist/demo UI still works after successful login and that its changes remain in localStorage.

Production URL:

```text
https://abhishek-b.github.io/DailyOps/
```

### Verify RLS

Use an authenticated browser session or the Supabase client with a test user's session when checking access. Do not use the SQL Editor as proof of RLS behavior because dashboard SQL runs with elevated privileges. Confirm that an authenticated user can read only their own profile row and that a user cannot read or update another user's profile unless the deployed RLS policies explicitly allow it.

## Intentionally deferred

- organisation, membership, and venue queries;
- database-backed venues, templates, daily checklist snapshots, tasks, rosters, and history;
- realtime subscriptions;
- notification delivery and scheduled jobs;
- roster CSV import;
- Postgres-backed reporting and CSV export;
- Edge Functions, Storage, offline support, and PWA behaviour.

The existing localStorage implementation remains available as the compatibility/demo repository while those adapters are developed incrementally.
