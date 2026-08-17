-- Telegram replaces email as the active Step 14 delivery channel.
-- Chat IDs are protected venue configuration, not browser or audit secrets.

create table public.venue_notification_recipients (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  telegram_chat_id text not null
    check (length(trim(telegram_chat_id)) > 0 and length(telegram_chat_id) <= 256),
  enabled boolean not null default true,
  notify_shift_complete boolean not null default true,
  notify_end_of_day boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, profile_id),
  unique (venue_id, telegram_chat_id)
);

create index venue_notification_recipients_venue_idx
  on public.venue_notification_recipients (venue_id, enabled);

create or replace function public.can_configure_venue_notification_recipient(
  p_venue_id uuid,
  p_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.venues v
    join public.profiles target on target.id = p_profile_id
    where v.id = p_venue_id
      and target.active
      and (
        target.platform_role = 'admin'
        or exists (
          select 1
          from public.organisation_members om
          where om.organisation_id = v.organisation_id
            and om.user_id = target.id
            and om.role = 'manager'
        )
      )
  );
$$;

revoke all on function public.can_configure_venue_notification_recipient(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.can_configure_venue_notification_recipient(uuid, uuid)
  to authenticated;

alter table public.venue_notification_recipients enable row level security;

create policy venue_notification_recipients_select
  on public.venue_notification_recipients
  for select
  using (public.can_manage_venue(venue_id));

create policy venue_notification_recipients_insert
  on public.venue_notification_recipients
  for insert
  with check (
    public.can_manage_venue(venue_id)
    and created_by = auth.uid()
    and public.can_configure_venue_notification_recipient(venue_id, profile_id)
  );

create policy venue_notification_recipients_update
  on public.venue_notification_recipients
  for update
  using (public.can_manage_venue(venue_id))
  with check (
    public.can_manage_venue(venue_id)
    and public.can_configure_venue_notification_recipient(venue_id, profile_id)
  );

create policy venue_notification_recipients_delete
  on public.venue_notification_recipients
  for delete
  using (public.can_manage_venue(venue_id));

grant select, insert, update, delete
  on public.venue_notification_recipients
  to authenticated;

create or replace function public.enforce_venue_notification_recipient_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.venue_id is distinct from old.venue_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Notification recipient identity fields cannot be changed';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.venue_notification_recipients'::regclass
      and tgname = 'aa_venue_notification_recipient_guard'
      and not tgisinternal
  ) then
    create trigger aa_venue_notification_recipient_guard
      before update on public.venue_notification_recipients
      for each row execute function public.enforce_venue_notification_recipient_update();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.venue_notification_recipients'::regclass
      and tgname = 'venue_notification_recipients_updated_at'
      and not tgisinternal
  ) then
    create trigger venue_notification_recipients_updated_at
      before update on public.venue_notification_recipients
      for each row execute function public.set_updated_at();
  end if;
end
$$;

revoke all on function public.enforce_venue_notification_recipient_update()
  from public, anon, authenticated;

alter table public.notification_events
  add column if not exists recipient_profile_id uuid
    references public.profiles(id) on delete set null;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and conname = 'notification_events_channel_check'
  ) then
    alter table public.notification_events
      drop constraint notification_events_channel_check;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and conname = 'notification_events_channel_check'
  ) then
    alter table public.notification_events
      add constraint notification_events_channel_check
      check (channel in ('email', 'sms', 'telegram'));
  end if;
end
$$;

create or replace function public.claim_telegram_notification_event(
  p_idempotency_key text,
  p_venue_id uuid,
  p_venue_name text,
  p_work_date date,
  p_list_type public.checklist_type,
  p_kind text,
  p_recipient_profile_id uuid,
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
    venue_id, venue_name, work_date, list_type, kind, channel,
    recipient_profile_id, recipient, subject, body_text, delivery_status,
    idempotency_key, attempt_count, last_attempt_at
  ) values (
    p_venue_id, p_venue_name, p_work_date, p_list_type, p_kind, 'telegram',
    p_recipient_profile_id, p_recipient, p_subject, p_body_text, 'pending',
    p_idempotency_key, 1, now()
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

revoke all on function public.claim_telegram_notification_event(
  text, uuid, text, date, public.checklist_type, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.claim_telegram_notification_event(
  text, uuid, text, date, public.checklist_type, text, uuid, text, text, text
) to service_role;

revoke all on function public.set_updated_at() from public, anon, authenticated;
