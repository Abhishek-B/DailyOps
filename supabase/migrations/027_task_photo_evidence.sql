begin;

alter table public.organisations
  add column photo_retention_days integer not null default 30
    check (photo_retention_days between 1 and 365);
alter table public.template_tasks
  add column requires_photo boolean not null default false;
alter table public.daily_tasks
  add column requires_photo boolean not null default false;
alter table public.daily_checklists
  add column evidence_exemption_ids uuid[] not null default '{}',
  add column evidence_checked_at timestamptz;

-- These are audit snapshots, not cascading foreign keys: Reset Today deletes
-- tasks and reuses checklist IDs. Object paths must survive for API cleanup.
create table public.task_evidence (
  id uuid primary key,
  task_id uuid not null,
  checklist_id uuid not null,
  notification_revision integer not null,
  organisation_id uuid not null,
  venue_id uuid not null,
  work_date date not null,
  list_type public.checklist_type not null,
  task_title text not null,
  uploaded_by uuid not null,
  object_path text not null unique,
  state text not null default 'pending'
    check (state in ('pending', 'ready', 'delete_pending', 'deleted')),
  created_at timestamptz not null default clock_timestamp(),
  upload_deadline timestamptz not null default clock_timestamp() + interval '1 hour',
  uploaded_at timestamptz,
  expires_at timestamptz,
  byte_size integer check (byte_size between 1 and 5242880),
  mime_type text check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  deletion_reason text check (deletion_reason in ('removed', 'expired', 'abandoned', 'task_deleted')),
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  check (state <> 'ready' or (
    uploaded_at is not null and expires_at is not null and expires_at > uploaded_at
    and byte_size is not null and mime_type is not null and sha256 is not null
  )),
  check (state not in ('delete_pending', 'deleted') or (
    deletion_reason is not null and deletion_requested_at is not null
  )),
  check ((state = 'deleted') = (deleted_at is not null))
);

create table public.task_evidence_exemptions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  checklist_id uuid not null,
  notification_revision integer not null,
  venue_id uuid not null,
  approved_by uuid not null,
  approved_at timestamptz not null default clock_timestamp(),
  reason text not null check (length(trim(reason)) between 1 and 1000),
  revoked_by uuid,
  revoked_at timestamptz,
  check ((revoked_by is null) = (revoked_at is null))
);

create unique index task_evidence_exemption_active_idx
  on public.task_evidence_exemptions(task_id, notification_revision)
  where revoked_at is null;

create table public.task_evidence_submissions (
  checklist_id uuid not null,
  notification_revision integer not null,
  task_id uuid not null,
  organisation_id uuid not null,
  venue_id uuid not null,
  work_date date not null,
  list_type public.checklist_type not null,
  task_title text not null,
  task_status public.task_status not null,
  requires_photo boolean not null,
  evidence jsonb not null,
  exemption_id uuid,
  exemption_reason text,
  exemption_approved_by uuid,
  exemption_approved_at timestamptz,
  submitted_by uuid not null,
  submitted_at timestamptz not null,
  primary key (checklist_id, notification_revision, task_id)
);

create index task_evidence_task_idx on public.task_evidence(task_id, state);
create index task_evidence_expiry_idx on public.task_evidence(expires_at) where state = 'ready';
create index task_evidence_cleanup_idx on public.task_evidence(state, upload_deadline);
create index task_evidence_venue_idx on public.task_evidence(venue_id, work_date);
create index task_evidence_exemption_venue_idx on public.task_evidence_exemptions(venue_id);
create index task_evidence_submission_venue_idx on public.task_evidence_submissions(venue_id, work_date);

alter table public.task_evidence enable row level security;
alter table public.task_evidence_exemptions enable row level security;
alter table public.task_evidence_submissions enable row level security;
create policy task_evidence_select on public.task_evidence
  for select to authenticated using (public.can_access_venue(venue_id));
create policy task_evidence_exemptions_select on public.task_evidence_exemptions
  for select to authenticated using (public.can_access_venue(venue_id));
create policy task_evidence_submissions_select on public.task_evidence_submissions
  for select to authenticated using (public.can_access_venue(venue_id));
revoke all on public.task_evidence, public.task_evidence_exemptions, public.task_evidence_submissions
  from public, anon, authenticated, service_role;
grant select on public.task_evidence, public.task_evidence_exemptions, public.task_evidence_submissions
  to authenticated, service_role;

create function public.task_has_photo(p_task_id uuid, p_at timestamptz default clock_timestamp())
returns boolean language sql volatile security definer set search_path = public as $$
  select exists (
    select 1 from public.task_evidence e
    join storage.objects o on o.bucket_id = 'task-evidence' and o.name = e.object_path
    join storage.buckets b on b.id = o.bucket_id and not b.public
    where e.task_id = p_task_id and e.state = 'ready' and e.expires_at > p_at
  );
$$;

create function public.task_photo_exemption(p_task_id uuid, p_revision integer)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.task_evidence_exemptions
  where task_id = p_task_id and notification_revision = p_revision and revoked_at is null;
$$;

create function public.lock_task_evidence_checklist(p_task_id uuid)
returns public.daily_checklists language plpgsql security definer set search_path = public as $$
declare
  v_checklist public.daily_checklists;
begin
  select dc.* into v_checklist
  from public.daily_checklists dc join public.daily_tasks dt on dt.checklist_id = dc.id
  where dt.id = p_task_id for update of dc;
  if not found then raise exception 'Task is no longer available'; end if;
  return v_checklist;
end;
$$;

create function public.reserve_task_evidence(p_task_id uuid, p_evidence_id uuid)
returns public.task_evidence language plpgsql security definer set search_path = public as $$
declare
  v_checklist public.daily_checklists;
  v_evidence public.task_evidence;
  v_org_id uuid;
begin
  v_checklist := public.lock_task_evidence_checklist(p_task_id);
  if auth.uid() is null or not public.can_access_venue(v_checklist.venue_id) then
    raise exception 'This task is not available to you';
  end if;
  if v_checklist.submitted then raise exception 'Reopen the shift before changing evidence'; end if;
  if p_evidence_id is null then raise exception 'An evidence ID is required'; end if;

  select * into v_evidence from public.task_evidence where id = p_evidence_id;
  if found then
    if v_evidence.task_id <> p_task_id or v_evidence.uploaded_by <> auth.uid()
      or v_evidence.notification_revision <> v_checklist.notification_revision then
      raise exception 'Evidence ID is already in use';
    end if;
    return v_evidence;
  end if;
  if (select count(*) from public.task_evidence where task_id = p_task_id and (
    (state = 'ready' and expires_at > clock_timestamp()) or
    (state = 'pending' and upload_deadline > clock_timestamp())
  )) >= 3 then raise exception 'A task can have up to three photos'; end if;

  select organisation_id into v_org_id from public.venues where id = v_checklist.venue_id;
  insert into public.task_evidence (
    id, task_id, checklist_id, notification_revision, organisation_id, venue_id,
    work_date, list_type, task_title, uploaded_by, object_path
  ) select p_evidence_id, dt.id, v_checklist.id, v_checklist.notification_revision,
    v_org_id, v_checklist.venue_id, v_checklist.work_date, v_checklist.list_type,
    dt.title, auth.uid(), concat(v_org_id, '/', v_checklist.venue_id, '/', v_checklist.id, '/', dt.id, '/', p_evidence_id)
  from public.daily_tasks dt where dt.id = p_task_id
  returning * into v_evidence;
  if not found then raise exception 'Task is no longer available'; end if;
  return v_evidence;
end;
$$;

-- Phase 2's trusted validator must decode/check the image before calling this.
-- Storage metadata alone is not proof that the bytes are a valid photo.
create function public.finalize_task_evidence(
  p_evidence_id uuid, p_uploaded_by uuid, p_byte_size integer, p_mime_type text, p_sha256 text
)
returns public.task_evidence language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.task_evidence;
  v_checklist public.daily_checklists;
  v_retention integer;
  v_now timestamptz;
begin
  select * into v_evidence from public.task_evidence where id = p_evidence_id;
  if not found then raise exception 'Evidence was not found'; end if;
  v_checklist := public.lock_task_evidence_checklist(v_evidence.task_id);
  select * into v_evidence from public.task_evidence where id = p_evidence_id for update;
  if v_evidence.uploaded_by is distinct from p_uploaded_by or not exists (
    select 1 from public.profiles p where p.id = p_uploaded_by and p.active and (
      p.platform_role = 'admin' or exists (
        select 1 from public.organisation_members om
        where om.user_id = p.id and om.organisation_id = v_evidence.organisation_id and om.role = 'manager'
      ) or exists (
        select 1 from public.venue_members vm where vm.user_id = p.id and vm.venue_id = v_evidence.venue_id
      )
    )
  ) then raise exception 'Upload owner no longer has venue access or does not match'; end if;
  if v_checklist.submitted or v_checklist.notification_revision <> v_evidence.notification_revision then
    raise exception 'The shift changed. Start a new upload';
  end if;
  if v_evidence.state = 'ready' then
    if v_evidence.byte_size is distinct from p_byte_size or v_evidence.mime_type is distinct from p_mime_type
      or v_evidence.sha256 is distinct from p_sha256 or v_evidence.expires_at <= clock_timestamp() then
      raise exception 'Evidence has already been finalized or expired';
    end if;
    return v_evidence;
  end if;
  if v_evidence.state <> 'pending' or v_evidence.upload_deadline <= clock_timestamp() then
    raise exception 'Upload reservation is no longer active';
  end if;
  if not exists (
    select 1 from storage.objects o join storage.buckets b on b.id = o.bucket_id
    where o.bucket_id = 'task-evidence' and not b.public and o.name = v_evidence.object_path
      and (o.metadata->>'size')::bigint = p_byte_size and o.metadata->>'mimetype' = p_mime_type
  ) then raise exception 'The private uploaded object does not match'; end if;

  select photo_retention_days into v_retention from public.organisations where id = v_evidence.organisation_id;
  if not found then raise exception 'Organisation is no longer available'; end if;
  v_now := clock_timestamp();
  update public.task_evidence set state = 'ready', uploaded_at = v_now,
    expires_at = v_now + make_interval(days => v_retention),
    byte_size = p_byte_size, mime_type = p_mime_type, sha256 = p_sha256
  where id = p_evidence_id returning * into v_evidence;
  return v_evidence;
end;
$$;

create function public.approve_task_photo_exemption(p_task_id uuid, p_reason text)
returns public.task_evidence_exemptions language plpgsql security definer set search_path = public as $$
declare
  v_checklist public.daily_checklists;
  v_exemption public.task_evidence_exemptions;
begin
  v_checklist := public.lock_task_evidence_checklist(p_task_id);
  if auth.uid() is null or not public.can_manage_venue(v_checklist.venue_id) then
    raise exception 'Only an authorised manager can approve a photo exemption';
  end if;
  if v_checklist.submitted then raise exception 'Reopen the shift before changing evidence'; end if;
  if not (select requires_photo from public.daily_tasks where id = p_task_id) then
    raise exception 'This task does not require a photo';
  end if;
  if length(trim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception 'An exemption needs a reason of 1 to 1000 characters';
  end if;
  select * into v_exemption from public.task_evidence_exemptions
  where task_id = p_task_id and notification_revision = v_checklist.notification_revision and revoked_at is null;
  if found then
    if v_exemption.reason <> trim(p_reason) then raise exception 'Revoke the existing exemption before replacing it'; end if;
    return v_exemption;
  end if;
  insert into public.task_evidence_exemptions(task_id, checklist_id, notification_revision, venue_id, approved_by, reason)
  values (p_task_id, v_checklist.id, v_checklist.notification_revision, v_checklist.venue_id, auth.uid(), trim(p_reason))
  returning * into v_exemption;
  return v_exemption;
end;
$$;

create function public.invalidate_task_photo_completion(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_checklist public.daily_checklists;
begin
  select dc.* into v_checklist from public.daily_checklists dc
  join public.daily_tasks dt on dt.checklist_id = dc.id where dt.id = p_task_id for update of dc;
  if not found or v_checklist.submitted then return; end if;
  if not public.task_has_photo(p_task_id)
    and public.task_photo_exemption(p_task_id, v_checklist.notification_revision) is null then
    update public.daily_tasks set status = 'pending', completed_by = null, completed_at = null
    where id = p_task_id and requires_photo and status = 'done';
  end if;
end;
$$;

create function public.revoke_task_photo_exemption(p_exemption_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_exemption public.task_evidence_exemptions;
  v_checklist public.daily_checklists;
begin
  select * into v_exemption from public.task_evidence_exemptions where id = p_exemption_id;
  if not found then raise exception 'Exemption was not found'; end if;
  v_checklist := public.lock_task_evidence_checklist(v_exemption.task_id);
  if auth.uid() is null or not public.can_manage_venue(v_checklist.venue_id) then
    raise exception 'Only an authorised manager can revoke a photo exemption';
  end if;
  if v_checklist.submitted or v_checklist.notification_revision <> v_exemption.notification_revision then
    raise exception 'Exemption belongs to a submitted or previous revision';
  end if;
  update public.task_evidence_exemptions set revoked_by = auth.uid(), revoked_at = clock_timestamp()
  where id = p_exemption_id and revoked_at is null;
  perform public.invalidate_task_photo_completion(v_exemption.task_id);
end;
$$;

create function public.remove_task_evidence(p_evidence_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.task_evidence;
  v_checklist public.daily_checklists;
begin
  select * into v_evidence from public.task_evidence where id = p_evidence_id;
  if not found then raise exception 'Evidence was not found'; end if;
  v_checklist := public.lock_task_evidence_checklist(v_evidence.task_id);
  if auth.uid() is null or not public.can_access_venue(v_checklist.venue_id)
    or (v_evidence.uploaded_by <> auth.uid() and not public.can_manage_venue(v_checklist.venue_id)) then
    raise exception 'Only the uploader or venue manager can remove this photo';
  end if;
  if v_checklist.submitted then raise exception 'Reopen the shift before changing evidence'; end if;
  update public.task_evidence set state = 'delete_pending', deletion_reason = 'removed',
    deletion_requested_at = clock_timestamp()
  where id = p_evidence_id and state in ('pending', 'ready');
  perform public.invalidate_task_photo_completion(v_evidence.task_id);
end;
$$;

create function public.queue_expired_task_evidence(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_evidence public.task_evidence;
  v_count integer := 0;
  v_updated integer;
begin
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'Cleanup batch must be between 1 and 500'; end if;
  for v_evidence in select * from public.task_evidence
    where (state = 'ready' and expires_at <= clock_timestamp())
      or (state = 'pending' and upload_deadline <= clock_timestamp())
    order by created_at, id limit p_limit
  loop
    perform dc.id from public.daily_checklists dc where dc.id = v_evidence.checklist_id for update;
    update public.task_evidence set state = 'delete_pending',
      deletion_reason = case when state = 'ready' then 'expired' else 'abandoned' end,
      deletion_requested_at = clock_timestamp()
    where id = v_evidence.id and (
      (state = 'ready' and expires_at <= clock_timestamp()) or
      (state = 'pending' and upload_deadline <= clock_timestamp())
    );
    get diagnostics v_updated = row_count;
    v_count := v_count + v_updated;
    perform public.invalidate_task_photo_completion(v_evidence.task_id);
  end loop;
  return v_count;
end;
$$;

create function public.confirm_task_evidence_deleted(p_evidence_id uuid)
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
  update public.task_evidence set state = 'deleted', deleted_at = clock_timestamp() where id = p_evidence_id;
end;
$$;

create function public.enforce_task_photo_evidence()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_checklist public.daily_checklists;
  v_required boolean;
begin
  if tg_op = 'UPDATE' and (new.id <> old.id or new.checklist_id <> old.checklist_id) then
    raise exception 'Task identity and checklist cannot be changed';
  end if;
  select * into v_checklist from public.daily_checklists
  where id = case when tg_op = 'DELETE' then old.checklist_id else new.checklist_id end for update;
  -- A template deletion only clears its FK; the daily snapshot stays intact.
  if tg_op = 'UPDATE' and old.template_task_id is not null and new.template_task_id is null
    and not exists (select 1 from public.template_tasks where id = old.template_task_id)
    and (to_jsonb(new) - 'template_task_id' - 'updated_at') = (to_jsonb(old) - 'template_task_id' - 'updated_at') then
    return new;
  end if;
  if v_checklist.submitted then raise exception 'Reopen the shift before changing tasks'; end if;
  if tg_op = 'DELETE' then
    update public.task_evidence set state = 'delete_pending', deletion_reason = 'task_deleted',
      deletion_requested_at = clock_timestamp()
    where task_id = old.id and state in ('pending', 'ready');
    return old;
  end if;
  if tg_op = 'INSERT' and new.template_task_id is not null then
    select tt.requires_photo into v_required
    from public.template_tasks tt join public.checklist_templates ct on ct.id = tt.template_id
    where tt.id = new.template_task_id and ct.venue_id = v_checklist.venue_id and ct.list_type = v_checklist.list_type;
    if not found then raise exception 'Template task does not belong to this venue and shift'; end if;
    new.requires_photo := v_required;
  end if;
  if tg_op = 'UPDATE' and new.requires_photo is distinct from old.requires_photo then
    raise exception 'Daily task photo requirements are fixed; change the template for future tasks';
  end if;
  if new.requires_photo and new.status = 'done' and not public.task_has_photo(new.id)
    and public.task_photo_exemption(new.id, v_checklist.notification_revision) is null then
    raise exception 'A photo or manager-approved exemption is required before marking Done';
  end if;
  return new;
end;
$$;

create trigger ab_daily_task_photo_guard before insert or update or delete on public.daily_tasks
for each row execute function public.enforce_task_photo_evidence();

create function public.enforce_checklist_photo_evidence()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_task public.daily_tasks;
  v_exemption_id uuid;
  v_required_ids uuid[] := '{}';
  v_selected_ids uuid[];
begin
  if tg_op = 'INSERT' then
    if new.submitted or cardinality(new.evidence_exemption_ids) <> 0 or new.evidence_checked_at is not null then
      raise exception 'Create the shift before submitting it';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.venue_id <> old.venue_id or new.work_date <> old.work_date or new.list_type <> old.list_type then
    raise exception 'Checklist identity, venue, date and shift cannot be changed';
  end if;
  if old.submitted and not new.submitted then
    new.evidence_exemption_ids := '{}';
    new.evidence_checked_at := null;
    return new;
  end if;
  if old.submitted = new.submitted then
    if new.evidence_exemption_ids is distinct from old.evidence_exemption_ids
      or new.evidence_checked_at is distinct from old.evidence_checked_at then
      raise exception 'Select exemptions only when submitting the shift';
    end if;
    return new;
  end if;
  perform id from public.daily_tasks where checklist_id = new.id order by id for update;
  new.evidence_checked_at := clock_timestamp();
  for v_task in select * from public.daily_tasks where checklist_id = new.id order by id loop
    if v_task.status = 'pending' then raise exception 'Give every unfinished task a reason before submitting'; end if;
    if v_task.requires_photo and v_task.status = 'done' and not public.task_has_photo(v_task.id, new.evidence_checked_at) then
      v_exemption_id := public.task_photo_exemption(v_task.id, new.notification_revision);
      if v_exemption_id is null then raise exception 'A completed task is missing its required photo'; end if;
      v_required_ids := array_append(v_required_ids, v_exemption_id);
    end if;
  end loop;
  select coalesce(array_agg(x order by x), '{}') into v_required_ids from unnest(v_required_ids) x;
  select coalesce(array_agg(x order by x), '{}') into v_selected_ids from unnest(new.evidence_exemption_ids) x;
  if v_selected_ids is distinct from v_required_ids then
    raise exception 'Explicitly acknowledge each required manager exemption before submitting';
  end if;
  return new;
end;
$$;

create trigger ab_daily_checklist_photo_guard before insert or update on public.daily_checklists
for each row execute function public.enforce_checklist_photo_evidence();

create function public.snapshot_checklist_photo_evidence()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_task_id uuid;
begin
  if not old.submitted and new.submitted then
    insert into public.task_evidence_submissions (
      checklist_id, notification_revision, task_id, organisation_id, venue_id, work_date,
      list_type, task_title, task_status, requires_photo, evidence,
      exemption_id, exemption_reason, exemption_approved_by, exemption_approved_at, submitted_by, submitted_at
    ) select new.id, new.notification_revision, dt.id, v.organisation_id, new.venue_id, new.work_date,
      new.list_type, dt.title, dt.status, dt.requires_photo,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'uploaded_by', e.uploaded_by, 'uploaded_at', e.uploaded_at,
        'expires_at', e.expires_at, 'byte_size', e.byte_size, 'mime_type', e.mime_type, 'sha256', e.sha256
      ) order by e.created_at, e.id) from public.task_evidence e
        join storage.objects o on o.bucket_id = 'task-evidence' and o.name = e.object_path
        join storage.buckets b on b.id = o.bucket_id and not b.public
        where e.task_id = dt.id and e.state = 'ready' and e.expires_at > new.evidence_checked_at), '[]'::jsonb),
      ex.id, ex.reason, ex.approved_by, ex.approved_at, new.submitted_by, new.submitted_at
    from public.daily_tasks dt join public.venues v on v.id = new.venue_id
    left join public.task_evidence_exemptions ex on ex.task_id = dt.id and ex.id = any(new.evidence_exemption_ids)
    where dt.checklist_id = new.id;
  elsif old.submitted and not new.submitted then
    for v_task_id in select id from public.daily_tasks where checklist_id = new.id order by id loop
      perform public.invalidate_task_photo_completion(v_task_id);
    end loop;
  end if;
  return new;
end;
$$;

create trigger daily_checklist_photo_snapshot after update on public.daily_checklists
for each row execute function public.snapshot_checklist_photo_evidence();

drop function public.submit_daily_checklist(uuid, integer, jsonb);
create function public.submit_daily_checklist(
  p_checklist_id uuid, p_notification_revision integer, p_changes jsonb default '[]'::jsonb,
  p_exemption_ids uuid[] default '{}'
)
returns public.daily_checklists language plpgsql security invoker set search_path = public as $$
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
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Task changes must be an array'; end if;
  if p_exemption_ids is null then raise exception 'Exemption selections must be an array'; end if;

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
  update public.daily_checklists set submitted = true, submitted_by = auth.uid(), submitted_at = now(),
    evidence_exemption_ids = p_exemption_ids
  where id = p_checklist_id returning * into v_checklist;
  return v_checklist;
end;
$$;

create function public.can_upload_task_evidence(p_object_path text)
returns boolean language sql volatile security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.task_evidence e
    join public.daily_tasks dt on dt.id = e.task_id and dt.checklist_id = e.checklist_id
    join public.daily_checklists dc on dc.id = dt.checklist_id
    where e.object_path = p_object_path and e.uploaded_by = auth.uid() and e.state = 'pending'
      and e.upload_deadline > clock_timestamp() and not dc.submitted
      and dc.notification_revision = e.notification_revision and public.can_access_venue(dc.venue_id)
  );
$$;

create function public.can_read_task_evidence(p_object_path text)
returns boolean language sql volatile security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.task_evidence e where e.object_path = p_object_path
      and e.state = 'ready' and e.expires_at > clock_timestamp() and public.can_access_venue(e.venue_id)
  );
$$;

-- Restrictive policies keep pre-existing broad Storage policies from granting
-- access to this bucket. The bucket itself is provisioned in phase 2.
create policy task_evidence_storage_read on storage.objects for select to authenticated
  using (bucket_id = 'task-evidence' and public.can_read_task_evidence(name));
create policy task_evidence_storage_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'task-evidence' and public.can_upload_task_evidence(name));
create policy task_evidence_storage_read_boundary on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'task-evidence' or public.can_read_task_evidence(name));
create policy task_evidence_storage_upload_boundary on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'task-evidence' or public.can_upload_task_evidence(name));
create policy task_evidence_storage_no_overwrite on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'task-evidence') with check (bucket_id <> 'task-evidence');
create policy task_evidence_storage_no_delete on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'task-evidence');

revoke all on function public.task_has_photo(uuid, timestamptz), public.task_photo_exemption(uuid, integer),
  public.lock_task_evidence_checklist(uuid), public.invalidate_task_photo_completion(uuid),
  public.enforce_task_photo_evidence(), public.enforce_checklist_photo_evidence(),
  public.snapshot_checklist_photo_evidence(), public.reserve_task_evidence(uuid, uuid),
  public.finalize_task_evidence(uuid, uuid, integer, text, text), public.approve_task_photo_exemption(uuid, text),
  public.revoke_task_photo_exemption(uuid), public.remove_task_evidence(uuid),
  public.queue_expired_task_evidence(integer), public.confirm_task_evidence_deleted(uuid),
  public.submit_daily_checklist(uuid, integer, jsonb, uuid[]),
  public.can_upload_task_evidence(text), public.can_read_task_evidence(text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_task_evidence(uuid, uuid), public.approve_task_photo_exemption(uuid, text),
  public.revoke_task_photo_exemption(uuid), public.remove_task_evidence(uuid),
  public.submit_daily_checklist(uuid, integer, jsonb, uuid[]) to authenticated;
grant execute on function public.finalize_task_evidence(uuid, uuid, integer, text, text),
  public.queue_expired_task_evidence(integer), public.confirm_task_evidence_deleted(uuid) to service_role;
grant execute on function public.can_upload_task_evidence(text), public.can_read_task_evidence(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
