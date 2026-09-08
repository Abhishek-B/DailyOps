create policy organisations_insert on public.organisations
  for insert to authenticated with check (public.is_platform_admin());

create or replace function public.enforce_venue_admin_settings_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id or new.organisation_id is distinct from old.organisation_id then
    raise exception 'Venue identity and organisation cannot be changed';
  end if;
  if (new.cutoff_time is distinct from old.cutoff_time or new.timezone is distinct from old.timezone)
     and not public.can_manage_venue(old.id) then
    raise exception 'Only an authorised venue manager may change report timing';
  end if;
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Choose a valid IANA timezone';
  end if;
  return new;
end;
$$;

create or replace function public.create_venue(
  p_venue_id uuid,
  p_organisation_id uuid,
  p_name text,
  p_subtitle text,
  p_accent_key text,
  p_timezone text,
  p_cutoff_time time
)
returns public.venues
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_venue public.venues;
begin
  if auth.uid() is null or not public.is_org_manager(p_organisation_id) then
    raise exception 'Only an authorised organisation manager can add a venue';
  end if;
  if p_venue_id is null or length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'A venue ID and name are required';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Choose a valid IANA timezone';
  end if;

  -- ON CONFLICT also checks the SELECT policy before the new venue is visible
  -- to can_access_venue(). A plain INSERT retains the existing RLS boundary.
  begin
    insert into public.venues (id, organisation_id, name, subtitle, accent_key, timezone, cutoff_time)
    values (p_venue_id, p_organisation_id, trim(p_name), nullif(trim(p_subtitle), ''), p_accent_key, p_timezone, p_cutoff_time);
  exception when unique_violation then
    if not exists (select 1 from public.venues where id = p_venue_id) then raise; end if;
  end;

  select * into v_venue from public.venues where id = p_venue_id;
  if not found or v_venue.organisation_id is distinct from p_organisation_id then
    raise exception 'Venue could not be created in this organisation';
  end if;

  insert into public.checklist_templates (venue_id, list_type, name, active)
  values (p_venue_id, 'open', 'Opening Shift', true), (p_venue_id, 'close', 'Closing Shift', true)
  on conflict (venue_id, list_type) do nothing;
  return v_venue;
end;
$$;

revoke all on function public.create_venue(uuid, uuid, text, text, text, text, time) from public, anon;
grant execute on function public.create_venue(uuid, uuid, text, text, text, text, time) to authenticated;
