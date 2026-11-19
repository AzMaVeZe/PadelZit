// End-to-end verification of the privacy model:
// 1. A plays → no other visitor/account sees it.
// 2. A shares a live-view link → ONLY someone with that exact link sees it (read-only).
// 3. Anyone on the main URL starts their own game / sees only their own saved games.
// 4. A tournament A did NOT share is not readable even by guessing the r.html link.
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK = 'http://localhost:9021';

(async () => {
  const browser = await chromium.launch();
  const mkctx = async () => {
    const c = await browser.newContext({ reducedMotion: 'reduce' });
    await c.addInitScript(() => {
      localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
      localStorage.setItem('padelzit-cloud-key', 'k');
    });
    return c;
  };

  // ---- User A: sign in, play, share ONE of two tournaments ----
  const ctxA = await mkctx();
  const pa = await ctxA.newPage();
  await pa.goto('http://localhost:8000/index.html');
  if (await pa.isVisible('#cloud-open-btn')) await pa.click('#cloud-open-btn');
  await pa.fill('#cloud-email', 'a@test.com');
  await pa.fill('#cloud-pass', 'secret123');
  await pa.click('#cloud-signup-btn');
  await sleep(500);

  // Tournament 1 — shared live.
  await pa.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await pa.fill('#p' + i, ['Alef', 'Bet', 'Gimel', 'Dalet'][i]);
  await pa.click('#start-btn');
  await pa.fill('#scoreA', '20'); await pa.click('#save-btn');
  await sleep(1600);
  await pa.click('#share-live-btn');
  await sleep(1200);
  const waHref = decodeURIComponent(await pa.getAttribute('#live-wa', 'href'));
  const sharedId = (waHref.match(/r\.html\?t=([A-Za-z0-9_-]+)/) || [])[1];
  if (!sharedId) throw new Error('could not extract shared link id from ' + waHref);

  // Tournament 2 — NOT shared.
  await pa.click('#game-home-btn');
  await pa.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await pa.fill('#p' + i, ['Hey', 'Vav', 'Zain', 'Het'][i]);
  await pa.click('#start-btn');
  await pa.fill('#scoreA', '15'); await pa.click('#save-btn');
  await sleep(1600);
  const state = await (await fetch(MOCK + '/__state')).json();
  if (state.rows.length !== 2) throw new Error('expected 2 cloud rows for A, got ' + state.rows.length);
  const privateId = state.rows.find(r => !r.is_public).id;
  if (!privateId || privateId === sharedId) throw new Error('could not identify the unshared tournament');
  console.log('[setup] A has 2 tournaments in cloud; one shared (' + sharedId + '), one private: OK');

  // ---- Check 1: anonymous visitor on the MAIN URL sees nothing of A, can play their own ----
  const ctxAnon = await mkctx();
  const pn = await ctxAnon.newPage();
  await pn.goto('http://localhost:8000/index.html');
  await sleep(400);
  let n = await pn.$$eval('#tournament-list .tour-item', e => e.length);
  if (n !== 0) throw new Error('anonymous visitor sees ' + n + ' tournaments (should be 0)');
  const bodyTxt = await pn.textContent('body');
  if (/Alef|Gimel|Dalet|Vav|Zain/.test(bodyTxt)) throw new Error("anonymous visitor can see A's player names");
  // ...and can start a game of their own.
  await pn.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await pn.fill('#p' + i, ['Own1', 'Own2', 'Own3', 'Own4'][i]);
  await pn.click('#start-btn');
  await pn.fill('#scoreA', '10'); await pn.click('#save-btn');
  await sleep(400);
  if (!/Own1/.test(await pn.textContent('#leaderboard-body'))) throw new Error('anonymous visitor could not play their own game');
  console.log('[1] Main URL, anonymous: sees nothing of A, starts their own game: OK');

  // ---- Check 2: a different signed-in account sees only ITS OWN saved games ----
  const ctxB = await mkctx();
  const pb = await ctxB.newPage();
  await pb.goto('http://localhost:8000/index.html');
  if (await pb.isVisible('#cloud-open-btn')) await pb.click('#cloud-open-btn');
  await pb.fill('#cloud-email', 'b@test.com');
  await pb.fill('#cloud-pass', 'secret456');
  await pb.click('#cloud-signup-btn');
  await sleep(1200);
  n = await pb.$$eval('#tournament-list .tour-item', e => e.length);
  if (n !== 0) throw new Error("account B sees " + n + " of A's tournaments (should be 0, even though one is shared)");
  // B saves a game of their own, signs out and back in — sees exactly their own.
  await pb.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await pb.fill('#p' + i, ['B1', 'B2', 'B3', 'B4'][i]);
  await pb.click('#start-btn');
  await pb.fill('#scoreA', '12'); await pb.click('#save-btn');
  await sleep(1600);
  await pb.click('#user-chip'); await sleep(150); await pb.click('#menu-logout'); await sleep(400);
  if (await pb.isVisible('#cloud-open-btn')) await pb.click('#cloud-open-btn');
  await pb.fill('#cloud-email', 'b@test.com');
  await pb.fill('#cloud-pass', 'secret456');
  await pb.click('#cloud-login-btn');
  await sleep(1600);
  const bTxt = await pb.textContent('#tournament-list');
  if (!/B1/.test(bTxt)) throw new Error('B does not see their own saved tournament after re-login');
  if (/Alef|Hey/.test(bTxt)) throw new Error("B sees A's tournaments");
  console.log('[2] Signed-in account B: sees only its own saved games, never A’s: OK');

  // ---- Check 3: ONLY the exact share link exposes the shared tournament (read-only) ----
  // r.html reads via the fetch-by-exact-id RPC with the anon key — simulate that.
  const anonRpc = async id => {
    const res = await fetch(MOCK + '/rest/v1/rpc/get_public_tournament', {
      method: 'POST', headers: { apikey: 'k', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tid: id }),
    });
    return res.json();
  };
  const viaLink = await anonRpc(sharedId);
  if (!viaLink || !viaLink.players || !viaLink.players.includes('Alef')) {
    throw new Error('the share link does NOT show the shared tournament (it should)');
  }
  if ('claims' in viaLink || 'meIndex' in viaLink) {
    throw new Error('public payload leaks account-linked fields (claims/meIndex)');
  }
  console.log('[3] Someone WITH the share link sees the shared tournament (read-only, scrubbed): OK');

  // ---- Check 4: without a link there is no way in ----
  const priv = await anonRpc(privateId);
  if (priv !== null) throw new Error('UNSHARED tournament is readable via a guessed link!');
  const wrong = await anonRpc('T-guess-123');
  if (wrong !== null) throw new Error('nonexistent id returned data?!');
  // Anonymous REST reads (listing or by id) must expose nothing at all.
  const listAll = await (await fetch(MOCK + '/rest/v1/tournaments?select=id,data', { headers: { apikey: 'k' } })).json();
  if (listAll.length !== 0) throw new Error('anon REST listing returned ' + listAll.length + ' rows (should be 0)');
  const byId = await (await fetch(MOCK + '/rest/v1/tournaments?id=eq.' + encodeURIComponent(sharedId) + '&select=data', { headers: { apikey: 'k' } })).json();
  if (byId.length !== 0) throw new Error('anon REST by-id read returned data (should be RPC-only)');
  console.log('[4] No anonymous listing; unshared tournament unreachable even by guessed link: OK');

  await ctxA.close(); await ctxAnon.close(); await ctxB.close();
  console.log('ALL PRIVACY-SCENARIO TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
