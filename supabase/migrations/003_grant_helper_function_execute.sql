grant execute on function public.can_view_profile(uuid) to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_manager(uuid) to authenticated;
grant execute on function public.can_access_venue(uuid) to authenticated;
grant execute on function public.can_manage_venue(uuid) to authenticated;
