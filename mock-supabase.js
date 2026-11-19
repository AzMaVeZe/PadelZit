// Minimal mock of the Supabase endpoints PadelZit uses (GoTrue + PostgREST).
const http = require('http');

const users = {};   // email -> {id, password}
const rows = {};    // id -> {id, user_id, data}
const tokens = {};  // access_token -> user_id
const codes = {};   // auth_code -> user_id  (PKCE)
const profiles = {}; // user_id -> {user_id, email, name, nickname, roster, friend_token}
const friendEdges = []; // {requester, addressee, status, created_at}
const tourStats = {}; // "tid|uid" -> {tournament_id, player_uid, games_played, games_won, finished, is_champion, updated_at}
const tombstones = {}; // tournament id -> owner uid (mirrors tournament_tombstones)
const stampOf = d => (d && (d.updatedAt || d.createdAt)) || 0;
function emailOf(uid) { const u = Object.values(users).find(x => x.id === uid); return u ? u.email : ''; }
let counter = 0;

function newToken() { return 'ft_' + (++counter) + '_' + Math.random().toString(36).slice(2); }
function ensureProfile(uid, email) {
  if (!profiles[uid]) profiles[uid] = { user_id: uid, email: email || '', name: null, nickname: null, roster: [], friend_token: newToken() };
  return profiles[uid];
}
function edgeBetween(a, b) { return friendEdges.find(e => (e.requester === a && e.addressee === b) || (e.requester === b && e.addressee === a)); }
function areFriends(a, b) { const e = edgeBetween(a, b); return !!e && e.status === 'accepted'; }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
};

function json(res, code, body) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS));
  res.end(JSON.stringify(body));
}

function makeSession(user) {
  const at = 'at_' + (++counter) + '_' + user.id;
  tokens[at] = user.id;
  return {
    access_token: at,
    refresh_token: 'rt_' + user.id,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: user.id, email: user.email },
  };
}

function authedUser(req) {
  const h = req.headers['authorization'] || '';
  const at = h.replace(/^Bearer /, '');
  return tokens[at] || null;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch (e) {}

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    if (path === '/auth/v1/signup' && req.method === 'POST') {
      if (!data || !/@/.test(data.email || '')) return json(res, 400, { error_code: 'validation_failed', msg: 'invalid email' });
      if ((data.password || '').length < 6) return json(res, 422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters' });
      if (users[data.email]) return json(res, 422, { error_code: 'user_already_exists', msg: 'User already registered' });
      const user = { id: 'u_' + (++counter), email: data.email, password: data.password };
      users[data.email] = user;
      return json(res, 200, makeSession(user));
    }

    // Provider round-trip (PKCE): pretend the user authenticated, redirect back with ?code=
    if (path === '/auth/v1/authorize' && req.method === 'GET') {
      const provider = url.searchParams.get('provider') || 'google';
      const redirectTo = url.searchParams.get('redirect_to') || '/';
      const email = provider + '.user@example.com';
      let user = users[email];
      if (!user) { user = { id: 'u_' + (++counter), email: email, password: null, provider: provider }; users[email] = user; }
      const code = 'code_' + (++counter);
      codes[code] = user.id;
      const sep = redirectTo.indexOf('?') === -1 ? '?' : '&';
      res.writeHead(302, Object.assign({ Location: redirectTo + sep + 'code=' + code }, CORS));
      res.end();
      return;
    }

    if (path === '/auth/v1/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'pkce') {
        const uid = codes[(data || {}).auth_code];
        delete codes[(data || {}).auth_code];
        const u = Object.values(users).find(x => x.id === uid);
        if (!u || !(data || {}).code_verifier) return json(res, 400, { error_code: 'invalid_grant' });
        return json(res, 200, makeSession(u));
      }
      if (grant === 'password') {
        const u = users[(data || {}).email];
        if (!u || u.password !== data.password) return json(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return json(res, 200, makeSession(u));
      }
      if (grant === 'refresh_token') {
        const uid = ((data || {}).refresh_token || '').replace('rt_', '');
        const u = Object.values(users).find(x => x.id === uid);
        if (!u) return json(res, 400, { error_code: 'invalid_grant' });
        return json(res, 200, makeSession(u));
      }
      return json(res, 400, { error_code: 'unsupported_grant_type' });
    }

    if (path === '/auth/v1/user' && req.method === 'GET') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const u = Object.values(users).find(x => x.id === uid);
      return json(res, 200, { id: uid, email: u ? u.email : null });
    }

    if (path === '/rest/v1/rpc/delete_account' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      Object.values(rows).filter(r => r.user_id === uid).forEach(r => delete rows[r.id]);
      delete profiles[uid];
      for (let i = friendEdges.length - 1; i >= 0; i--) {
        if (friendEdges[i].requester === uid || friendEdges[i].addressee === uid) friendEdges.splice(i, 1);
      }
      Object.keys(tourStats).forEach(k => { if (tourStats[k].player_uid === uid) delete tourStats[k]; });
      const u = Object.values(users).find(x => x.id === uid);
      if (u) delete users[u.email];
      res.writeHead(204, CORS); res.end(); return;
    }

    if (path === '/rest/v1/tournaments') {
      const uid = authedUser(req);
      const idFilter = url.searchParams.get('id') || '';
      const id = idFilter ? decodeURIComponent(idFilter.replace(/^eq\./, '')) : null;

      if (req.method === 'GET') {
        // Anon (no JWT): NO direct row access at all — the public share path is
        // the get_public_tournament RPC only (mirrors the fixed RLS setup).
        if (!uid) return json(res, 200, []);
        // Authenticated: RLS visibility is own rows + (historically) public rows.
        // Mirror the WORST-CASE production policy so tests catch pulls that
        // forget to filter by user_id: visible = own OR is_public.
        let visible = Object.values(rows).filter(r => r.user_id === uid || r.is_public);
        // Honor PostgREST-style filters the way the real API does.
        const uidFilter = url.searchParams.get('user_id') || '';
        if (uidFilter) {
          const want = decodeURIComponent(uidFilter.replace(/^eq\./, ''));
          visible = visible.filter(r => r.user_id === want);
        }
        if (id) visible = visible.filter(r => r.id === id);
        return json(res, 200, visible.map(r => ({ id: r.id, data: r.data, is_public: !!r.is_public })));
      }
      if (!uid) return json(res, 401, { message: 'JWT required' });
      if (req.method === 'POST') {
        const arr = Array.isArray(data) ? data : [data];
        arr.forEach(r => {
          const existing = rows[r.id];
          // Mirrors the hardened DB: RLS refuses another user's row, a deleted
          // id can't be re-inserted (tombstone), and an older copy never
          // overwrites a newer one (tournaments_guard).
          if (existing && existing.user_id !== uid) return;
          if (!existing && tombstones[r.id]) return;
          if (existing && stampOf(r.data) < stampOf(existing.data)) return;
          rows[r.id] = { id: r.id, user_id: uid, data: r.data, is_public: existing ? existing.is_public : false };
        });
        res.writeHead(201, CORS); res.end(); return;
      }
      if (req.method === 'PATCH') {
        if (rows[id] && rows[id].user_id === uid && data && typeof data.is_public === 'boolean') {
          rows[id].is_public = data.is_public;
        }
        res.writeHead(204, CORS); res.end(); return;
      }
      if (req.method === 'DELETE') {
        if (rows[id] && rows[id].user_id === uid) { delete rows[id]; tombstones[id] = uid; }
        res.writeHead(204, CORS); res.end(); return;
      }
    }
    if (path === '/rest/v1/tournament_tombstones' && req.method === 'GET') {
      const uid = authedUser(req);
      if (!uid) return json(res, 200, []);
      return json(res, 200, Object.keys(tombstones).filter(id => tombstones[id] === uid).map(id => ({ id })));
    }

    // Player profiles: own-row read/write + exact-match directory lookup.
    if (path === '/rest/v1/profiles') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      if (req.method === 'GET') {
        const p = profiles[uid];
        return json(res, 200, p ? [p] : []);
      }
      if (req.method === 'POST') {
        const row = Array.isArray(data) ? data[0] : data;
        // Mirror the DB's case-insensitive unique index on lower(nickname):
        // a nickname already held by ANOTHER account is a conflict (23505 →
        // HTTP 409), just like Postgres surfaces it through PostgREST.
        const nick = (row.nickname || '').trim();
        if (nick && Object.values(profiles).some(p => p.user_id !== uid &&
            p.nickname && p.nickname.toLowerCase() === nick.toLowerCase())) {
          return json(res, 409, { code: '23505', message: 'duplicate key value violates unique constraint "profiles_nickname_key"' });
        }
        // Mirrors the real upsert (on_conflict=user_id, merge-duplicates):
        // fields not present in the payload — notably friend_token — are left
        // untouched on an existing row, not wiped.
        const existing = profiles[uid];
        profiles[uid] = {
          // Email comes from the account (profiles_guard), never the client.
          user_id: uid, email: emailOf(uid) || '',
          name: row.name || null, nickname: row.nickname || null, roster: row.roster || [],
          friend_token: (existing && existing.friend_token) || newToken(),
        };
        res.writeHead(201, CORS); res.end(); return;
      }
    }
    if (path === '/rest/v1/rpc/find_player' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const q = String((data || {}).q || '').trim().toLowerCase();
      const hit = Object.values(profiles).find(p =>
        (p.email && p.email.toLowerCase() === q) ||
        (p.nickname && p.nickname.toLowerCase() === q) ||
        (p.name && p.name.toLowerCase() === q));
      return json(res, 200, hit ? { uid: hit.user_id, name: hit.name, nickname: hit.nickname } : null);
    }

    // ---- Friends ----
    if (path === '/rest/v1/rpc/reset_friend_token' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const u = Object.values(users).find(x => x.id === uid);
      const p = ensureProfile(uid, u ? u.email : '');
      p.friend_token = newToken();
      return json(res, 200, p.friend_token);
    }
    if (path === '/rest/v1/rpc/resolve_invite' && req.method === 'POST') {
      // Anon-callable, like the real RPC — a friend_token is a random secret,
      // not a guessable email/nickname.
      const token = (data || {}).token;
      const hit = Object.values(profiles).find(p => p.friend_token === token);
      return json(res, 200, hit ? { uid: hit.user_id, name: hit.name, nickname: hit.nickname } : null);
    }
    if (path === '/rest/v1/rpc/accept_invite' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const token = (data || {}).token;
      const inviter = Object.values(profiles).find(p => p.friend_token === token);
      if (!inviter) return json(res, 200, 'not_found');
      if (inviter.user_id === uid) return json(res, 200, 'self');
      const e = edgeBetween(inviter.user_id, uid);
      if (e) { e.status = 'accepted'; }
      else { friendEdges.push({ requester: inviter.user_id, addressee: uid, status: 'accepted', created_at: new Date().toISOString() }); }
      return json(res, 200, 'accepted');
    }
    if (path === '/rest/v1/rpc/request_friend' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const email = String((data || {}).target_email || '').trim().toLowerCase();
      const target = Object.values(profiles).find(p => (p.email || '').toLowerCase() === email);
      if (!target) return json(res, 200, 'not_found');
      if (target.user_id === uid) return json(res, 200, 'self');
      if (areFriends(uid, target.user_id)) return json(res, 200, 'already_friends');
      const mine = friendEdges.find(e => e.requester === uid && e.addressee === target.user_id && e.status === 'pending');
      if (mine) return json(res, 200, 'already_pending');
      const theirs = friendEdges.find(e => e.requester === target.user_id && e.addressee === uid && e.status === 'pending');
      if (theirs) { theirs.status = 'accepted'; return json(res, 200, 'accepted'); }
      friendEdges.push({ requester: uid, addressee: target.user_id, status: 'pending', created_at: new Date().toISOString() });
      return json(res, 200, 'sent');
    }
    if (path === '/rest/v1/rpc/respond_friend_request' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const { requester_uid, do_accept } = data || {};
      const idx = friendEdges.findIndex(e => e.requester === requester_uid && e.addressee === uid && e.status === 'pending');
      if (idx !== -1) {
        if (do_accept) friendEdges[idx].status = 'accepted';
        else friendEdges.splice(idx, 1);
      }
      res.writeHead(204, CORS); res.end(); return;
    }
    if (path === '/rest/v1/rpc/unfriend' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const other = (data || {}).other_uid;
      for (let i = friendEdges.length - 1; i >= 0; i--) {
        const e = friendEdges[i];
        if ((e.requester === uid && e.addressee === other) || (e.requester === other && e.addressee === uid)) friendEdges.splice(i, 1);
      }
      res.writeHead(204, CORS); res.end(); return;
    }
    if (path === '/rest/v1/rpc/list_friend_state' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const friends = friendEdges
        .filter(e => e.status === 'accepted' && (e.requester === uid || e.addressee === uid))
        .map(e => { const other = e.requester === uid ? e.addressee : e.requester; const p = profiles[other]; return p ? { uid: p.user_id, name: p.name, nickname: p.nickname } : null; })
        .filter(Boolean);
      const pending = friendEdges
        .filter(e => e.status === 'pending' && e.addressee === uid)
        .map(e => { const p = profiles[e.requester]; return p ? { uid: p.user_id, name: p.name, nickname: p.nickname, since: e.created_at } : null; })
        .filter(Boolean);
      return json(res, 200, { friends, pending });
    }
    if (path === '/rest/v1/rpc/sync_tournament_stats' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const { tid, stats } = data || {};
      const tour = rows[tid];
      if (!tour || tour.user_id !== uid) { res.writeHead(204, CORS); res.end(); return; }
      const hist = (tour.data && tour.data.history) || [];
      const players = (tour.data && tour.data.players) || [];
      const claims = (tour.data && tour.data.claims) || {};
      if (players.length < 4 || hist.length < 3 || typeof claims !== 'object') { res.writeHead(204, CORS); res.end(); return; }
      (Array.isArray(stats) ? stats : []).forEach(rec => {
        const pUid = rec && rec.uid;
        if (!pUid || !(pUid in claims)) return;
        const played = Math.max(0, Math.min(Number(rec.played) || 0, hist.length));
        const won = Math.max(0, Math.min(Number(rec.won) || 0, played));
        const isChamp = !!rec.champion && !!tour.data.finished;
        tourStats[tid + '|' + pUid] = {
          tournament_id: tid, player_uid: pUid, games_played: played, games_won: won,
          finished: !!tour.data.finished, is_champion: isChamp, updated_at: new Date().toISOString(),
        };
      });
      res.writeHead(204, CORS); res.end(); return;
    }
    if (path === '/rest/v1/rpc/get_friends_leaderboard' && req.method === 'POST') {
      const uid = authedUser(req);
      if (!uid) return json(res, 401, { message: 'JWT required' });
      const circle = new Set([uid]);
      friendEdges.filter(e => e.status === 'accepted' && (e.requester === uid || e.addressee === uid))
        .forEach(e => circle.add(e.requester === uid ? e.addressee : e.requester));
      const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM, matches date_trunc('month')
      const out = [...circle].map(pUid => {
        const p = profiles[pUid];
        if (!p) return null;
        const mine = Object.values(tourStats).filter(s => s.player_uid === pUid);
        const pts = s => s.games_played + s.games_won * 2 + (s.finished ? 3 : 0) + (s.is_champion ? 10 : 0);
        const month_score = mine.filter(s => s.updated_at.slice(0, 7) === monthKey).reduce((a, s) => a + pts(s), 0);
        const alltime_score = mine.reduce((a, s) => a + pts(s), 0);
        const titles = mine.filter(s => s.is_champion).length;
        const games_won = mine.reduce((a, s) => a + s.games_won, 0);
        return { uid: p.user_id, name: p.name, nickname: p.nickname, month_score, alltime_score, titles, games_won };
      }).filter(Boolean).sort((a, b) => b.month_score - a.month_score || b.alltime_score - a.alltime_score);
      return json(res, 200, out);
    }

    // Account-free live publish: create/update an ownerless row keyed by
    // the device's write token (mirrors publish_live's ON CONFLICT ... WHERE:
    // wrong token = silent no-op, same as production).
    if (path === '/rest/v1/rpc/publish_live' && req.method === 'POST') {
      const { tid, token, tdata } = data || {};
      if (!tid || !token || String(token).length < 16 || !tdata) return json(res, 400, { message: 'bad request' });
      const r = rows[tid];
      if (!r) rows[tid] = { id: tid, user_id: null, data: tdata, is_public: true, write_token: token };
      else if (r.user_id === null && r.write_token === token) { r.data = tdata; r.is_public = true; }
      res.writeHead(204, CORS); res.end(); return;
    }
    if (path === '/rest/v1/rpc/stop_live' && req.method === 'POST') {
      const { tid, token } = data || {};
      const r = rows[tid];
      if (r && r.user_id === null && r.write_token === token) r.is_public = false;
      res.writeHead(204, CORS); res.end(); return;
    }

    // Public share read: fetch-by-exact-id, scrubbed of account-linked fields.
    if (path === '/rest/v1/rpc/get_public_tournament' && req.method === 'POST') {
      const tid = (data || {}).tid;
      const r = tid && rows[tid];
      if (!(r && r.is_public)) return json(res, 200, null);
      const scrubbed = Object.assign({}, r.data);
      delete scrubbed.claims; delete scrubbed.meIndex; delete scrubbed.links;
      return json(res, 200, scrubbed);
    }

    // debug endpoint for tests
    if (path === '/__state') return json(res, 200, {
      users: Object.keys(users),
      rows: Object.values(rows).map(r => ({ id: r.id, user_id: r.user_id, is_public: !!r.is_public, games: (r.data && r.data.history || []).length })),
      friendEdges: friendEdges.slice(),
      tourStats: Object.values(tourStats),
    });

    json(res, 404, { message: 'not found: ' + req.method + ' ' + path });
  });
});

server.listen(9021, () => console.log('mock supabase on :9021'));
