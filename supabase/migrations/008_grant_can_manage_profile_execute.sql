-- Allow authenticated managers to pass the existing profiles update RLS policy.
grant execute on function public.can_manage_profile(uuid) to authenticated;
