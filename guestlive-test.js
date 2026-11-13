// Account-free live sharing: a guest broadcasts via the device write token.
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK = 'http://localhost:9021';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
    localStorage.setItem('padelzit-cloud-key', 'k');
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = async () => (await (await fetch(MOCK + '/__state')).json());
  const rpcGet = async id => (await (await fetch(MOCK + '/rest/v1/rpc/get_public_tournament', {
    method: 'POST', headers: { apikey: 'k', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tid: id }),
  })).json());
  await page.goto('http://localhost:8000/index.html');

  // Guest (no login!) creates a tournament, marks "me", and shares live.
  await page.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await page.fill('#p' + i, ['Gal', 'Dor', 'Ziv', 'Bar'][i]);
  const meBtns = await page.$$('.me-toggle');
  await meBtns[1].click();
  await page.click('#start-btn');
  await page.fill('#scoreA', '20'); await page.click('#save-btn');
  await sleep(300);
  if (await page.isHidden('#share-live-btn')) throw new Error('share-live button hidden for guest');
  await page.click('#share-live-btn');
  await sleep(800);
  if (!(await page.isVisible('#live-share'))) throw new Error('live share row not shown for guest');
  const waHref = decodeURIComponent(await page.getAttribute('#live-wa', 'href'));
  const tid = (waHref.match(/r\.html\?t=([A-Za-z0-9_-]+)/) || [])[1];
  if (!tid) throw new Error('no share link id for guest: ' + waHref);
  let s = await state();
  const row = s.rows.find(r => r.id === tid);
  if (!row || row.user_id !== null || !row.is_public) throw new Error('guest row wrong: ' + JSON.stringify(row));
  console.log('Guest shares live without an account (ownerless public row): OK');

  // The public payload is scrubbed (no claims/meIndex despite the "me" mark).
  let pub = await rpcGet(tid);
  if (!pub || !pub.players.includes('Gal')) throw new Error('guest broadcast not readable via share RPC');
  if ('claims' in pub || 'meIndex' in pub || 'guestMade' in pub) throw new Error('guest broadcast leaks personal fields');
  if (pub.history.length !== 1) throw new Error('expected 1 game in broadcast, got ' + pub.history.length);
  console.log('Guest broadcast readable via exact link, scrubbed: OK');

  // Saving another game updates the broadcast (debounced re-publish).
  await page.fill('#scoreA', '25'); await page.click('#save-btn');
  await sleep(2200);
  pub = await rpcGet(tid);
  if (pub.history.length !== 2) throw new Error('broadcast not refreshed after save: ' + pub.history.length + ' games');
  console.log('Guest broadcast auto-updates after each save: OK');

  // A wrong token cannot overwrite the broadcast (silent no-op like production).
  await fetch(MOCK + '/rest/v1/rpc/publish_live', {
    method: 'POST', headers: { apikey: 'k', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tid: tid, token: 'attacker-token-1234567890', tdata: { players: ['H4x'] } }),
  });
  pub = await rpcGet(tid);
  if (!pub.players.includes('Gal') || pub.players.includes('H4x')) throw new Error('wrong token overwrote broadcast!');
  console.log('Wrong write token cannot hijack a broadcast: OK');

  // Guest rows never leak into a signed-in account's list.
  const ctx2 = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx2.addInitScript(() => {
    localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
    localStorage.setItem('padelzit-cloud-key', 'k');
  });
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:8000/index.html');
  if (await p2.isVisible('#cloud-open-btn')) await p2.click('#cloud-open-btn');
  await p2.fill('#cloud-email', 'acc@test.com');
  await p2.fill('#cloud-pass', 'secret123');
  await p2.click('#cloud-signup-btn');
  await sleep(1200);
  const n = await p2.$$eval('#tournament-list .tour-item', e => e.length);
  if (n !== 0) throw new Error('guest broadcast leaked into an account: ' + n);
  await ctx2.close();
  console.log('Guest broadcasts never appear in accounts: OK');

  // Stop sharing → link goes dead.
  await page.click('#live-stop');
  await sleep(600);
  pub = await rpcGet(tid);
  if (pub !== null) throw new Error('broadcast still public after stop');
  if (!(await page.isVisible('#share-live-btn'))) throw new Error('share button should return after stop');
  console.log('Guest stop-sharing kills the link: OK');

  await ctx.close();
  if (errors.length) throw new Error('page errors: ' + errors.join('; '));
  console.log('ALL GUEST-LIVE TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
