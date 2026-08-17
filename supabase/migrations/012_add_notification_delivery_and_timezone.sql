-- Add the minimum server-side delivery state for Step 14.
-- Existing notification rows remain valid; NULL idempotency keys are allowed for
-- historical/manual rows created before this migration.

alter table public.venues
  add column if not exists timezone text not null default 'Australia/Sydney';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.venues'::regclass
      and conname = 'venues_timezone_nonempty'
  ) then
    alter table public.venues
      add constraint venues_timezone_nonempty check (length(trim(timezone)) > 0);
  end if;
end
$$;

alter table public.notification_events
  add column if not exists idempotency_key text,
  add column if not exists error_message text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and conname = 'notification_events_idempotency_key_key'
  ) then
    alter table public.notification_events
      add constraint notification_events_idempotency_key_key unique (idempotency_key);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and conname = 'notification_events_attempt_count_nonnegative'
  ) then
    alter table public.notification_events
      add constraint notification_events_attempt_count_nonnegative check (attempt_count >= 0);
  end if;
end
$$;

create index if not exists notification_events_status_idx
  on public.notification_events (delivery_status, created_at);

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.notification_events'::regclass
      and tgname = 'notification_events_updated_at'
      and not tgisinternal
  ) then
    create trigger notification_events_updated_at
      before update on public.notification_events
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- Claiming is performed only by the Edge Functions' service role. The unique
-- key and row lock make concurrent browser/realtime calls idempotent.
create or replace function public.claim_notification_event(
  p_idempotency_key text,
  p_venue_id uuid,
  p_venue_name text,
  p_work_date date,
  p_list_type public.checklist_type,
  p_kind text,
  p_recipient text,
  p_subject text,
  p_body_text text
)
returns table(event_id uuid, should_send boolean, delivery_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.notification_events%rowtype;
  v_inserted integer;
begin
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'notification idempotency key is required';
  end if;

  insert into public.notification_events (
    venue_id, venue_name, work_date, list_type, kind, channel, recipient,
    subject, body_text, delivery_status, idempotency_key, attempt_count,
    last_attempt_at
  ) values (
    p_venue_id, p_venue_name, p_work_date, p_list_type, p_kind, 'email',
    p_recipient, p_subject, p_body_text, 'pending', p_idempotency_key, 1,
    now()
  )
  on conflict (idempotency_key) do nothing;

  get diagnostics v_inserted = row_count;

  select * into v_event
  from public.notification_events
  where idempotency_key = p_idempotency_key
  for update;

  if v_inserted = 1 then
    return query select v_event.id, true, v_event.delivery_status;
    return;
  end if;

  if v_event.delivery_status = 'sent' then
    return query select v_event.id, false, v_event.delivery_status;
    return;
  end if;

  -- A crashed function may leave a pending row. Allow it to be retried after
  -- ten minutes, but cap automated attempts so a bad provider configuration
  -- cannot produce an unbounded retry loop.
  if v_event.attempt_count >= 5
     or (v_event.delivery_status = 'pending'
         and v_event.last_attempt_at is not null
         and v_event.last_attempt_at > now() - interval '10 minutes') then
    return query select v_event.id, false, v_event.delivery_status;
    return;
  end if;

  update public.notification_events
  set delivery_status = 'pending',
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      error_message = null,
      sent_at = null,
      provider_message_id = null,
      updated_at = now()
  where id = v_event.id
  returning * into v_event;

  return query select v_event.id, true, v_event.delivery_status;
end;
$$;

create or replace function public.complete_notification_event(
  p_event_id uuid,
  p_provider_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.notification_events%rowtype;
begin
  select * into v_event
  from public.notification_events
  where id = p_event_id
  for update;

  if not found then
    return false;
  end if;

  update public.notification_events
  set delivery_status = 'sent',
      provider_message_id = p_provider_message_id,
      sent_at = coalesce(sent_at, now()),
      error_message = null,
      updated_at = now()
  where id = p_event_id;

  if v_event.kind = 'list-complete'
     and v_event.venue_id is not null
     and v_event.work_date is not null
     and v_event.list_type is not null then
    update public.daily_checklists
    set complete_notified = true,
        updated_at = now()
    where venue_id = v_event.venue_id
      and work_date = v_event.work_date
      and list_type = v_event.list_type;
  end if;

  return true;
end;
$$;

create or replace function public.fail_notification_event(
  p_event_id uuid,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_events
  set delivery_status = 'failed',
      error_message = left(coalesce(nullif(trim(p_error_message), ''), 'Notification delivery failed'), 2000),
      sent_at = null,
      updated_at = now()
  where id = p_event_id;
  return found;
end;
$$;

revoke all on function public.claim_notification_event(text, uuid, text, date, public.checklist_type, text, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_notification_event(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_notification_event(uuid, text) from public, anon, authenticated;

grant execute on function public.claim_notification_event(text, uuid, text, date, public.checklist_type, text, text, text, text) to service_role;
grant execute on function public.complete_notification_event(uuid, text) to service_role;
grant execute on function public.fail_notification_event(uuid, text) to service_role;
