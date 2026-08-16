-- Add the platform-wide role stored on each application profile.
-- The guards make this safe to reconcile with the live project, where the
-- change was initially applied manually.

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'platform_role'
      and n.nspname = 'public'
  ) then
    create type public.platform_role as enum ('user', 'admin');
  end if;
end
$$;

alter table public.profiles
  add column if not exists platform_role public.platform_role not null default 'user';
