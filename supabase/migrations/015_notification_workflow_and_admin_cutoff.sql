-- Step 14 follow-up: notification lifecycle, cover context, and secure cutoff settings.
-- This migration is additive and must be applied after migrations 001-014.

grant select on table public.venues to service_role;
grant select on table public.daily_checklists to service_role;
grant select on table public.daily_tasks to service_role;
grant select on table public.shift_cover_requests to service_role;
grant select on table public.roster_assignments to service_role;

alter table public.daily_checklists
  add column if not exists notification_revision integer not null default 0,
  add column if not exists reopened_by uuid references public.profiles(id) on delete set null,
  add column if not exists reopened_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.daily_checklists'::regclass
      and conname = 'daily_checklists_notification_revision_nonnegative'
  ) then
    alter table public.daily_checklists
      add constraint daily_checklists_notification_revision_nonnegative
      check (notification_revision >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.daily_checklists'::regclass
      and conname = 'daily_checklists_reopened_at_pair'
  ) then
    alter table public.daily_checklists
      add constraint daily_checklists_reopened_at_pair
      check (
        (reopened_by is null and reopened_at is null)
        or (reopened_by is not null and reopened_at is not null)
      );
  end if;
end
$$;

create or replace function public.enforce_daily_checklist_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.notification_revision is distinct from old.notification_revision
     or new.reopened_by is distinct from old.reopened_by
     or new.reopened_at is distinct from old.reopened_at then
    raise exception 'Checklist notification lifecycle fields are server-managed';
  end if;

  -- Edge Functions use the service role for the audited notification finalizer,
  -- which may update legacy complete_notified but cannot choose lifecycle fields.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if not public.can_manage_venue(old.venue_id) then
    if new.id is distinct from old.id
      or new.venue_id is distinct from old.venue_id
      or new.work_date is distinct from old.work_date
      or new.list_type is distinct from old.list_type
      or new.created_at is distinct from old.created_at
      or new.complete_notified is distinct from old.complete_notified then
      raise exception 'Only managers may change checklist identity or notification state';
    end if;
    if new.submitted then
      if new.submitted_by is distinct from auth.uid() or new.submitted_at is null then
        raise exception 'A checklist must be submitted by the signed-in user';
      end if;
    elsif old.submitted and old.submitted_by is distinct from auth.uid() then
      raise exception 'Only the submitting user or a manager may reopen this checklist';
    end if;
  end if;

  if old.submitted and not new.submitted then
    new.notification_revision := old.notification_revision + 1;
    new.reopened_by := auth.uid();
    new.reopened_at := now();
    new.complete_notified := false;
  end if;

  return new;
end;
$$;

alter table public.shift_cover_requests
  add column if not exists covered_for_user_id uuid
    references public.profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.shift_cover_requests'::regclass
      and conname = 'shift_cover_requests_not_self_cover'
  ) then
    alter table public.shift_cover_requests
      add constraint shift_cover_requests_not_self_cover
      check (covered_for_user_id is null or covered_for_user_id <> user_id);
  end if;
end
$$;

drop policy if exists shift_cover_requests_insert on public.shift_cover_requests;
create policy shift_cover_requests_insert on public.shift_cover_requests
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.can_access_venue(venue_id)
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid() and p.active
    )
    and exists (
      select 1
      from public.roster_assignments ra
      where ra.venue_id = shift_cover_requests.venue_id
        and ra.user_id = shift_cover_requests.user_id
        and ra.work_date = shift_cover_requests.work_date
        and ra.shift_type = shift_cover_requests.shift_type
    )
    and (
      covered_for_user_id is null
      or exists (
        select 1
        from public.roster_assignments covered_ra
        where covered_ra.venue_id = shift_cover_requests.venue_id
          and covered_ra.user_id = shift_cover_requests.covered_for_user_id
          and covered_ra.work_date = shift_cover_requests.work_date
          and covered_ra.shift_type = shift_cover_requests.shift_type
      )
    )
  );

create index if not exists shift_cover_requests_covered_for_idx
  on public.shift_cover_requests (venue_id, work_date, shift_type, covered_for_user_id);

alter table public.venue_notification_recipients
  add column if not exists notify_shift_reopened boolean not null default true,
  add column if not exists notify_shift_cover boolean not null default false;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and conname = 'notification_events_kind_check'
  ) then
    alter table public.notification_events
      drop constraint notification_events_kind_check;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_events'::regclass
      and conname = 'notification_events_kind_check'
  ) then
    alter table public.notification_events
      add constraint notification_events_kind_check
      check (kind in ('list-complete', 'list-reopened', 'shift-cover', 'end-of-day', 'test'));
  end if;
end
$$;

create or replace function public.enforce_venue_admin_settings_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.cutoff_time is distinct from old.cutoff_time
      or new.timezone is distinct from old.timezone)
     and not public.is_platform_admin() then
    raise exception 'Only an active platform admin may change venue report timing';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.venues'::regclass
      and tgname = 'aa_venues_admin_settings_guard'
      and not tgisinternal
  ) then
    create trigger aa_venues_admin_settings_guard
      before update on public.venues
      for each row execute function public.enforce_venue_admin_settings_update();
  end if;
end
$$;

revoke all on function public.enforce_venue_admin_settings_update()
  from public, anon, authenticated;
