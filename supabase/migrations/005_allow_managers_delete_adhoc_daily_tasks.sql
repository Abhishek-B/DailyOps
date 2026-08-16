-- Allow managers to remove only one-off daily tasks in venues they manage.
-- Routine/template-derived daily tasks remain non-deletable through RLS.
create policy daily_tasks_delete_adhoc on public.daily_tasks
  for delete to authenticated using (
    source = 'adhoc'
    and exists (
      select 1
      from public.daily_checklists dc
      where dc.id = checklist_id
        and public.can_manage_venue(dc.venue_id)
    )
  );
