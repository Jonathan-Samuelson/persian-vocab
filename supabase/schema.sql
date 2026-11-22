-- =====================================================================
--  Persian vocabulary trainer: database setup for Supabase (Free plan)
--  Paste this whole file into Supabase > SQL Editor and press "Run".
--  Safe to run again: it recreates the functions and keeps existing data.
--
--  Security model
--  * The browser never touches the tables. Row Level Security is on with
--    no policies, and all table privileges are revoked from the public
--    roles (anon, authenticated).
--  * The site only calls the functions below (via /rest/v1/rpc/...).
--    Each one checks a session token that login/register hand out.
--  * PINs are stored as bcrypt hashes. 10 wrong PINs within 24 hours lock
--    the account for 24 hours. A correct PIN resets the count.
--    The admin can unlock from the site; if the admin is locked out,
--    run in the SQL Editor:  select public.unlock_user('full name');
--  * The user cap (default 30, max 30) and the class code are enforced
--    here, on the server.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------------------------------------------------
create table if not exists public.app_settings (
  id          int primary key default 1 check (id = 1),
  class_code  text not null default 'farsi2026',
  max_users   int  not null default 30 check (max_users between 1 and 30)
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.app_users (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  name_key        text not null unique,          -- normalized name: no duplicates
  pin_hash        text not null,
  is_admin        boolean not null default false,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  last_seen       timestamptz not null default now()
);

-- when the current run of wrong PINs started (the count resets 24h after it)
alter table public.app_users add column if not exists first_failed_at timestamptz;

create table if not exists public.app_sessions (
  token      uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '180 days'
);
create index if not exists app_sessions_user_idx on public.app_sessions(user_id);

create table if not exists public.app_progress (
  user_id    uuid not null references public.app_users(id) on delete cascade,
  item_id    text not null check (length(item_id) <= 200),
  status     smallint not null check (status in (1, 2)),   -- 1 = learning, 2 = known
  correct    int not null default 0,
  wrong      int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.app_settings enable row level security;
alter table public.app_users    enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_progress enable row level security;
revoke all on public.app_settings, public.app_users, public.app_sessions, public.app_progress
  from anon, authenticated;

-- ---------- helpers (not callable from the site) -----------------------
create or replace function public._norm_name(p text) returns text
language sql immutable as $$
  select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

create or replace function public._session_user(p_token uuid) returns public.app_users
language plpgsql security definer set search_path = public as $$
declare u public.app_users;
begin
  select au.* into u
    from public.app_sessions s join public.app_users au on au.id = s.user_id
   where s.token = p_token and s.expires_at > now();
  if not found then
    raise exception 'SESSION_EXPIRED';
  end if;
  update public.app_users set last_seen = now() where id = u.id and last_seen < now() - interval '5 minutes';
  return u;
end $$;

create or replace function public._require_admin(p_token uuid) returns public.app_users
language plpgsql security definer set search_path = public as $$
declare u public.app_users;
begin
  u := public._session_user(p_token);
  if not u.is_admin then raise exception 'NOT_ADMIN'; end if;
  return u;
end $$;

create or replace function public._new_session(p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  delete from public.app_sessions where expires_at < now();
  insert into public.app_sessions (user_id) values (p_user) returning token into t;
  return t;
end $$;

-- ---------- public functions: account ---------------------------------
create or replace function public.ping() returns text
language sql security definer set search_path = public as $$ select 'ok' $$;

create or replace function public.register(p_name text, p_pin text, p_class_code text)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.app_settings;
  k text := public._norm_name(p_name);
  n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  uid uuid;
begin
  select * into s from public.app_settings where id = 1;
  if coalesce(btrim(p_class_code), '') <> s.class_code then raise exception 'BAD_CLASS_CODE'; end if;
  if length(n) < 3 or length(n) > 60 or position(' ' in n) = 0 then raise exception 'BAD_NAME'; end if;
  if p_pin !~ '^[0-9]{4}$' then raise exception 'BAD_PIN'; end if;
  perform pg_advisory_xact_lock(724411);                 -- one registration at a time
  if (select count(*) from public.app_users) >= s.max_users then raise exception 'FULL'; end if;
  if exists (select 1 from public.app_users where name_key = k) then raise exception 'NAME_TAKEN'; end if;
  insert into public.app_users (display_name, name_key, pin_hash)
       values (n, k, crypt(p_pin, gen_salt('bf'))) returning id into uid;
  return json_build_object('token', public._new_session(uid), 'name', n, 'is_admin', false);
end $$;

create or replace function public.login(p_name text, p_pin text) returns json
language plpgsql security definer set search_path = public, extensions as $$
-- Errors are returned as {"error": ...} instead of raised, so that the
-- failed-attempt counter is committed (a raised error would roll it back).
declare
  u public.app_users;
  fails int;
  first_fail timestamptz;
begin
  select * into u from public.app_users where name_key = public._norm_name(p_name) for update;
  if not found then return json_build_object('error', 'NO_SUCH_USER'); end if;
  if u.locked_until is not null and u.locked_until > now() then
    return json_build_object('error', 'LOCKED', 'locked_until', u.locked_until);
  end if;
  -- a run of wrong PINs older than 24 hours no longer counts
  fails := u.failed_attempts; first_fail := u.first_failed_at;
  if first_fail is null or first_fail < now() - interval '24 hours' then fails := 0; first_fail := null; end if;
  if u.pin_hash <> crypt(coalesce(p_pin, ''), u.pin_hash) then
    fails := fails + 1; first_fail := coalesce(first_fail, now());
    if fails >= 10 then
      update public.app_users set failed_attempts = 0, first_failed_at = null, locked_until = now() + interval '24 hours'
       where id = u.id;
      delete from public.app_sessions where user_id = u.id;
      return json_build_object('error', 'LOCKED', 'locked_until', now() + interval '24 hours');
    end if;
    update public.app_users set failed_attempts = fails, first_failed_at = first_fail where id = u.id;
    return json_build_object('error', 'BAD_PIN', 'remaining', 10 - fails);
  end if;
  update public.app_users set failed_attempts = 0, first_failed_at = null, locked_until = null, last_seen = now() where id = u.id;
  return json_build_object('token', public._new_session(u.id), 'name', u.display_name, 'is_admin', u.is_admin);
end $$;

create or replace function public.whoami(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare u public.app_users;
begin
  u := public._session_user(p_token);
  return json_build_object('name', u.display_name, 'is_admin', u.is_admin);
end $$;

create or replace function public.logout(p_token uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.app_sessions where token = p_token
$$;

-- ---------- public functions: progress --------------------------------
create or replace function public.get_progress(p_token uuid)
returns table (item_id text, status smallint, correct int, wrong int, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare u public.app_users;
begin
  u := public._session_user(p_token);
  return query select p.item_id, p.status, p.correct, p.wrong, p.updated_at
                 from public.app_progress p where p.user_id = u.id;
end $$;

-- p_items: [{"id": "...", "status": 1|2, "correct": n, "wrong": n}, ...]
-- correct/wrong are increments from this batch of answers.
create or replace function public.save_progress(p_token uuid, p_items json) returns int
language plpgsql security definer set search_path = public as $$
declare u public.app_users; n int;
begin
  u := public._session_user(p_token);
  if json_array_length(p_items) > 500 then raise exception 'TOO_MANY'; end if;
  insert into public.app_progress as ap (user_id, item_id, status, correct, wrong, updated_at)
  select u.id, x.id, x.status, greatest(coalesce(x.correct, 0), 0), greatest(coalesce(x.wrong, 0), 0), now()
    from json_to_recordset(p_items) as x(id text, status smallint, correct int, wrong int)
   where x.id is not null and x.status in (1, 2)
  on conflict (user_id, item_id) do update
     set status = excluded.status,
         correct = ap.correct + excluded.correct,
         wrong = ap.wrong + excluded.wrong,
         updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.reset_my_progress(p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u public.app_users;
begin
  u := public._session_user(p_token);
  delete from public.app_progress where user_id = u.id;
end $$;

-- ---------- public functions: admin -----------------------------------
drop function if exists public.admin_overview(uuid);   -- its columns changed
create or replace function public.admin_overview(p_token uuid)
returns table (user_id uuid, name text, is_admin boolean, created_at timestamptz, last_seen timestamptz,
               known int, learning int, answers int, locked boolean, locked_until timestamptz, failed_attempts int)
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin(p_token);
  return query
    select au.id, au.display_name, au.is_admin, au.created_at, au.last_seen,
           coalesce(sum((p.status = 2)::int), 0)::int,
           coalesce(sum((p.status = 1)::int), 0)::int,
           coalesce(sum(p.correct + p.wrong), 0)::int,
           (au.locked_until is not null and au.locked_until > now()),
           case when au.locked_until > now() then au.locked_until end,
           case when au.first_failed_at > now() - interval '24 hours' then au.failed_attempts else 0 end
      from public.app_users au left join public.app_progress p on p.user_id = au.id
     group by au.id order by au.display_name;
end $$;

create or replace function public.admin_unlock_user(p_token uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin(p_token);
  update public.app_users set locked_until = null, failed_attempts = 0, first_failed_at = null where id = p_user;
end $$;

create or replace function public.admin_user_progress(p_token uuid, p_user uuid)
returns table (item_id text, status smallint, correct int, wrong int, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin(p_token);
  return query select p.item_id, p.status, p.correct, p.wrong, p.updated_at
                 from public.app_progress p where p.user_id = p_user;
end $$;

create or replace function public.admin_get_settings(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare s public.app_settings;
begin
  perform public._require_admin(p_token);
  select * into s from public.app_settings where id = 1;
  return json_build_object('class_code', s.class_code, 'max_users', s.max_users,
                           'user_count', (select count(*) from public.app_users));
end $$;

create or replace function public.admin_set_settings(p_token uuid, p_class_code text, p_max_users int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin(p_token);
  if length(btrim(coalesce(p_class_code, ''))) < 4 then raise exception 'BAD_CLASS_CODE'; end if;
  update public.app_settings set class_code = btrim(p_class_code), max_users = p_max_users where id = 1;
end $$;

create or replace function public.admin_reset_pin(p_token uuid, p_user uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._require_admin(p_token);
  if p_pin !~ '^[0-9]{4}$' then raise exception 'BAD_PIN'; end if;
  update public.app_users set pin_hash = crypt(p_pin, gen_salt('bf')), failed_attempts = 0, first_failed_at = null,
         locked_until = null
   where id = p_user;
  delete from public.app_sessions where user_id = p_user;
end $$;

create or replace function public.admin_delete_user(p_token uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me public.app_users;
begin
  me := public._require_admin(p_token);
  if me.id = p_user then raise exception 'CANNOT_DELETE_SELF'; end if;
  delete from public.app_users where id = p_user;
end $$;

create or replace function public.admin_export(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin(p_token);
  return json_build_object(
    'exported_at', now(),
    'users', (select coalesce(json_agg(json_build_object('id', id, 'name', display_name, 'is_admin', is_admin,
                     'created_at', created_at, 'last_seen', last_seen)), '[]'::json) from public.app_users),
    'progress', (select coalesce(json_agg(json_build_object('user_id', user_id, 'item_id', item_id, 'status', status,
                     'correct', correct, 'wrong', wrong, 'updated_at', updated_at)), '[]'::json) from public.app_progress));
end $$;

-- Run this yourself in the SQL Editor after you register on the site:
--   select public.make_admin('your full name');
create or replace function public.make_admin(p_name text) returns text
language plpgsql security definer set search_path = public as $$
begin
  update public.app_users set is_admin = true where name_key = public._norm_name(p_name);
  if not found then return 'no user with that name'; end if;
  return 'ok';
end $$;

-- Emergency unlock, for when the admin is the one locked out. SQL Editor only:
--   select public.unlock_user('your full name');
create or replace function public.unlock_user(p_name text) returns text
language plpgsql security definer set search_path = public as $$
begin
  update public.app_users set locked_until = null, failed_attempts = 0, first_failed_at = null
   where name_key = public._norm_name(p_name);
  if not found then return 'no user with that name'; end if;
  return 'ok';
end $$;

-- ---------- who may call what ------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.ping(), public.register(text, text, text), public.login(text, text), public.whoami(uuid),
  public.logout(uuid), public.get_progress(uuid), public.save_progress(uuid, json), public.reset_my_progress(uuid),
  public.admin_overview(uuid), public.admin_user_progress(uuid, uuid), public.admin_get_settings(uuid),
  public.admin_set_settings(uuid, text, int), public.admin_reset_pin(uuid, uuid, text),
  public.admin_delete_user(uuid, uuid), public.admin_export(uuid), public.admin_unlock_user(uuid, uuid)
to anon;
-- make_admin, unlock_user and the _helpers stay callable only from the SQL Editor.
