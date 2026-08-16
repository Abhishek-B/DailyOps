-- Keep venue memberships and roster assignments inside the venue's
-- organisation. Managers remain the only writers; employees may still use
-- the existing explicit self-cover insert path.

drop policy if exists venue_members_insert on public.venue_members;
create policy venue_members_insert on public.venue_members
  for insert to authenticated
  with check (
    public.can_manage_venue(venue_id)
    and exists (
      select 1
      from public.venues v
      join public.organisation_members om on om.organisation_id = v.organisation_id
      where v.id = venue_members.venue_id
        and om.user_id = venue_members.user_id
        and om.role = 'employee'
    )
  );

drop policy if exists venue_members_update on public.venue_members;
create policy venue_members_update on public.venue_members
  for update to authenticated
  using (public.can_manage_venue(venue_id))
  with check (
    public.can_manage_venue(venue_id)
    and exists (
      select 1
      from public.venues v
      join public.organisation_members om on om.organisation_id = v.organisation_id
      where v.id = venue_members.venue_id
        and om.user_id = venue_members.user_id
        and om.role = 'employee'
    )
  );

drop policy if exists roster_assignments_insert on public.roster_assignments;
create policy roster_assignments_insert on public.roster_assignments
  for insert to authenticated
  with check (
    public.can_access_venue(venue_id)
    and (
      user_id = auth.uid()
      or (
        public.can_manage_venue(venue_id)
        and exists (
          select 1
          from public.venues v
          join public.organisation_members om on om.organisation_id = v.organisation_id
          join public.profiles p on p.id = om.user_id
          where v.id = roster_assignments.venue_id
            and om.user_id = roster_assignments.user_id
            and om.role = 'employee'
            and p.active
            and exists (
              select 1
              from public.venue_members vm
              where vm.venue_id = roster_assignments.venue_id
                and vm.user_id = roster_assignments.user_id
            )
        )
      )
    )
  );

drop policy if exists roster_assignments_update on public.roster_assignments;
create policy roster_assignments_update on public.roster_assignments
  for update to authenticated
  using (public.can_manage_venue(venue_id))
  with check (
    public.can_manage_venue(venue_id)
    and exists (
      select 1
      from public.venues v
      join public.organisation_members om on om.organisation_id = v.organisation_id
      join public.profiles p on p.id = om.user_id
      where v.id = roster_assignments.venue_id
        and om.user_id = roster_assignments.user_id
        and om.role = 'employee'
        and p.active
        and exists (
          select 1
          from public.venue_members vm
          where vm.venue_id = roster_assignments.venue_id
            and vm.user_id = roster_assignments.user_id
        )
    )
  );
