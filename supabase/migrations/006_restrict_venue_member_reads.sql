-- Employees only need their own venue-membership rows. Managers retain read
-- access for venues they manage so the Team UI can administer memberships.
-- This replaces the broader initial select policy without changing write RLS.
drop policy if exists venue_members_select on public.venue_members;

create policy venue_members_select on public.venue_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.can_manage_venue(venue_id)
  );
