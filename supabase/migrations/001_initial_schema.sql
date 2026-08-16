-- DailyOps phase 1 schema.
-- This migration is intended to be run on a new Supabase project.
-- Every public table is protected by RLS below. The browser must only use the
-- Supabase publishable/anon key; service-role access belongs on the server.

create extension if not exists pgcrypto;

create type public.app_role as enum ('manager', 'employee');
create type public.checklist_type as enum ('open', 'close');
create type public.task_status as enum ('pending', 'done', 'blocked', 'na', 'skipped');
create type public.task_source as enum ('template', 'adhoc');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null check (length(trim(display_name)) > 0),
  email text unique,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organisation_members (
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null default 'employee',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  subtitle text,
  accent_key text not null default 'indigo'
    check (accent_key in ('terracotta', 'teal', 'berry', 'olive', 'indigo', 'graphite')),
  cutoff_time time not null default '23:30',
  manager_email text,
  manager_phone text,
  notify_complete boolean not null default true,
  notify_end_of_day boolean not null default true,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.venue_members (
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (venue_id, user_id)
);

create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  list_type public.checklist_type not null,
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, list_type)
);

create table public.template_tasks (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.checklist_templates(id) on delete restrict,
  sort_order integer not null default 0 check (sort_order >= 0),
  title text not null check (length(trim(title)) > 0),
  detail text,
  critical boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.daily_checklists (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete restrict,
  work_date date not null,
  list_type public.checklist_type not null,
  submitted boolean not null default false,
  submitted_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  complete_notified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, work_date, list_type),
  check (
    (submitted and submitted_by is not null and submitted_at is not null)
    or (not submitted and submitted_by is null and submitted_at is null)
  )
);

create table public.daily_tasks (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.daily_checklists(id) on delete cascade,
  template_task_id uuid references public.template_tasks(id) on delete set null,
  sort_order integer not null default 0 check (sort_order >= 0),
  title text not null check (length(trim(title)) > 0),
  detail text,
  critical boolean not null default false,
  source public.task_source not null default 'template',
  status public.task_status not null default 'pending',
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now(),
  completed_by uuid references public.profiles(id) on delete restrict,
  completed_at timestamptz,
  note text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'done' and completed_by is not null and completed_at is not null)
    or (status <> 'done' and completed_by is null and completed_at is null)
  ),
  check (status <> 'blocked' or length(trim(coalesce(reason, ''))) > 0)
);

create table public.roster_assignments (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null,
  shift_type public.checklist_type not null,
  start_time time,
  end_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, user_id, work_date, shift_type)
);

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id) on delete set null,
  venue_name text,
  work_date date,
  list_type public.checklist_type,
  kind text not null check (kind in ('list-complete', 'end-of-day', 'test')),
  channel text not null check (channel in ('email', 'sms')),
  recipient text,
  subject text,
  body_text text,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'failed')),
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create trigger organisations_updated_at before update on public.organisations
for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger organisation_members_updated_at before update on public.organisation_members
for each row execute function public.set_updated_at();
create trigger venues_updated_at before update on public.venues
for each row execute function public.set_updated_at();
create trigger venue_members_updated_at before update on public.venue_members
for each row execute function public.set_updated_at();
create trigger checklist_templates_updated_at before update on public.checklist_templates
for each row execute function public.set_updated_at();
create trigger template_tasks_updated_at before update on public.template_tasks
for each row execute function public.set_updated_at();
create trigger daily_checklists_updated_at before update on public.daily_checklists
for each row execute function public.set_updated_at();
create trigger daily_tasks_updated_at before update on public.daily_tasks
for each row execute function public.set_updated_at();
create trigger roster_assignments_updated_at before update on public.roster_assignments
for each row execute function public.set_updated_at();

create index organisation_members_user_idx on public.organisation_members (user_id, organisation_id);
create index venue_members_user_idx on public.venue_members (user_id, venue_id);
create index venues_organisation_name_idx on public.venues (organisation_id, name);
create index template_tasks_template_order_idx on public.template_tasks (template_id, sort_order, id);
create index daily_checklists_venue_date_idx on public.daily_checklists (venue_id, work_date, list_type);
create index daily_tasks_checklist_order_idx on public.daily_tasks (checklist_id, sort_order, id);
create index daily_tasks_status_idx on public.daily_tasks (status);
create index roster_venue_date_shift_idx on public.roster_assignments (venue_id, work_date, shift_type);
create index roster_user_date_idx on public.roster_assignments (user_id, work_date);
create index notification_events_venue_date_idx on public.notification_events (venue_id, work_date, kind);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'DailyOps user'
    ),
    new.email
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_org_manager(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_members om
    join public.profiles p on p.id = om.user_id
    where om.organisation_id = p_organisation_id
      and om.user_id = auth.uid()
      and om.role = 'manager'
      and p.active
  );
$$;

create or replace function public.is_org_member(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_members om
    join public.profiles p on p.id = om.user_id
    where om.organisation_id = p_organisation_id
      and om.user_id = auth.uid()
      and p.active
  );
$$;

create or replace function public.can_access_venue(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and (
        public.is_org_manager(v.organisation_id)
        or exists (
          select 1
          from public.venue_members vm
          join public.profiles p on p.id = vm.user_id
          where vm.venue_id = v.id
            and vm.user_id = auth.uid()
            and p.active
        )
      )
  );
$$;

create or replace function public.can_manage_venue(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and public.is_org_manager(v.organisation_id)
  );
$$;

create or replace function public.can_view_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id = auth.uid()
    or exists (
      select 1
      from public.venue_members target_vm
      join public.venue_members viewer_vm on viewer_vm.venue_id = target_vm.venue_id
      where target_vm.user_id = p_user_id
        and viewer_vm.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.organisation_members target_om
      join public.organisation_members viewer_om
        on viewer_om.organisation_id = target_om.organisation_id
      where target_om.user_id = p_user_id
        and viewer_om.user_id = auth.uid()
        and viewer_om.role = 'manager'
    );
$$;

create or replace function public.can_manage_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organisation_members target_om
    join public.organisation_members viewer_om
      on viewer_om.organisation_id = target_om.organisation_id
    where target_om.user_id = p_user_id
      and viewer_om.user_id = auth.uid()
      and viewer_om.role = 'manager'
  );
$$;

create or replace function public.can_access_task(p_daily_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.daily_tasks dt
    join public.daily_checklists dc on dc.id = dt.checklist_id
    where dt.id = p_daily_task_id
      and public.can_access_venue(dc.venue_id)
  );
$$;

create or replace function public.can_update_task(p_daily_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.daily_tasks dt
    join public.daily_checklists dc on dc.id = dt.checklist_id
    where dt.id = p_daily_task_id
      and public.can_access_venue(dc.venue_id)
      and (
        public.can_manage_venue(dc.venue_id)
        or (
          not dc.submitted
          and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.active
          )
        )
      )
  );
$$;

create or replace function public.enforce_daily_checklist_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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
  return new;
end;
$$;

create trigger aa_daily_checklists_guard
  before update on public.daily_checklists
  for each row execute function public.enforce_daily_checklist_update();

create or replace function public.enforce_daily_task_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'done'
    and not public.can_manage_venue((select venue_id from public.daily_checklists where id = old.checklist_id)) then
    new.completed_by = auth.uid();
    new.completed_at = now();
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

  if not public.can_manage_venue((select venue_id from public.daily_checklists where id = old.checklist_id)) then
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
    if new.status = 'done' and new.completed_by is distinct from auth.uid() then
      raise exception 'Tasks must be completed by the signed-in user';
    end if;
  end if;
  return new;
end;
$$;

create trigger aa_daily_tasks_guard
  before update on public.daily_tasks
  for each row execute function public.enforce_daily_task_update();

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
begin
  if not public.can_manage_venue(p_venue_id) then
    raise exception 'Only a venue manager can initialise daily checklists';
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

alter table public.organisations enable row level security;
alter table public.profiles enable row level security;
alter table public.organisation_members enable row level security;
alter table public.venues enable row level security;
alter table public.venue_members enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.template_tasks enable row level security;
alter table public.daily_checklists enable row level security;
alter table public.daily_tasks enable row level security;
alter table public.roster_assignments enable row level security;
alter table public.notification_events enable row level security;

create policy organisations_select on public.organisations
  for select using (public.is_org_member(id));
create policy organisations_update on public.organisations
  for update using (public.is_org_manager(id)) with check (public.is_org_manager(id));

create policy profiles_select on public.profiles
  for select using (public.can_view_profile(id));
create policy profiles_update on public.profiles
  for update using (public.can_manage_profile(id))
  with check (public.can_manage_profile(id));

create policy organisation_members_select on public.organisation_members
  for select using (user_id = auth.uid() or public.is_org_manager(organisation_id));
create policy organisation_members_insert on public.organisation_members
  for insert with check (public.is_org_manager(organisation_id));
create policy organisation_members_update on public.organisation_members
  for update using (public.is_org_manager(organisation_id))
  with check (public.is_org_manager(organisation_id));
create policy organisation_members_delete on public.organisation_members
  for delete using (public.is_org_manager(organisation_id));

create policy venues_select on public.venues
  for select using (public.can_access_venue(id));
create policy venues_insert on public.venues
  for insert with check (public.is_org_manager(organisation_id));
create policy venues_update on public.venues
  for update using (public.can_manage_venue(id))
  with check (public.can_manage_venue(id));
create policy venues_delete on public.venues
  for delete using (public.can_manage_venue(id));

create policy venue_members_select on public.venue_members
  for select using (public.can_access_venue(venue_id));
create policy venue_members_insert on public.venue_members
  for insert with check (public.can_manage_venue(venue_id));
create policy venue_members_update on public.venue_members
  for update using (public.can_manage_venue(venue_id))
  with check (public.can_manage_venue(venue_id));
create policy venue_members_delete on public.venue_members
  for delete using (public.can_manage_venue(venue_id));

create policy checklist_templates_select on public.checklist_templates
  for select using (public.can_access_venue(venue_id));
create policy checklist_templates_insert on public.checklist_templates
  for insert with check (public.can_manage_venue(venue_id));
create policy checklist_templates_update on public.checklist_templates
  for update using (public.can_manage_venue(venue_id))
  with check (public.can_manage_venue(venue_id));
create policy checklist_templates_delete on public.checklist_templates
  for delete using (public.can_manage_venue(venue_id));

create policy template_tasks_select on public.template_tasks
  for select using (
    exists (
      select 1 from public.checklist_templates ct
      where ct.id = template_id and public.can_access_venue(ct.venue_id)
    )
  );
create policy template_tasks_insert on public.template_tasks
  for insert with check (
    exists (
      select 1 from public.checklist_templates ct
      where ct.id = template_id and public.can_manage_venue(ct.venue_id)
    )
  );
create policy template_tasks_update on public.template_tasks
  for update using (
    exists (
      select 1 from public.checklist_templates ct
      where ct.id = template_id and public.can_manage_venue(ct.venue_id)
    )
  ) with check (
    exists (
      select 1 from public.checklist_templates ct
      where ct.id = template_id and public.can_manage_venue(ct.venue_id)
    )
  );
create policy template_tasks_delete on public.template_tasks
  for delete using (
    exists (
      select 1 from public.checklist_templates ct
      where ct.id = template_id and public.can_manage_venue(ct.venue_id)
    )
  );

create policy daily_checklists_select on public.daily_checklists
  for select using (public.can_access_venue(venue_id));
create policy daily_checklists_insert on public.daily_checklists
  for insert with check (public.can_manage_venue(venue_id));
create policy daily_checklists_update on public.daily_checklists
  for update using (public.can_access_venue(venue_id))
  with check (public.can_access_venue(venue_id));

create policy daily_tasks_select on public.daily_tasks
  for select using (public.can_access_task(id));
create policy daily_tasks_insert on public.daily_tasks
  for insert with check (
    exists (
      select 1 from public.daily_checklists dc
      where dc.id = checklist_id and public.can_manage_venue(dc.venue_id)
    )
  );
create policy daily_tasks_update on public.daily_tasks
  for update using (public.can_update_task(id))
  with check (public.can_access_task(id));

create policy roster_assignments_select on public.roster_assignments
  for select using (public.can_access_venue(venue_id));
create policy roster_assignments_insert on public.roster_assignments
  for insert with check (
    public.can_access_venue(venue_id)
    and (public.can_manage_venue(venue_id) or user_id = auth.uid())
  );
create policy roster_assignments_update on public.roster_assignments
  for update using (public.can_manage_venue(venue_id))
  with check (public.can_manage_venue(venue_id));
create policy roster_assignments_delete on public.roster_assignments
  for delete using (public.can_manage_venue(venue_id));

create policy notification_events_select on public.notification_events
  for select using (venue_id is not null and public.can_manage_venue(venue_id));

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.is_org_manager(uuid) from public;
revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.can_access_venue(uuid) from public;
revoke all on function public.can_manage_venue(uuid) from public;
revoke all on function public.can_view_profile(uuid) from public;
revoke all on function public.can_manage_profile(uuid) from public;
revoke all on function public.can_access_task(uuid) from public;
revoke all on function public.can_update_task(uuid) from public;
revoke all on function public.ensure_daily_checklists(uuid, date) from public;
grant execute on function public.ensure_daily_checklists(uuid, date) to authenticated;
