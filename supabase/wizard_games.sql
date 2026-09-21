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

revoke execute on function public.wizard_read(text) from public;
revoke execute on function public.wizard_write(text, jsonb, bigint) from public;
grant execute on function public.wizard_read(text) to anon, service_role;
grant execute on function public.wizard_write(text, jsonb, bigint) to anon, service_role;
