# create-user Edge Function

This authenticated Edge Function creates a DailyOps Auth user for an active
platform administrator. It accepts a username, password, display name,
organisation ID, organisation role, and platform role. It derives the
synthetic Auth email as:

```text
<normalized_username>@dailyops.invalid
```

The function verifies the caller through the bearer token and then queries the
caller's `public.profiles` row. Only `active = true` and
`platform_role = 'admin'` may continue. Organisation managers and employees
receive `403` even if they call the function directly.

The server-only Supabase Auth Admin API creates the user with
`email_confirm: true`. The function then calls the service-role-only RPC:

```text
public.provision_created_user(
  uuid,
  text,
  text,
  uuid,
  public.app_role,
  public.platform_role
)
```

That RPC upserts the triggered profile and the requested organisation
membership in one database transaction. It never creates `venue_members`;
venue access remains a separate manager/admin action in Team.

If provisioning fails after Auth creation, the function first calls the
service-role-only `public.cleanup_failed_created_user_profile(uuid)` RPC. That
RPC removes only a trigger-created synthetic-email profile with no organisation
or venue memberships. The function calls `auth.admin.deleteUser` only after the
profile cleanup succeeds. If either compensation step fails, the server logs
the Auth UUID for protected administrator recovery. Passwords, tokens, and
Authorization headers are never logged or returned.

Migration `019_fix_create_user_compensation.sql` corrects the synthetic email
validation from migration 018 and adds the compensation RPC. Apply it after
migration 018 before deploying this function.

Required Supabase-provided secret:

- `SUPABASE_SERVICE_ROLE_KEY` (provided to Edge Functions by Supabase; never put in the browser)

No new project secret is required beyond the normal Edge Function service-role
configuration. The function is deployed with JWT verification enabled in
`supabase/config.toml`; it also verifies the bearer token explicitly with the
shared `requireUser` helper.

Deploy from the repository root:

```bash
supabase functions deploy create-user
```

The existing static frontend invokes it with `DB.functions.invoke('create-user',
{ body })`; it sends only the signed-in user's session token and the form
values. It never sends a synthetic email, Auth UUID, service key, or
`created_by` value.

If a failed provisioning attempt leaves an orphan Auth user, apply the latest
migrations, inspect the server log, and use the cleanup RPC only for that
specific failed synthetic account after confirming it has no organisation or
venue memberships. Then delete the Auth user from the Supabase dashboard. Do
not use this workflow for an established DailyOps user.
