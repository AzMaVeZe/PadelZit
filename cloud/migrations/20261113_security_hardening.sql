-- 2026-11-13 — security & data-integrity hardening (audit findings).
-- Idempotent; safe to run more than once. The same definitions are folded
-- into cloud/setup.sql so a fresh project gets them too.

-- ---------------------------------------------------------------------------
-- 1. Anonymous live sharing: validate shape and size, cap rows per token,
--    expire abandoned guest rows, and make "stop sharing" actually delete.
-- ---------------------------------------------------------------------------
create or replace function public.publish_live(tid text, token text, tdata jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if tid is null or tid !~ '^[A-Za-z0-9_-]{1,64}$'
     or token is null or length(token) < 16 or length(token) > 128
     or tdata is null or jsonb_typeof(tdata) <> 'object'
     or pg_column_size(tdata) > 65536 then
    raise exception 'bad request';
  end if;
  -- players: 2–12 short strings
  if jsonb_typeof(tdata->'players') <> 'array' then raise exception 'bad request'; end if;
  n := jsonb_array_length(tdata->'players');
  if n < 2 or n > 12 or exists (
    select 1 from jsonb_array_elements(tdata->'players') p
    where jsonb_typeof(p) <> 'string' or length(p #>> '{}') > 40
  ) then raise exception 'bad request'; end if;
  -- history: an array of at most 500 games, if present
  if tdata ? 'history' and (jsonb_typeof(tdata->'history') <> 'array'
     or jsonb_array_length(tdata->'history') > 500) then
    raise exception 'bad request';
  end if;
  -- standings arrays, if present, must hold numbers only
  if exists (
    select 1 from unnest(array['points','gamesWon','gamesPlayed']) k
    where tdata ? k and (jsonb_typeof(tdata->k) <> 'array' or exists (
      select 1 from jsonb_array_elements(tdata->k) v where jsonb_typeof(v) <> 'number'))
  ) then raise exception 'bad request'; end if;

  -- Housekeeping: guest broadcasts untouched for 90 days are dropped.
  delete from public.tournaments where user_id is null and updated_at < now() - interval '90 days';

  -- One device token may hold at most 50 live rows.
  if not exists (select 1 from public.tournaments where id = tid)
     and (select count(*) from public.tournaments where user_id is null and write_token = token) >= 50 then
    raise exception 'too many';
  end if;

  insert into public.tournaments as t (id, user_id, data, is_public, write_token)
  values (tid, null, tdata, true, token)
  on conflict (id) do update
    set data = excluded.data, is_public = true, updated_at = now()
    where t.user_id is null and t.write_token = excluded.write_token;
end;
$$;
revoke all on function public.publish_live(text, text, jsonb) from public;
grant execute on function public.publish_live(text, text, jsonb) to anon, authenticated;

-- Stopping a guest broadcast deletes the row (previously it only hid it and
-- kept every player name forever).
create or replace function public.stop_live(tid text, token text)
returns void language sql security definer set search_path = public as $$
  delete from public.tournaments
  where id = tid and user_id is null and write_token = token;
$$;
revoke all on function public.stop_live(text, text) from public;
grant execute on function public.stop_live(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Profiles: the email column is the identity key for find_player /
--    request_friend, and friend_token is a bearer invite secret. Neither may
--    be chosen by the client. A trigger pins email to the signed JWT and keeps
--    friend_token server-generated; uniqueness makes lookups deterministic.
--    (SECURITY INVOKER on purpose: current_user is 'authenticated' for API
--    calls and the function owner inside SECURITY DEFINER RPCs such as
--    reset_friend_token, which are allowed to rotate the token.)
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.email := coalesce(nullif(auth.jwt() ->> 'email', ''), '');
    if tg_op = 'INSERT' then
      new.friend_token := gen_random_uuid();
    else
      new.user_id := old.user_id;
      new.friend_token := old.friend_token;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- Bring existing rows in line with auth (no-op today; defensive).
update public.profiles p set email = u.email
  from auth.users u
  where u.id = p.user_id and u.email is not null and p.email is distinct from u.email;

create unique index if not exists profiles_email_key
  on public.profiles (lower(email)) where email <> '';
create unique index if not exists profiles_friend_token_key
  on public.profiles (friend_token);

-- ---------------------------------------------------------------------------
-- 3. find_player: deterministic (email > nickname > name), and rate-limited
--    per account so it can't be used as a bulk email→identity oracle.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_events (
  uid uuid not null,
  kind text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (uid, kind, at);
alter table public.rate_events enable row level security;  -- RPC-only, no policies

create or replace function public.rate_ok(k text, lim int, win interval)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  delete from public.rate_events where at < now() - interval '1 day';
  if (select count(*) from public.rate_events
      where uid = auth.uid() and kind = k and at > now() - win) >= lim then
    return false;
  end if;
  insert into public.rate_events (uid, kind) values (auth.uid(), k);
  return true;
end;
$$;
revoke all on function public.rate_ok(text, int, interval) from public, anon, authenticated;

create or replace function public.find_player(q text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  qq text := lower(trim(coalesce(q, '')));
  res jsonb;
begin
  if qq = '' or length(qq) > 254 then return null; end if;
  if not public.rate_ok('find_player', 60, interval '1 hour') then return null; end if;
  select jsonb_build_object('uid', user_id, 'name', name, 'nickname', nickname) into res
  from public.profiles
  where lower(email) = qq
     or (nickname is not null and nickname <> '' and lower(nickname) = qq)
     or (name is not null and name <> '' and lower(name) = qq)
  order by (lower(email) = qq) desc,
           (coalesce(lower(nickname), '') = qq) desc,
           updated_at desc
  limit 1;
  return res;
end;
$$;
revoke all on function public.find_player(text) from public, anon;
grant execute on function public.find_player(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Friend requests: a declined request is remembered for 30 days (the
--    requester just sees "already pending"), and at most 30 new requests a
--    day per account.
-- ---------------------------------------------------------------------------
alter table public.friend_edges drop constraint if exists friend_edges_status_check;
alter table public.friend_edges add constraint friend_edges_status_check
  check (status in ('pending', 'accepted', 'declined'));

create or replace function public.request_friend(target_email text)
returns text language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  select user_id into target from public.profiles
    where email <> '' and lower(email) = lower(trim(target_email));
  if target is null then return 'not_found'; end if;
  if target = auth.uid() then return 'self'; end if;
  if exists (
    select 1 from public.friend_edges
    where status='accepted'
      and ((requester=auth.uid() and addressee=target) or (requester=target and addressee=auth.uid()))
  ) then
    return 'already_friends';
  end if;
  if exists (select 1 from public.friend_edges where requester=auth.uid() and addressee=target and status='pending') then
    return 'already_pending';
  end if;
  if exists (select 1 from public.friend_edges where requester=target and addressee=auth.uid() and status='pending') then
    update public.friend_edges set status='accepted', responded_at=now()
      where requester=target and addressee=auth.uid();
    return 'accepted';
  end if;
  if exists (select 1 from public.friend_edges where requester=auth.uid() and addressee=target and status='declined') then
    if (select responded_at from public.friend_edges where requester=auth.uid() and addressee=target) > now() - interval '30 days' then
      return 'already_pending';
    end if;
    delete from public.friend_edges where requester=auth.uid() and addressee=target;
  end if;
  if not public.rate_ok('request_friend', 30, interval '1 day') then return 'already_pending'; end if;
  insert into public.friend_edges (requester, addressee) values (auth.uid(), target);
  return 'sent';
end;
$$;
revoke all on function public.request_friend(text) from public, anon;
grant execute on function public.request_friend(text) to authenticated;

create or replace function public.respond_friend_request(requester_uid uuid, do_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if do_accept then
    update public.friend_edges set status='accepted', responded_at=now()
      where requester=requester_uid and addressee=auth.uid() and status='pending';
  else
    update public.friend_edges set status='declined', responded_at=now()
      where requester=requester_uid and addressee=auth.uid() and status='pending';
  end if;
end;
$$;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Leaderboard stats: a tournament owner may credit only themselves or
--    accepted friends (the client already enforced this; now the server does).
-- ---------------------------------------------------------------------------
create or replace function public.sync_tournament_stats(tid text, stats jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
  hist_len int;
  plist_len int;
  is_finished boolean;
  tclaims jsonb;
  rec jsonb;
  p_uid uuid;
  g_played int;
  g_won int;
  is_champ boolean;
begin
  select user_id, jsonb_array_length(coalesce(data->'history','[]'::jsonb)),
         jsonb_array_length(coalesce(data->'players','[]'::jsonb)),
         coalesce((data->>'finished')::boolean, false),
         data->'claims'
    into owner, hist_len, plist_len, is_finished, tclaims
    from public.tournaments where id = tid;
  if owner is null or owner <> auth.uid() then return; end if;
  if plist_len < 4 or hist_len < 3 or hist_len > 500 then return; end if;
  if tclaims is null or jsonb_typeof(tclaims) <> 'object' then return; end if;

  for rec in select * from jsonb_array_elements(coalesce(stats, '[]'::jsonb))
  loop
    begin
      p_uid := nullif(rec->>'uid', '')::uuid;
    exception when others then
      continue;
    end;
    if p_uid is null or not (tclaims ? p_uid::text) then continue; end if;
    if p_uid <> owner and not exists (
      select 1 from public.friend_edges e
      where e.status = 'accepted'
        and ((e.requester = owner and e.addressee = p_uid) or (e.requester = p_uid and e.addressee = owner))
    ) then continue; end if;
    g_played := greatest(0, least(coalesce((rec->>'played')::int, 0), hist_len));
    g_won := greatest(0, least(coalesce((rec->>'won')::int, 0), g_played));
    is_champ := coalesce((rec->>'champion')::boolean, false) and is_finished;
    insert into public.tournament_player_stats
      (tournament_id, player_uid, games_played, games_won, finished, is_champion, updated_at)
    values (tid, p_uid, g_played, g_won, is_finished, is_champ, now())
    on conflict (tournament_id, player_uid) do update
      set games_played = excluded.games_played, games_won = excluded.games_won,
          finished = excluded.finished, is_champion = excluded.is_champion, updated_at = now();
  end loop;
end;
$$;
revoke all on function public.sync_tournament_stats(text, jsonb) from public, anon;
grant execute on function public.sync_tournament_stats(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Sync integrity.
--    a) Never let an older copy of a tournament overwrite a newer one: the
--       client stamps every edit in data.updatedAt; a stale upsert is skipped.
--    b) Deleted tournaments leave a tombstone, so a device that still holds a
--       copy can neither resurrect it nor keep showing it.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_stamp(d jsonb)
returns bigint language sql immutable as $$
  select coalesce(
    case when jsonb_typeof(d->'updatedAt') = 'number' then (d->>'updatedAt')::numeric::bigint end,
    case when jsonb_typeof(d->'createdAt') = 'number' then (d->>'createdAt')::numeric::bigint end,
    0)
$$;

create or replace function public.tournaments_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.data is distinct from old.data
       and public.tournament_stamp(new.data) < public.tournament_stamp(old.data) then
      return null;                       -- stale write: keep the newer row
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists tournaments_guard on public.tournaments;
create trigger tournaments_guard before update on public.tournaments
  for each row execute function public.tournaments_guard();

create table if not exists public.tournament_tombstones (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now()
);
alter table public.tournament_tombstones enable row level security;
drop policy if exists tombstones_own_read on public.tournament_tombstones;
create policy tombstones_own_read on public.tournament_tombstones
  for select using (auth.uid() = user_id);

create or replace function public.tournaments_tombstone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.user_id is not null and exists (select 1 from auth.users where id = old.user_id) then
    insert into public.tournament_tombstones (id, user_id) values (old.id, old.user_id)
    on conflict (id) do update set deleted_at = now();
  end if;
  return old;
end;
$$;
drop trigger if exists tournaments_tombstone on public.tournaments;
create trigger tournaments_tombstone after delete on public.tournaments
  for each row execute function public.tournaments_tombstone();

create or replace function public.tournaments_no_resurrect()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.tournament_tombstones where id = new.id) then
    return null;                         -- deleted elsewhere: drop the insert
  end if;
  return new;
end;
$$;
drop trigger if exists tournaments_no_resurrect on public.tournaments;
create trigger tournaments_no_resurrect before insert on public.tournaments
  for each row execute function public.tournaments_no_resurrect();

-- delete_account: tournaments go first (their tombstones then cascade away
-- with the auth user).
create or replace function public.delete_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  delete from public.tournaments where user_id = auth.uid();
  delete from public.profiles where user_id = auth.uid();
  delete from public.rate_events where uid = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
