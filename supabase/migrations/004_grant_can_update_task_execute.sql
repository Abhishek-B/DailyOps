-- Allow authenticated users to pass the daily task update RLS policy.
grant execute on function public.can_update_task(uuid) to authenticated;
