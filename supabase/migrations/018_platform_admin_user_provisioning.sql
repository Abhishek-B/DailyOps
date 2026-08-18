-- Platform-admin-only Auth user provisioning.
-- The Edge Function creates the Auth user, then calls this service-role-only
-- RPC to finish the public profile and organisation membership atomically.

create or replace function public.provision_created_user(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_organisation_id uuid,
  p_organisation_role public.app_role,
  p_platform_role public.platform_role
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_email text;
  v_username text;
  v_display_name text;
begin
  if p_user_id is null or p_organisation_id is null then
    raise exception 'User and organisation are required';
  end if;

  if p_organisation_role is null
     or p_organisation_role not in ('employee'::public.app_role, 'manager'::public.app_role) then
    raise exception 'Invalid organisation role';
  end if;

  if p_platform_role is null
     or p_platform_role not in ('user'::public.platform_role, 'admin'::public.platform_role) then
    raise exception 'Invalid platform role';
  end if;

  v_display_name := btrim(coalesce(p_display_name, ''));
  if length(v_display_name) = 0 or length(v_display_name) > 120 then
    raise exception 'Display name must be between 1 and 120 characters';
  end if;

  select u.email
    into v_auth_email
  from auth.users u
  where u.id = p_user_id;

  if not found or v_auth_email is null then
    raise exception 'Auth user was not found';
  end if;

  if lower(btrim(coalesce(p_email, ''))) <> lower(btrim(v_auth_email)) then
    raise exception 'Provisioning email does not match the Auth user';
  end if;

  if lower(v_auth_email) !~ '^[a-z0-9._-]+@[.]dailyops[.]invalid$' then
    raise exception 'Provisioning requires a DailyOps synthetic email';
  end if;

  v_username := split_part(lower(v_auth_email), '@', 1);
  if length(v_username) < 3
     or length(v_username) > 32
     or v_username !~ '^[a-z0-9._-]+$'
     or left(v_username, 1) !~ '^[a-z0-9]$'
     or right(v_username, 1) !~ '^[a-z0-9]$'
     or v_username ~ '[._-][._-]' then
    raise exception 'Provisioning username is invalid';
  end if;

  if not exists (
    select 1
    from public.organisations o
    where o.id = p_organisation_id
  ) then
    raise exception 'Organisation was not found';
  end if;

  insert into public.profiles (
    id,
    display_name,
    email,
    active,
    platform_role
  ) values (
    p_user_id,
    v_display_name,
    v_auth_email,
    true,
    p_platform_role
  )
  on conflict (id) do update
    set display_name = excluded.display_name,
        email = excluded.email,
        active = true,
        platform_role = excluded.platform_role;

  insert into public.organisation_members (
    organisation_id,
    user_id,
    role
  ) values (
    p_organisation_id,
    p_user_id,
    p_organisation_role
  )
  on conflict (organisation_id, user_id) do update
    set role = excluded.role,
        updated_at = now();

  return p_user_id;
end;
$$;

revoke all on function public.provision_created_user(
  uuid, text, text, uuid, public.app_role, public.platform_role
) from public, anon, authenticated;

grant execute on function public.provision_created_user(
  uuid, text, text, uuid, public.app_role, public.platform_role
) to service_role;
