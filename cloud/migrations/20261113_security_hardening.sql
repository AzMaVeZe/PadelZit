-- 2026-11-13 — security & data-integrity hardening (audit findings).
-- Applied to the live project on 2026-11-19 (as hardening_part1/2a/2b/3).
-- Idempotent; safe to run more than once. Folded into cloud/setup.sql too.

-- Internal helpers and trigger functions live in a schema the REST API does
-- not expose, so they can't be called as /rest/v1/rpc/... endpoints.
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 1. Profiles: email is the identity key for find_player/request_friend and
--    friend_token is a bearer invite secret — neither may be client-chosen.
--    SECURITY INVOKER on purpose: current_user is 'authenticated' for API
--    calls, but the function owner inside SECURITY DEFINER RPCs such as
--    reset_friend_token, which may rotate the token.
-- ---------------------------------------------------------------------------
create or replace function private.profiles_guard()
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
create or replace trigger profiles_guard before insert or update on public.profiles
  for each row execute function private.profiles_guard();

create unique index if not exists profiles_email_key
  on public.profiles (lower(email)) where email <> '';
create unique index if not exists profiles_friend_token_key
  on public.profiles (friend_token);

-- ---------------------------------------------------------------------------
-- 2. Sync integrity: an older copy never overwrites a newer one (client
--    stamps every edit in data.updatedAt), and deletions leave a tombstone so
--    another device can neither resurrect nor keep showing the tournament.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_stamp(d jsonb)
returns bigint language sql immutable set search_path = '' as $$
  select coalesce(
    case when jsonb_typeof(d->'updatedAt') = 'number' then (d->>'updatedAt')::numeric::bigint end,
    case when jsonb_typeof(d->'createdAt') = 'number' then (d->>'createdAt')::numeric::bigint end,
    0)
$$;

create or replace function private.tournaments_guard()
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
create or replace trigger tournaments_guard before update on public.tournaments
  for each row execute function private.tournaments_guard();

create table if not exists public.tournament_tombstones (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now()
);
alter table public.tournament_tombstones enable row level security;
drop policy if exists tombstones_own_read on public.tournament_tombstones;
create policy tombstones_own_read on public.tournament_tombstones
  for select using (auth.uid() = user_id);

create or replace function private.tournaments_tombstone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.user_id is not null and exists (select 1 from auth.users where id = old.user_id) then
    insert into public.tournament_tombstones (id, user_id) values (old.id, old.user_id)
    on conflict (id) do update set deleted_at = now();
  end if;
  return old;
end;
$$;
create or replace trigger tournaments_tombstone after delete on public.tournaments
  for each row execute function private.tournaments_tombstone();

create or replace function private.tournaments_no_resurrect()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.tournament_tombstones where id = new.id) then
    return null;                         -- deleted elsewhere: drop the insert
  end if;
  return new;
end;
$$;
create or replace trigger tournaments_no_resurrect before insert on public.tournaments
  for each row execute function private.tournaments_no_resurrect();

-- ---------------------------------------------------------------------------
-- 3. Rate limits (find_player 60/hour, friend requests 30/day per account).
-- ---------------------------------------------------------------------------
create table if not exists public.rate_events (
  uid uuid not null,
  kind text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_idx on public.rate_events (uid, kind, at);
alter table public.rate_events enable row level security;   -- no policies: RPC-only

create or replace function private.rate_ok(k text, lim int, win interval)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if (select count(*) from public.rate_events
      where uid = auth.uid() and kind = k and at > now() - win) >= lim then
    return false;
  end if;
  insert into public.rate_events (uid, kind) values (auth.uid(), k);
  return true;
end;
$$;

-- find_player: deterministic (email > nickname > name) and rate-limited.
create or replace function public.find_player(q text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  qq text := lower(trim(coalesce(q, '')));
  res jsonb;
begin
  if qq = '' or length(qq) > 254 then return null; end if;
  if not private.rate_ok('find_player', 60, interval '1 hour') then return null; end if;
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
-- 4. Friend requests: a decline is remembered for 30 days (the requester
--    just sees "already pending"), plus the daily cap above.
-- ---------------------------------------------------------------------------
create table if not exists public.friend_declines (
  requester uuid not null references auth.users(id) on delete cascade,
  addressee uuid not null references auth.users(id) on delete cascade,
  declined_at timestamptz not null default now(),
  primary key (requester, addressee)
);
alter table public.friend_declines enable row level security;  -- RPC-only

-- respond_friend_request(decline) deletes the pending edge; remember it.
create or replace function private.remember_decline()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'pending' and auth.uid() = old.addressee then
    insert into public.friend_declines (requester, addressee) values (old.requester, old.addressee)
    on conflict (requester, addressee) do update set declined_at = now();
  end if;
  return old;
end;
$$;
create or replace trigger friend_edges_remember_decline after delete on public.friend_edges
  for each row execute function private.remember_decline();

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
  if exists (select 1 from public.friend_declines
             where requester=auth.uid() and addressee=target and declined_at > now() - interval '30 days') then
    return 'already_pending';          -- never reveal the decline
  end if;
  if not private.rate_ok('request_friend', 30, interval '1 day') then return 'already_pending'; end if;
  insert into public.friend_edges (requester, addressee) values (auth.uid(), target);
  return 'sent';
end;
$$;
revoke all on function public.request_friend(text) from public, anon;
grant execute on function public.request_friend(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Anonymous live sharing: validate shape and size, cap rows per device
--    token; stopping a broadcast wipes its content (names + scores).
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
  if jsonb_typeof(tdata->'players') <> 'array' then raise exception 'bad request'; end if;
  n := jsonb_array_length(tdata->'players');
  if n < 2 or n > 12 or exists (
    select 1 from jsonb_array_elements(tdata->'players') p
    where jsonb_typeof(p) <> 'string' or length(p #>> '{}') > 40
  ) then raise exception 'bad request'; end if;
  if tdata ? 'history' and (jsonb_typeof(tdata->'history') <> 'array'
     or jsonb_array_length(tdata->'history') > 500) then
    raise exception 'bad request';
  end if;
  if exists (
    select 1 from unnest(array['points','gamesWon','gamesPlayed']) k
    where tdata ? k and (jsonb_typeof(tdata->k) <> 'array' or exists (
      select 1 from jsonb_array_elements(tdata->k) v where jsonb_typeof(v) <> 'number'))
  ) then raise exception 'bad request'; end if;

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

create or replace function public.stop_live(tid text, token text)
returns void language sql security definer set search_path = public as $$
  update public.tournaments set is_public = false, data = '{}'::jsonb, updated_at = now()
  where id = tid and user_id is null and write_token = token;
$$;
revoke all on function public.stop_live(text, text) from public;
grant execute on function public.stop_live(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Leaderboard stats: a tournament owner may credit only themselves or
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
