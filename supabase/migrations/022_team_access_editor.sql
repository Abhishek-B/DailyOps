-- DailyOps Team access editor.
-- Migrations 001-021 remain immutable. This migration adds one atomic,
-- service-role-only final-state access mutation for platform administrators.

create or replace function public.admin_apply_user_access(
  p_user_id uuid,
  p_active boolean,
  p_platform_role public.platform_role,
  p_organisations jsonb,
  p_caller_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_active boolean;
  v_current_platform_role public.platform_role;
  v_org jsonb;
  v_org_id uuid;
  v_role public.app_role;
  v_venue_text text;
  v_venue_id uuid;
  v_requested_org_ids uuid[] := '{}'::uuid[];
  v_requested_venue_ids uuid[];
  v_existing_venue_ids uuid[];
  v_current_org_id uuid;
  v_current_venue_id uuid;
begin
  if p_user_id is null or p_active is null or p_platform_role is null
     or p_organisations is null or p_caller_id is null then
    raise exception 'User, active state, platform role, organisations, and caller are required';
  end if;

  if jsonb_typeof(p_organisations) <> 'array' then
    raise exception 'Organisations must be an array';
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

  select p.active, p.platform_role
    into v_current_active, v_current_platform_role
  from public.profiles p
  where p.id = p_user_id;

  if not found then
    raise exception 'Target profile was not found';
  end if;

  if p_user_id = p_caller_id
     and (p_active is distinct from v_current_active
       or p_platform_role is distinct from v_current_platform_role) then
    raise exception 'You cannot change your own platform access or active state';
  end if;

  if public.is_protected_master_admin(p_user_id) then
    if p_caller_id <> p_user_id then
      raise exception 'The DailyOps master administrator account is protected';
    end if;
    if p_active is distinct from true
       or p_platform_role is distinct from 'admin'::public.platform_role then
      raise exception 'The DailyOps master administrator must remain active and a platform admin';
    end if;
  end if;

  if exists (
    select 1
    from (
      select value->>'organisation_id' as organisation_id
      from jsonb_array_elements(p_organisations)
    ) requested
    group by requested.organisation_id
    having count(*) > 1
  ) then
    raise exception 'Each organisation may appear only once';
  end if;

  perform set_config('dailyops.access_caller_id', p_caller_id::text, true);

  for v_org in select value from jsonb_array_elements(p_organisations) loop
    if jsonb_typeof(v_org) <> 'object'
       or v_org->>'organisation_id' is null
       or v_org->>'organisation_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(v_org->'venue_ids') <> 'array' then
      raise exception 'Each organisation entry must contain a valid organisation_id and venue_ids array';
    end if;

    v_org_id := (v_org->>'organisation_id')::uuid;
    if not exists (
      select 1 from public.organisations o where o.id = v_org_id
    ) then
      raise exception 'Organisation was not found';
    end if;
    v_requested_org_ids := array_append(v_requested_org_ids, v_org_id);

    if v_org->>'role' not in ('employee', 'manager') then
      raise exception 'Each organisation entry must have an employee or manager role';
    end if;
    v_role := (v_org->>'role')::public.app_role;

    if v_role = 'manager'::public.app_role
       and jsonb_array_length(v_org->'venue_ids') <> 0 then
      raise exception 'Manager organisation entries must not contain explicit venue ids';
    end if;

    v_requested_venue_ids := '{}'::uuid[];
    for v_venue_text in
      select value from jsonb_array_elements_text(v_org->'venue_ids')
    loop
      if v_venue_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'Each venue id must be a valid UUID';
      end if;
      v_venue_id := v_venue_text::uuid;
      if not exists (
        select 1
        from public.venues v
        where v.id = v_venue_id
          and v.organisation_id = v_org_id
      ) then
        raise exception 'A requested venue does not belong to its organisation';
      end if;
      if v_venue_id = any(v_requested_venue_ids) then
        raise exception 'Each venue may appear only once per organisation';
      end if;
      v_requested_venue_ids := array_append(v_requested_venue_ids, v_venue_id);
    end loop;

    insert into public.organisation_members (organisation_id, user_id, role)
    values (v_org_id, p_user_id, v_role)
    on conflict (organisation_id, user_id) do update
      set role = excluded.role,
          updated_at = now();

    if v_role = 'employee'::public.app_role then
      select coalesce(array_agg(vm.venue_id), '{}'::uuid[])
        into v_existing_venue_ids
      from public.venue_members vm
      join public.venues v on v.id = vm.venue_id
      where vm.user_id = p_user_id
        and v.organisation_id = v_org_id;

      if not p_active and exists (
        select 1
        from unnest(v_requested_venue_ids) requested(venue_id)
        where not (requested.venue_id = any(v_existing_venue_ids))
      ) then
        raise exception 'Inactive profiles cannot receive new venue access';
      end if;

      for v_current_venue_id in
        select v.id
        from public.venues v
        where v.organisation_id = v_org_id
          and not (v.id = any(v_requested_venue_ids))
      loop
        delete from public.shift_cover_requests scr
        using public.venues v
        where v.id = scr.venue_id
          and scr.venue_id = v_current_venue_id
          and scr.work_date >= (now() at time zone v.timezone)::date
          and (scr.user_id = p_user_id or scr.covered_for_user_id = p_user_id);

        delete from public.roster_assignments ra
        using public.venues v
        where v.id = ra.venue_id
          and ra.venue_id = v_current_venue_id
          and ra.user_id = p_user_id
          and ra.work_date >= (now() at time zone v.timezone)::date;
      end loop;

      delete from public.venue_members vm
      using public.venues v
      where v.id = vm.venue_id
        and vm.user_id = p_user_id
        and v.organisation_id = v_org_id
        and not (vm.venue_id = any(v_requested_venue_ids));

      if p_active then
        foreach v_venue_id in array v_requested_venue_ids loop
          insert into public.venue_members (venue_id, user_id)
          values (v_venue_id, p_user_id)
          on conflict (venue_id, user_id) do nothing;
        end loop;
      end if;

      if not (p_active and p_platform_role = 'admin'::public.platform_role) then
        delete from public.venue_notification_recipients nr
        using public.venues v
        where v.id = nr.venue_id
          and v.organisation_id = v_org_id
          and nr.profile_id = p_user_id;
      end if;
    end if;
  end loop;

  for v_current_org_id in
    select om.organisation_id
    from public.organisation_members om
    where om.user_id = p_user_id
      and not (om.organisation_id = any(v_requested_org_ids))
  loop
    for v_current_venue_id in
      select v.id
      from public.venues v
      where v.organisation_id = v_current_org_id
    loop
      delete from public.shift_cover_requests scr
      using public.venues v
      where v.id = scr.venue_id
        and scr.venue_id = v_current_venue_id
        and scr.work_date >= (now() at time zone v.timezone)::date
        and (scr.user_id = p_user_id or scr.covered_for_user_id = p_user_id);

      delete from public.roster_assignments ra
      using public.venues v
      where v.id = ra.venue_id
        and ra.venue_id = v_current_venue_id
        and ra.user_id = p_user_id
        and ra.work_date >= (now() at time zone v.timezone)::date;
    end loop;

    delete from public.venue_members vm
    using public.venues v
    where v.id = vm.venue_id
      and vm.user_id = p_user_id
      and v.organisation_id = v_current_org_id;

    if not (p_active and p_platform_role = 'admin'::public.platform_role) then
      delete from public.venue_notification_recipients nr
      using public.venues v
      where v.id = nr.venue_id
        and v.organisation_id = v_current_org_id
        and nr.profile_id = p_user_id;
    end if;

    delete from public.organisation_members om
    where om.organisation_id = v_current_org_id
      and om.user_id = p_user_id;
  end loop;

  if not p_active then
    delete from public.shift_cover_requests scr
    using public.venues v
    where v.id = scr.venue_id
      and scr.work_date >= (now() at time zone v.timezone)::date
      and (scr.user_id = p_user_id or scr.covered_for_user_id = p_user_id);

    delete from public.roster_assignments ra
    using public.venues v
    where v.id = ra.venue_id
      and ra.work_date >= (now() at time zone v.timezone)::date
      and ra.user_id = p_user_id;
  end if;

  if not (p_active and p_platform_role = 'admin'::public.platform_role) then
    delete from public.venue_notification_recipients nr
    using public.venues v
    where v.id = nr.venue_id
      and nr.profile_id = p_user_id
      and (
        not exists (
          select 1
          from public.organisation_members om
          where om.organisation_id = v.organisation_id
            and om.user_id = p_user_id
            and om.role = 'manager'::public.app_role
        )
        or not p_active
      );
  end if;

  update public.profiles
  set active = p_active,
      platform_role = p_platform_role,
      updated_at = now()
  where id = p_user_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'active', p_active,
    'platform_role', p_platform_role,
    'organisation_count', jsonb_array_length(p_organisations)
  );
end;
$$;

revoke all on function public.admin_apply_user_access(
  uuid, boolean, public.platform_role, jsonb, uuid
) from public, anon, authenticated;

grant execute on function public.admin_apply_user_access(
  uuid, boolean, public.platform_role, jsonb, uuid
) to service_role;
