-- Reset today's live operations from the current venue templates.
-- The checklist IDs are preserved, but notification_revision advances so a
-- later fresh submission cannot collide with an earlier notification event.

create or replace function public.reset_today_operations(p_venue_id uuid)
returns table(
  reset_date date,
  opening_checklist_id uuid,
  closing_checklist_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue public.venues%rowtype;
  v_work_date date;
  v_list_type public.checklist_type;
  v_template_id uuid;
  v_existing_id uuid;
  v_existing_revision integer;
  v_checklist_id uuid;
  v_opening_id uuid;
  v_closing_id uuid;
begin
  if auth.uid() is null or not public.can_manage_venue(p_venue_id) then
    raise exception 'Only an authorised venue manager can reset daily operations';
  end if;

  select * into v_venue
  from public.venues
  where id = p_venue_id;

  if not found then
    raise exception 'Venue was not found';
  end if;

  v_work_date := (now() at time zone v_venue.timezone)::date;

  -- Serialise resets for one venue so two managers cannot rebuild the same
  -- operation concurrently.
  perform pg_advisory_xact_lock(hashtextextended(p_venue_id::text, 0));

  for v_list_type in
    select unnest(array[
      'open'::public.checklist_type,
      'close'::public.checklist_type
    ])
  loop
    v_existing_id := null;
    v_existing_revision := 0;

    select dc.id, dc.notification_revision
      into v_existing_id, v_existing_revision
    from public.daily_checklists dc
    where dc.venue_id = p_venue_id
      and dc.work_date = v_work_date
      and dc.list_type = v_list_type
    for update;

    -- Deleting and reinserting with the same ID avoids the deployed
    -- checklist-update trigger while still advancing the lifecycle identity.
    delete from public.daily_checklists
    where venue_id = p_venue_id
      and work_date = v_work_date
      and list_type = v_list_type;

    insert into public.daily_checklists (
      id,
      venue_id,
      work_date,
      list_type,
      submitted,
      submitted_by,
      submitted_at,
      complete_notified,
      notification_revision,
      reopened_by,
      reopened_at
    ) values (
      coalesce(v_existing_id, gen_random_uuid()),
      p_venue_id,
      v_work_date,
      v_list_type,
      false,
      null,
      null,
      false,
      case when v_existing_id is null then 0 else v_existing_revision + 1 end,
      null,
      null
    )
    returning id into v_checklist_id;

    select ct.id into v_template_id
    from public.checklist_templates ct
    where ct.venue_id = p_venue_id
      and ct.list_type = v_list_type
      and ct.active;

    if v_template_id is not null then
      insert into public.daily_tasks (
        checklist_id,
        template_task_id,
        sort_order,
        title,
        detail,
        critical,
        source
      )
      select
        v_checklist_id,
        tt.id,
        tt.sort_order,
        tt.title,
        tt.detail,
        tt.critical,
        'template'
      from public.template_tasks tt
      where tt.template_id = v_template_id
      order by tt.sort_order, tt.id;
    end if;

    if v_list_type = 'open' then
      v_opening_id := v_checklist_id;
    else
      v_closing_id := v_checklist_id;
    end if;
  end loop;

  return query select v_work_date, v_opening_id, v_closing_id;
end;
$$;

revoke all on function public.reset_today_operations(uuid)
  from public, anon, authenticated;
grant execute on function public.reset_today_operations(uuid)
  to authenticated;
