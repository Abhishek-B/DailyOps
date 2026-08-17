-- Enable Supabase Realtime publication changes for the live operational rows.
-- Realtime still applies the requesting user's RLS visibility; this migration
-- does not grant any table access or alter existing policies.

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'daily_checklists'
    ) then
      execute 'alter publication supabase_realtime add table public.daily_checklists';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'daily_tasks'
    ) then
      execute 'alter publication supabase_realtime add table public.daily_tasks';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'roster_assignments'
    ) then
      execute 'alter publication supabase_realtime add table public.roster_assignments';
    end if;
  else
    raise notice 'supabase_realtime publication is not present; enable these tables in Supabase Realtime settings.';
  end if;
end
$$;
