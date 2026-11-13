// Regression: one account's tournaments must NOT leak to a different account
// that signs in on the same device (shared-device cross-account bleed).
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const state = async () => (await (await fetch('http://localhost:9021/__state')).json());
  await page.goto('http://localhost:8000/index.html');

  // ---- User A signs up and creates a tournament ----
  if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
  await page.fill('#cloud-email', 'ariel@test.com');
  await page.fill('#cloud-pass', 'secret123');
  await page.click('#cloud-signup-btn');
  await sleep(500);
  await page.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await page.fill('#p' + i, ['Tsadok', 'Tamar', 'Lea', 'Ariel'][i]);
  await (await page.$$('.me-toggle'))[0].click(); // claim slot 0 → creates claims/links/meIndex
  await page.click('#start-btn');
  await page.fill('#scoreA', '20'); await page.click('#save-btn');
  await sleep(1500);
  // A shares a live view → the row becomes is_public in the cloud.
  await page.click('#share-live-btn');
  await sleep(1200);
  await page.click('#game-home-btn');
  let cards = await page.$$eval('#tournament-list .tour-item', e => e.length);
  if (cards !== 1) throw new Error('A should have 1 tournament, got ' + cards);
  let s = await state();
  const aRows = s.rows.length;
  if (aRows !== 1) throw new Error('cloud should have 1 row for A, got ' + aRows);
  if (!s.rows.some(r => r.is_public)) throw new Error('share-live should mark the row public');
  console.log('User A created a tournament and shared it publicly (local + cloud): OK');

  // ---- The public payload must be scrubbed of ALL account-linked fields ----
  // A claimed slot 0, so the raw row carries claims/links/meIndex (opaque uids).
  const pubTid = s.rows.find(r => r.is_public).id;
  const pub = await page.evaluate(async (tid) => {
    const r = await fetch('http://localhost:9021/rest/v1/rpc/get_public_tournament', {
      method: 'POST', headers: { apikey: 'k', 'Content-Type': 'application/json' }, body: JSON.stringify({ tid }),
    });
    return r.json();
  }, pubTid);
  for (const leaky of ['claims', 'meIndex', 'links']) {
    if (pub && leaky in pub) throw new Error('LEAK: public tournament payload still carries "' + leaky + '"');
  }
  console.log('Public payload is scrubbed of claims/meIndex/links (no uid leak): OK');

  // ---- A signs out on the shared device ----
  await page.click('#user-chip');
  await sleep(150);
  await page.click('#menu-logout');
  await sleep(400);
  // After logout the device must be clean.
  cards = await page.$$eval('#tournament-list .tour-item', e => e.length);
  if (cards !== 0) throw new Error('After A logout, device still shows ' + cards + ' tournaments (LEAK)');
  if (!(await page.isVisible('#guest-note'))) throw new Error('guest note should show after logout');
  console.log('Sign-out wipes local tournaments from the device: OK');

  // ---- User B (new account) signs up on the SAME device ----
  if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
  await page.fill('#cloud-email', 'friend@test.com');
  await page.fill('#cloud-pass', 'secret456');
  await page.click('#cloud-signup-btn');
  await sleep(1500);
  cards = await page.$$eval('#tournament-list .tour-item', e => e.length);
  if (cards !== 0) throw new Error('LEAK: new account B sees ' + cards + " of A's tournaments");
  console.log('New account B sees zero of A’s tournaments: OK');

  // ---- And nothing of A leaked up into B's cloud account ----
  s = await state();
  const bRows = s.rows.filter(r => r.user_id && r.user_id.indexOf('u_') === 0);
  // total rows should still be exactly 1 (A's), none owned by B
  if (s.rows.length !== 1) throw new Error("LEAK: cloud now has " + s.rows.length + " rows; A's data was pushed into B");
  console.log('No tournament pushed into B’s cloud account: OK');

  // ---- A logs back in → their data returns from the cloud ----
  await page.click('#user-chip'); await sleep(150); await page.click('#menu-logout'); await sleep(400);
  if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
  await page.fill('#cloud-email', 'ariel@test.com');
  await page.fill('#cloud-pass', 'secret123');
  await page.click('#cloud-login-btn');
  await sleep(1500);
  cards = await page.$$eval('#tournament-list .tour-item', e => e.length);
  if (cards !== 1) throw new Error('A re-login should restore 1 tournament, got ' + cards);
  console.log('User A re-login restores their tournament from cloud: OK');
  await ctx.close();
  if (errors.length) throw new Error('page errors: ' + errors.join('; '));

  // ---- Scenario: PUBLIC tournament must not leak into other accounts ----
  // A's row is is_public (share-live). A brand-new account on a brand-new
  // device must still see zero tournaments — this is the reported bug.
  {
    const c2 = await browser.newContext({ reducedMotion: 'reduce' });
    await c2.addInitScript(() => {
      localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
      localStorage.setItem('padelzit-cloud-key', 'k');
    });
    const p2 = await c2.newPage();
    await p2.goto('http://localhost:8000/index.html');
    if (await p2.isVisible('#cloud-open-btn')) await p2.click('#cloud-open-btn');
    await p2.fill('#cloud-email', 'charlie@test.com');
    await p2.fill('#cloud-pass', 'secret789');
    await p2.click('#cloud-signup-btn');
    await sleep(1500);
    const n = await p2.$$eval('#tournament-list .tour-item', e => e.length);
    if (n !== 0) throw new Error('LEAK: fresh account C sees ' + n + ' public tournament(s) of A');
    console.log('Public (shared-live) tournament does NOT appear in another account: OK');
    await c2.close();
  }

  // ---- Scenario: legacy local data (no owner tracking) is not adopted ----
  {
    const legacyTour = {
      id: 'Tlegacy1', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000,
      finished: true, finishedAt: Date.now() - 86000000, format: 'americano', players: ['P1', 'P2', 'P3', 'P4'],
      target: 32, points: [0, 0, 0, 0], gamesPlayed: [0, 0, 0, 0], gamesWon: [0, 0, 0, 0], history: [],
    };
    const c3 = await browser.newContext({ reducedMotion: 'reduce' });
    await c3.addInitScript(seed => {
      localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
      localStorage.setItem('padelzit-cloud-key', 'k');
      localStorage.setItem('puddlezit-db-v2', JSON.stringify({ tournaments: [seed], lastTarget: 32 }));
    }, legacyTour);
    const p3 = await c3.newPage();
    await p3.goto('http://localhost:8000/index.html');
    await sleep(400);
    let n = await p3.$$eval('#tournament-list .tour-item', e => e.length);
    if (n !== 1) throw new Error('legacy seed should be visible to the guest, got ' + n);
    if (await p3.isVisible('#cloud-open-btn')) await p3.click('#cloud-open-btn');
    await p3.fill('#cloud-email', 'dana@test.com');
    await p3.fill('#cloud-pass', 'secret000');
    await p3.click('#cloud-signup-btn');
    await sleep(1500);
    n = await p3.$$eval('#tournament-list .tour-item', e => e.length);
    if (n !== 0) throw new Error('LEAK: legacy (pre-ownership) tournament adopted by new account, got ' + n);
    console.log('Legacy un-owned local data is dropped, not adopted, on sign-in: OK');
    await c3.close();
  }

  // ---- Scenario: genuine guest data IS adopted by its first account ----
  {
    const c4 = await browser.newContext({ reducedMotion: 'reduce' });
    await c4.addInitScript(() => {
      localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
      localStorage.setItem('padelzit-cloud-key', 'k');
    });
    const p4 = await c4.newPage();
    await p4.goto('http://localhost:8000/index.html');
    await p4.click('#new-tour-btn');
    for (let i = 0; i < 4; i++) await p4.fill('#p' + i, ['Gil', 'Noa', 'Uri', 'May'][i]);
    await p4.click('#start-btn');
    await p4.fill('#scoreA', '18'); await p4.click('#save-btn');
    await sleep(400);
    await p4.click('#game-home-btn');
    if (await p4.isVisible('#cloud-open-btn')) await p4.click('#cloud-open-btn');
    await p4.fill('#cloud-email', 'eyal@test.com');
    await p4.fill('#cloud-pass', 'secret111');
    await p4.click('#cloud-signup-btn');
    await sleep(1800);
    const n = await p4.$$eval('#tournament-list .tour-item', e => e.length);
    if (n !== 1) throw new Error('guest tournament should be adopted on signup, got ' + n);
    console.log('Guest-created tournament is adopted by its first account: OK');
    await c4.close();
  }

  console.log('ALL LEAK TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
