grant execute on function public.can_access_task(uuid) to authenticated;

create or replace function public.enforce_daily_task_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manager boolean;
begin
  v_manager := public.can_manage_venue((select venue_id from public.daily_checklists where id = old.checklist_id));
  if new.status = 'done' and old.status = 'done' then
    new.completed_by := old.completed_by;
    new.completed_at := old.completed_at;
  elsif new.status = 'done' and not v_manager then
    new.completed_by := auth.uid();
    new.completed_at := now();
  end if;

  if new.status = 'done' then
    if new.completed_by is null or new.completed_at is null then
      raise exception 'Completed tasks require completed_by and completed_at';
    end if;
  elsif new.completed_by is not null or new.completed_at is not null then
    raise exception 'Incomplete tasks cannot retain completion attribution';
  end if;
  if new.status = 'blocked' and length(trim(coalesce(new.reason, ''))) = 0 then
    raise exception 'Blocked tasks require a reason';
  end if;

  if not v_manager then
    if new.id is distinct from old.id
      or new.checklist_id is distinct from old.checklist_id
      or new.template_task_id is distinct from old.template_task_id
      or new.sort_order is distinct from old.sort_order
      or new.title is distinct from old.title
      or new.detail is distinct from old.detail
      or new.critical is distinct from old.critical
      or new.source is distinct from old.source
      or new.added_by is distinct from old.added_by
      or new.added_at is distinct from old.added_at
      or new.created_at is distinct from old.created_at then
      raise exception 'Only managers may change task definition fields';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.submit_daily_checklist(
  p_checklist_id uuid,
  p_notification_revision integer,
  p_changes jsonb default '[]'::jsonb
)
returns public.daily_checklists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_checklist public.daily_checklists;
  v_task public.daily_tasks;
  v_change jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to submit a shift'; end if;
  select * into v_checklist from public.daily_checklists where id = p_checklist_id for update;
  if not found or not public.can_access_venue(v_checklist.venue_id) then
    raise exception 'This shift is not available to you';
  end if;
  if v_checklist.notification_revision is distinct from p_notification_revision then
    raise exception 'This shift changed. Refresh before submitting';
  end if;
  if v_checklist.submitted then return v_checklist; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'Task changes must be an array';
  end if;

  -- Lock a stable task set before checking the editor's original values.
  perform id from public.daily_tasks where checklist_id = p_checklist_id order by id for update;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    select * into v_task from public.daily_tasks
    where id = (v_change->>'id')::uuid and checklist_id = p_checklist_id;
    if not found then raise exception 'A task is no longer in this shift'; end if;
    if v_task.status::text is distinct from v_change->>'expected_status'
      or coalesce(v_task.note, '') is distinct from v_change->>'expected_note'
      or coalesce(v_task.reason, '') is distinct from v_change->>'expected_reason' then
      raise exception 'A task changed while you were reviewing. Refresh and review again';
    end if;
    if v_change ? 'status' and v_change->>'status' not in ('blocked', 'na', 'skipped') then
      raise exception 'Complete or reopen tasks before reviewing the shift';
    end if;
    if v_task.status = 'done' and v_change ? 'status' then
      raise exception 'Completed task status cannot change during submission';
    end if;
    update public.daily_tasks set
      status = case when v_change ? 'status' then (v_change->>'status')::public.task_status else status end,
      note = case when v_change ? 'note' then nullif(v_change->>'note', '') else note end,
      reason = case when v_change ? 'reason' then nullif(v_change->>'reason', '') else reason end
    where id = v_task.id;
  end loop;

  if exists (select 1 from public.daily_tasks where checklist_id = p_checklist_id and status = 'pending') then
    raise exception 'Give every unfinished task a reason before submitting';
  end if;
  update public.daily_checklists
  set submitted = true, submitted_by = auth.uid(), submitted_at = now()
  where id = p_checklist_id
  returning * into v_checklist;
  return v_checklist;
end;
$$;

revoke all on function public.submit_daily_checklist(uuid, integer, jsonb) from public, anon;
grant execute on function public.submit_daily_checklist(uuid, integer, jsonb) to authenticated;
