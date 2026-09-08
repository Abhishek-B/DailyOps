create or replace function public.ensure_daily_checklists(
  p_venue_id uuid,
  p_work_date date default current_date
)
returns setof public.daily_checklists
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list_type public.checklist_type;
  v_template_id uuid;
  v_checklist_id uuid;
  v_timezone text;
begin
  if p_work_date is null then
    raise exception 'Work date is required';
  end if;

  if not public.can_access_venue(p_venue_id) then
    raise exception 'You do not have access to this venue';
  end if;

  if not public.can_manage_venue(p_venue_id) then
    select v.timezone into v_timezone
    from public.venues v
    where v.id = p_venue_id;

    if p_work_date is distinct from (now() at time zone v_timezone)::date then
      raise exception 'Employees can initialise only the venue current day';
    end if;
  end if;

  for v_list_type in select unnest(enum_range(null::public.checklist_type)) loop
    v_template_id := null;
    select ct.id into v_template_id
    from public.checklist_templates ct
    where ct.venue_id = p_venue_id
      and ct.list_type = v_list_type
      and ct.active;

    if v_template_id is null then
      continue;
    end if;

    insert into public.daily_checklists (venue_id, work_date, list_type)
    values (p_venue_id, p_work_date, v_list_type)
    on conflict (venue_id, work_date, list_type) do nothing
    returning id into v_checklist_id;

    if v_checklist_id is not null then
      insert into public.daily_tasks (
        checklist_id, template_task_id, sort_order, title, detail, critical, source
      )
      select v_checklist_id, tt.id, tt.sort_order, tt.title, tt.detail, tt.critical, 'template'
      from public.template_tasks tt
      where tt.template_id = v_template_id
      order by tt.sort_order, tt.id;
    end if;
    v_checklist_id := null;
  end loop;

  return query
    select dc.*
    from public.daily_checklists dc
    where dc.venue_id = p_venue_id
      and dc.work_date = p_work_date
    order by dc.list_type;
end;
$$;

revoke all on function public.ensure_daily_checklists(uuid, date) from public, anon;
grant execute on function public.ensure_daily_checklists(uuid, date) to authenticated;
