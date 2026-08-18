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
has an active profile with `platform_role = 'admin'`. It then calls the
service-role-only `admin_manage_user_organisation_access(...)` RPC. The RPC is
atomic and preserves the Auth user, profile, other organisation memberships,
and historical attribution.

Apply `supabase/migrations/020_user_organisation_access.sql` after migrations
001 through 019 and before deploying this function. The migration removes
direct authenticated organisation-membership writes, protects browser
platform-role changes, and keeps venue-membership writes scoped to employee
memberships in managed organisations.

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
