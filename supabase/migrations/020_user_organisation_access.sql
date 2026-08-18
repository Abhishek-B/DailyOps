-- Platform-admin organisation-membership administration and stricter
-- manager-scoped venue membership writes. Applied migrations 001-019 remain
-- immutable.

drop policy if exists organisation_members_insert on public.organisation_members;
drop policy if exists organisation_members_update on public.organisation_members;
drop policy if exists organisation_members_delete on public.organisation_members;

-- Organisation membership changes use the authenticated platform-admin Edge
-- Function and its service-role-only RPC, not direct browser table writes.
revoke insert, update, delete on table public.organisation_members
  from authenticated, anon;

create or replace function public.enforce_platform_role_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.platform_role is distinct from old.platform_role
     and auth.role() <> 'service_role' then
    raise exception 'Platform role is not editable through the browser';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.profiles'::regclass
      and tgname = 'aa_profiles_platform_role_guard'
      and not tgisinternal
  ) then
    create trigger aa_profiles_platform_role_guard
      before update on public.profiles
      for each row execute function public.enforce_platform_role_update();
  end if;
end
$$;

revoke all on function public.enforce_platform_role_update()
  from public, anon, authenticated;

drop policy if exists venue_members_insert on public.venue_members;
create policy venue_members_insert on public.venue_members
  for insert to authenticated
  with check (
    public.can_manage_venue(venue_id)
    and exists (
      select 1
      from public.venues v
      join public.organisation_members om
        on om.organisation_id = v.organisation_id
       and om.user_id = venue_members.user_id
       and om.role = 'employee'
      join public.profiles p
        on p.id = venue_members.user_id
      where v.id = venue_members.venue_id
        and p.active
    )
  );

drop policy if exists venue_members_update on public.venue_members;
create policy venue_members_update on public.venue_members
  for update to authenticated
  using (public.can_manage_venue(venue_id))
  with check (
    public.can_manage_venue(venue_id)
    and exists (
      select 1
      from public.venues v
      join public.organisation_members om
        on om.organisation_id = v.organisation_id
       and om.user_id = venue_members.user_id
       and om.role = 'employee'
      join public.profiles p
        on p.id = venue_members.user_id
      where v.id = venue_members.venue_id
        and p.active
    )
  );

drop policy if exists venue_members_delete on public.venue_members;
create policy venue_members_delete on public.venue_members
  for delete to authenticated
  using (
    public.can_manage_venue(venue_id)
    and exists (
      select 1
      from public.venues v
      join public.organisation_members om
        on om.organisation_id = v.organisation_id
       and om.user_id = venue_members.user_id
       and om.role = 'employee'
      where v.id = venue_members.venue_id
    )
  );

create or replace function public.admin_manage_user_organisation_access(
  p_action text,
  p_user_id uuid,
  p_organisation_id uuid,
  p_organisation_role public.app_role default null
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
  if p_user_id is null or p_organisation_id is null then
    raise exception 'User and organisation are required';
  end if;

  if v_action not in (
    'upsert_organisation_membership',
    'remove_organisation_membership'
  ) then
    raise exception 'Invalid organisation access action';
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

  -- Keep historical attribution, but remove current and future operational
  -- assignments using each venue's configured local date.
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
  text, uuid, uuid, public.app_role
) from public, anon, authenticated;

grant execute on function public.admin_manage_user_organisation_access(
  text, uuid, uuid, public.app_role
) to service_role;
