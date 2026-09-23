begin;

alter table public.task_evidence
  add column cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  add column cleanup_last_attempt_at timestamptz,
  add column cleanup_next_attempt_at timestamptz not null default clock_timestamp(),
  add column cleanup_last_error text;

create index task_evidence_cleanup_due_idx on public.task_evidence(cleanup_next_attempt_at, id)
where state = 'delete_pending';

create function public.reject_task_evidence_upload(p_evidence_id uuid, p_uploaded_by uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.task_evidence;
begin
  select * into v_evidence from public.task_evidence where id = p_evidence_id;
  if not found or v_evidence.uploaded_by is distinct from p_uploaded_by then
    raise exception 'Upload owner does not match';
  end if;
  perform id from public.daily_checklists where id = v_evidence.checklist_id for update;
  -- A failed concurrent retry must never remove an already verified photo.
  update public.task_evidence set state = 'delete_pending', deletion_reason = 'abandoned',
    deletion_requested_at = clock_timestamp(), cleanup_next_attempt_at = clock_timestamp()
  where id = p_evidence_id and state = 'pending';
end;
$$;

create function public.record_task_evidence_cleanup_failure(p_evidence_id uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.task_evidence set
    cleanup_attempts = cleanup_attempts + 1,
    cleanup_last_attempt_at = clock_timestamp(),
    cleanup_last_error = left(coalesce(nullif(trim(p_error), ''), 'cleanup_failed'), 200),
    cleanup_next_attempt_at = clock_timestamp() + make_interval(secs => least(3600, 30 * power(2, least(cleanup_attempts, 7)))::integer)
  where id = p_evidence_id and state = 'delete_pending';
end;
$$;

-- An upload already in flight can finish after a cleanup request. Keep the
-- tombstone and requeue its exact path instead of deleting unrelated objects.
create function public.requeue_late_task_evidence_objects(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'Cleanup batch must be between 1 and 500'; end if;
  with late as (
    select e.id from public.task_evidence e
    join storage.objects o on o.bucket_id = 'task-evidence' and o.name = e.object_path
    where e.state = 'deleted'
    order by e.deleted_at, e.id limit p_limit for update of e skip locked
  ) update public.task_evidence e set state = 'delete_pending', deleted_at = null,
    cleanup_next_attempt_at = clock_timestamp(), cleanup_last_error = 'late_upload_requeued'
  from late where e.id = late.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.confirm_task_evidence_deleted(p_evidence_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.task_evidence;
begin
  select * into v_evidence from public.task_evidence where id = p_evidence_id for update;
  if not found then raise exception 'Evidence was not found'; end if;
  if v_evidence.state = 'deleted' then return; end if;
  if v_evidence.state <> 'delete_pending' then raise exception 'Evidence is not queued for deletion'; end if;
  if exists (select 1 from storage.objects where bucket_id = 'task-evidence' and name = v_evidence.object_path) then
    raise exception 'Remove the file using the Storage API before confirming deletion';
  end if;
  update public.task_evidence set state = 'deleted', deleted_at = clock_timestamp(),
    cleanup_attempts = cleanup_attempts + 1, cleanup_last_attempt_at = clock_timestamp(), cleanup_last_error = null
  where id = p_evidence_id;
end;
$$;

revoke all on function public.reject_task_evidence_upload(uuid, uuid),
  public.record_task_evidence_cleanup_failure(uuid, text),
  public.requeue_late_task_evidence_objects(integer), public.confirm_task_evidence_deleted(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reject_task_evidence_upload(uuid, uuid),
  public.record_task_evidence_cleanup_failure(uuid, text),
  public.requeue_late_task_evidence_objects(integer), public.confirm_task_evidence_deleted(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
