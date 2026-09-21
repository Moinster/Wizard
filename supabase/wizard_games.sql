-- Wizard scorekeeper: one row per table, written by compare-and-swap.
--
-- Run this once in the Supabase SQL editor. It adds one table and two
-- functions, all prefixed wizard_, and touches nothing else, so it is safe in
-- a database other things already use. The table is closed to every API role;
-- the two functions are the only way in, and a four-letter code is the only
-- handle. Idempotent: running it again changes nothing.

create table if not exists public.wizard_games (
  code       text primary key,
  data       jsonb not null,
  version    bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wizard_games enable row level security;
revoke all on table public.wizard_games from anon, authenticated;

-- The game and the version to write against. Empty when there is no such code.
create or replace function public.wizard_read(p_code text)
returns table (data jsonb, version bigint)
language sql
security definer
set search_path = public
stable
as $$
  select data, version from public.wizard_games where code = p_code;
$$;

-- Create (p_version null) or replace the game if p_version still holds.
-- Returns the new version, or null when the write lost: someone else wrote
-- first, or a create found the code taken.
--
-- Games exist only while they are being played. Every create sweeps out
-- what nobody closed: a finished game an hour on, or any game untouched
-- for a day. No cron, no extra service; the table stays the size of the
-- evening's play.
create or replace function public.wizard_write(p_code text, p_data jsonb, p_version bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
begin
  if p_version is null then
    delete from public.wizard_games
      where updated_at < now() - interval '24 hours'
         or (data->>'status' = 'done' and updated_at < now() - interval '1 hour');
    insert into public.wizard_games (code, data)
      values (p_code, p_data)
      on conflict (code) do nothing
      returning version into v;
  else
    update public.wizard_games
      set data = p_data, version = version + 1, updated_at = now()
      where code = p_code and version = p_version
      returning version into v;
  end if;
  return v;
end;
$$;

-- The scorekeeper closing a finished table. True if there was one to close.
create or replace function public.wizard_delete(p_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  with gone as (delete from public.wizard_games where code = p_code returning 1)
  select count(*) > 0 from gone;
$$;

revoke execute on function public.wizard_read(text) from public;
revoke execute on function public.wizard_write(text, jsonb, bigint) from public;
revoke execute on function public.wizard_delete(text) from public;
grant execute on function public.wizard_read(text) to anon, service_role;
grant execute on function public.wizard_write(text, jsonb, bigint) to anon, service_role;
grant execute on function public.wizard_delete(text) to anon, service_role;
