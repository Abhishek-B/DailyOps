-- Platform admins retain a separate platform-level role and may administer
-- every organisation and venue through the existing RLS helper boundary.
-- Ordinary users remain governed by organisation_members.role.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active
      and p.platform_role = 'admin'
  );
$$;

create or replace function public.is_org_manager(p_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
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
  select public.is_platform_admin()
    or exists (
      select 1
      from public.organisation_members om
      join public.profiles p on p.id = om.user_id
      where om.organisation_id = p_organisation_id
        and om.user_id = auth.uid()
        and p.active
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
    or public.is_platform_admin()
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
  select public.is_platform_admin()
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

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_org_manager(uuid) from public;
revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.can_view_profile(uuid) from public;
revoke all on function public.can_manage_profile(uuid) from public;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_org_manager(uuid) to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.can_view_profile(uuid) to authenticated;
grant execute on function public.can_manage_profile(uuid) to authenticated;
