-- DailyOps access hardening.
-- Migrations 001-020 remain immutable. This migration records the protected
-- master-admin identity and makes organisation-access mutations caller-aware.

do $$
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication was not found';
  end if;

  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then
    null;
  end;

  begin
    alter publication supabase_realtime add table public.organisation_members;
  exception when duplicate_object then
    null;
  end;

  begin
    alter publication supabase_realtime add table public.venue_members;
  exception when duplicate_object then
    null;
  end;
end;
$$;

create table public.protected_accounts (
  profile_id uuid primary key references public.profiles(id) on delete restrict,
  protection_kind text not null default 'master_admin'
    check (protection_kind = 'master_admin'),
  created_at timestamptz not null default now(),
  unique (protection_kind)
);

alter table public.protected_accounts enable row level security;
revoke all on table public.protected_accounts from public, anon, authenticated, service_role;

do $$
declare
  v_match_count integer;
  v_profile_id uuid;
  v_active boolean;
  v_platform_role public.platform_role;
begin
  select count(*)::integer,
         (array_agg(u.id order by u.id))[1]
    into v_match_count, v_profile_id
  from auth.users u
  where lower(btrim(coalesce(u.email, ''))) = 'ab2824484@gmail.com';

  if v_match_count = 0 then
    raise exception 'DailyOps master admin Auth user was not found';
  end if;
  if v_match_count <> 1 then
    raise exception 'DailyOps master admin email matched more than one Auth user';
  end if;

  select p.active, p.platform_role
    into v_active, v_platform_role
  from public.profiles p
  where p.id = v_profile_id;

  if not found then
    raise exception 'DailyOps master admin profile was not found';
  end if;
  if not v_active or v_platform_role <> 'admin'::public.platform_role then
    raise exception 'DailyOps master admin profile must be active and platform admin';
  end if;

  insert into public.protected_accounts (profile_id)
  values (v_profile_id);
end;
$$;

create or replace function public.is_protected_master_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.protected_accounts pa
    where pa.profile_id = p_user_id
      and pa.protection_kind = 'master_admin'
  );
$$;

revoke all on function public.is_protected_master_admin(uuid)
  from public, anon;
grant execute on function public.is_protected_master_admin(uuid)
  to authenticated, service_role;

create or replace function public.protected_mutation_is_authorized(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not public.is_protected_master_admin(p_user_id)
    or p_user_id = auth.uid()
    or p_user_id::text = nullif(current_setting('dailyops.access_caller_id', true), '');
$$;

revoke all on function public.protected_mutation_is_authorized(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.enforce_protected_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if public.is_protected_master_admin(old.id) then
      raise exception 'The DailyOps master administrator profile is protected';
    end if;
    return old;
  end if;

  if public.is_protected_master_admin(old.id)
     and (new.id is distinct from old.id
       or new.active is distinct from true
       or new.platform_role is distinct from 'admin'::public.platform_role) then
    raise exception 'The DailyOps master administrator must remain active and a platform admin';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_protected_profile()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_profiles_protected_account_guard on public.profiles;
create trigger zz_profiles_protected_account_guard
  before update or delete on public.profiles
  for each row execute function public.enforce_protected_profile();

create or replace function public.enforce_protected_organisation_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_user_id uuid;
  v_new_user_id uuid;
begin
  if tg_op <> 'INSERT' then
    v_old_user_id := old.user_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_user_id := new.user_id;
  end if;

  if (v_old_user_id is not null and public.is_protected_master_admin(v_old_user_id)
      and not public.protected_mutation_is_authorized(v_old_user_id))
     or (v_new_user_id is not null and public.is_protected_master_admin(v_new_user_id)
      and not public.protected_mutation_is_authorized(v_new_user_id)) then
    raise exception 'The DailyOps master administrator organisation access is protected';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_protected_organisation_membership()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_organisation_members_protected_account_guard
  on public.organisation_members;
create trigger zz_organisation_members_protected_account_guard
  before insert or update or delete on public.organisation_members
  for each row execute function public.enforce_protected_organisation_membership();

create or replace function public.enforce_protected_venue_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_user_id uuid;
  v_new_user_id uuid;
begin
  if tg_op <> 'INSERT' then
    v_old_user_id := old.user_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_user_id := new.user_id;
  end if;

  if (v_old_user_id is not null and public.is_protected_master_admin(v_old_user_id)
      and not public.protected_mutation_is_authorized(v_old_user_id))
     or (v_new_user_id is not null and public.is_protected_master_admin(v_new_user_id)
      and not public.protected_mutation_is_authorized(v_new_user_id)) then
    raise exception 'The DailyOps master administrator venue access is protected';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_protected_venue_membership()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_venue_members_protected_account_guard on public.venue_members;
create trigger zz_venue_members_protected_account_guard
  before insert or update or delete on public.venue_members
  for each row execute function public.enforce_protected_venue_membership();

create or replace function public.enforce_protected_account_configuration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Protected account configuration is immutable';
end;
$$;

revoke all on function public.enforce_protected_account_configuration()
  from public, anon, authenticated, service_role;

drop trigger if exists zz_protected_accounts_immutable_guard
  on public.protected_accounts;
create trigger zz_protected_accounts_immutable_guard
  before update or delete on public.protected_accounts
  for each row execute function public.enforce_protected_account_configuration();

-- Replace the old four-argument service-role RPC. Keeping the old signature
-- would allow an outdated server path to mutate the protected account without
-- carrying the verified logical caller identity.
drop function if exists public.admin_manage_user_organisation_access(
  text, uuid, uuid, public.app_role
);

create or replace function public.admin_manage_user_organisation_access(
  p_action text,
  p_user_id uuid,
  p_organisation_id uuid,
  p_organisation_role public.app_role,
  p_caller_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_target_is_platform_admin boolean;
  v_final_role public.app_role;
begin
  if p_user_id is null or p_organisation_id is null or p_caller_id is null then
    raise exception 'User, organisation, and caller are required';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_caller_id
      and p.active
      and p.platform_role = 'admin'::public.platform_role
  ) then
    raise exception 'The verified caller is not an active platform admin';
  end if;

  if v_action not in (
    'upsert_organisation_membership',
    'remove_organisation_membership'
  ) then
    raise exception 'Invalid organisation access action';
  end if;

  if public.is_protected_master_admin(p_user_id)
     and p_caller_id <> p_user_id then
    raise exception 'The DailyOps master administrator account is protected';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_user_id
  ) then
    raise exception 'Target profile was not found';
  end if;

  if not exists (
    select 1
    from public.organisations o
    where o.id = p_organisation_id
  ) then
    raise exception 'Organisation was not found';
  end if;

  perform set_config('dailyops.access_caller_id', p_caller_id::text, true);

  select p.active and p.platform_role = 'admin'::public.platform_role
    into v_target_is_platform_admin
  from public.profiles p
  where p.id = p_user_id;

  if v_action = 'upsert_organisation_membership' then
    if p_organisation_role is null
       or p_organisation_role not in (
         'employee'::public.app_role,
         'manager'::public.app_role
       ) then
      raise exception 'Invalid organisation role';
    end if;

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
          updated_at = now()
    returning role into v_final_role;

    if p_organisation_role = 'employee'::public.app_role
       and not v_target_is_platform_admin then
      delete from public.venue_notification_recipients nr
      using public.venues v
      where v.id = nr.venue_id
        and v.organisation_id = p_organisation_id
        and nr.profile_id = p_user_id;
    end if;

    return jsonb_build_object(
      'action', v_action,
      'user_id', p_user_id,
      'organisation_id', p_organisation_id,
      'role', v_final_role
    );
  end if;

  if p_organisation_role is not null then
    raise exception 'Organisation role is not used when removing access';
  end if;

  delete from public.shift_cover_requests scr
  using public.venues v
  where v.id = scr.venue_id
    and v.organisation_id = p_organisation_id
    and scr.work_date >= (now() at time zone v.timezone)::date
    and (scr.user_id = p_user_id or scr.covered_for_user_id = p_user_id);

  delete from public.roster_assignments ra
  using public.venues v
  where v.id = ra.venue_id
    and v.organisation_id = p_organisation_id
    and ra.work_date >= (now() at time zone v.timezone)::date
    and ra.user_id = p_user_id;

  delete from public.venue_members vm
  using public.venues v
  where v.id = vm.venue_id
    and v.organisation_id = p_organisation_id
    and vm.user_id = p_user_id;

  if not v_target_is_platform_admin then
    delete from public.venue_notification_recipients nr
    using public.venues v
    where v.id = nr.venue_id
      and v.organisation_id = p_organisation_id
      and nr.profile_id = p_user_id;
  end if;

  delete from public.organisation_members om
  where om.organisation_id = p_organisation_id
    and om.user_id = p_user_id;

  return jsonb_build_object(
    'action', v_action,
    'user_id', p_user_id,
    'organisation_id', p_organisation_id,
    'role', null
  );
end;
$$;

revoke all on function public.admin_manage_user_organisation_access(
  text, uuid, uuid, public.app_role, uuid
) from public, anon, authenticated;

grant execute on function public.admin_manage_user_organisation_access(
  text, uuid, uuid, public.app_role, uuid
) to service_role;

-- The synthetic-email and no-membership checks already prevent the 019
-- compensation RPC from targeting an established master account. Keep that
-- guarantee explicit if a future caller passes the master UUID directly.
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

  if public.is_protected_master_admin(p_user_id) then
    raise exception 'The DailyOps master administrator account is protected';
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
