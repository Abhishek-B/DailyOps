-- Fix synthetic username validation and provide narrowly scoped compensation
-- for an Auth user whose automatic profile was created before provisioning
-- failed. Applied migrations 001-018 remain immutable.

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

  if lower(v_auth_email) !~ '^[a-z0-9._-]+@dailyops[.]invalid$' then
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

create or replace function public.cleanup_failed_created_user_profile(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_email text;
  v_auth_email text;
begin
  if p_user_id is null then
    raise exception 'User id is required';
  end if;

  select p.email
    into v_profile_email
  from public.profiles p
  where p.id = p_user_id
  for update;

  if not found then
    return false;
  end if;

  select u.email
    into v_auth_email
  from auth.users u
  where u.id = p_user_id;

  if not found or v_auth_email is null then
    raise exception 'Auth user is missing; manual review is required';
  end if;

  if lower(coalesce(v_profile_email, '')) <> lower(v_auth_email)
     or lower(v_auth_email) !~ '^[a-z0-9._-]+@dailyops[.]invalid$' then
    raise exception 'Profile is not an unprovisioned DailyOps user';
  end if;

  if exists (
    select 1
    from public.organisation_members om
    where om.user_id = p_user_id
  ) then
    raise exception 'User has organisation membership; manual review is required';
  end if;

  if exists (
    select 1
    from public.venue_members vm
    where vm.user_id = p_user_id
  ) then
    raise exception 'User has venue membership; manual review is required';
  end if;

  delete from public.profiles p
  where p.id = p_user_id;

  if not found then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.cleanup_failed_created_user_profile(uuid)
  from public, anon, authenticated;

grant execute on function public.cleanup_failed_created_user_profile(uuid)
  to service_role;
