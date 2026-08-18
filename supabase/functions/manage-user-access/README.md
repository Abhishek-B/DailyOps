# manage-user-access Edge Function

This authenticated Edge Function lets an active platform administrator add,
change, or remove a user's organisation membership. It does not create Auth
users, change `platform_role`, assign venues, or delete accounts.

Request body:

```json
{
  "action": "upsert_organisation_membership",
  "user_id": "target-profile-uuid",
  "organisation_id": "organisation-uuid",
  "organisation_role": "employee"
}
```

The removal action omits `organisation_role`:

```json
{
  "action": "remove_organisation_membership",
  "user_id": "target-profile-uuid",
  "organisation_id": "organisation-uuid"
}
```

The function verifies the bearer token and independently checks that the caller
has an active profile with `platform_role = 'admin'`. It passes that verified
caller UUID to the service-role-only
`admin_manage_user_organisation_access(..., p_caller_id)` RPC. The RPC is
atomic, validates the caller again, and preserves the Auth user, profile, other
organisation memberships, and historical attribution. The database rejects
mutations targeting the protected master administrator unless the verified
caller is that same master account.

Apply `supabase/migrations/020_user_organisation_access.sql` and then
`supabase/migrations/021_access_hardening.sql` after migrations 001 through 019
and before deploying this function. The migrations remove direct authenticated
organisation-membership writes, protect browser platform-role changes, keep
venue-membership writes scoped to employee memberships in managed
organisations, and protect the master administrator identity.

Removing an organisation membership also removes that user's venue memberships
and current/future roster and cover assignments for that organisation's venues.
It removes venue Telegram recipient rows unless the target remains an active
platform admin. Historical rows remain intact.

JWT verification is enabled in `supabase/config.toml`. The function uses the
normal Edge Function service-role configuration; no new secret is required.

Deploy from the repository root:

```bash
supabase functions deploy manage-user-access
```
