-- An employee's confirmed cover request is an in-app manager alert.
-- Email/SMS delivery remains deferred to the notification phase.

create table public.shift_cover_requests (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  work_date date not null,
  shift_type public.checklist_type not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  manager_seen_at timestamptz,
  manager_seen_by uuid references public.profiles(id) on delete set null,
  check (
    (manager_seen_at is null and manager_seen_by is null)
    or (manager_seen_at is not null and manager_seen_by is not null)
  ),
  unique (venue_id, user_id, work_date, shift_type)
);

create trigger shift_cover_requests_updated_at
  before update on public.shift_cover_requests
  for each row execute function public.set_updated_at();

create index shift_cover_requests_manager_idx
  on public.shift_cover_requests (venue_id, work_date, manager_seen_at, created_at);
create index shift_cover_requests_user_idx
  on public.shift_cover_requests (user_id, work_date);

alter table public.shift_cover_requests enable row level security;

create policy shift_cover_requests_select on public.shift_cover_requests
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.can_manage_venue(venue_id)
  );

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
  );

create policy shift_cover_requests_update on public.shift_cover_requests
  for update to authenticated
  using (public.can_manage_venue(venue_id))
  with check (
    public.can_manage_venue(venue_id)
    and (manager_seen_by is null or manager_seen_by = auth.uid())
  );

revoke all on public.shift_cover_requests from anon;
grant select, insert, update on public.shift_cover_requests to authenticated;
