// Regression tests for the Nov-2026 audit fixes: r.html XSS hardening, edit-row
// bleed, 4-player rotation after delete, 9–12 roster memory, target change on
// two courts, prototype-key names, undo, Back button, podium ties, and the
// multi-device sync guards (no stale overwrite, no resurrected deletes).
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = 'http://localhost:8000/index.html';
const MOCK = 'http://localhost:9021';
const DBK = 'puddlezit-db-v2';

function ok(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); }

async function newTour(page, names) {
  await page.goto(APP);
  await page.click('#new-tour-btn');
  await page.click('.count-row .count-chip:nth-child(' + (names.length - 3) + ')');
  for (let i = 0; i < names.length; i++) await page.fill('#p' + i, names[i]);
  await page.click('#start-btn');
  await sleep(150);
}
async function save(page, a, a2) {
  await page.fill('#scoreA', String(a));
  if (a2 !== undefined) await page.fill('#scoreA2', String(a2));
  await page.click('#save-btn');
  await sleep(200);
}
const tourOf = page => page.evaluate(k => JSON.parse(localStorage.getItem(k)).tournaments[0], DBK);
const pairIdx = g => { const t0 = g.teamA.includes(0) ? g.teamA : g.teamB; const m = t0.find(i => i !== 0); return m === 1 ? 0 : m === 2 ? 1 : 2; };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const fresh = async () => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    return { ctx, page };
  };

  // ---- r.html: hostile public payload is neutralized ----
  {
    const { ctx, page } = await fresh();
    await page.route('https://axrugdszycwmadbdwolx.supabase.co/**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        players: ['<img src=x onerror="window.__pwned=1">', 'B', 'C', 'D'],
        points: ['<img src=x onerror="window.__pwned=2">', 0, 0, 0],
        gamesWon: ['<script>window.__pwned=3</script>', 0, 0, 0],
        gamesPlayed: [0, 0, 0, 0],
        history: [{ teamA: [0, 1], teamB: [2, 3], scoreA: 16, scoreB: 16 }],
        next: [[0, '<b>x</b>'], [2, 3]],
        finished: true, createdAt: '<i>',
      }),
    }));
    await page.goto('http://localhost:8000/r.html?t=abcDEF123');
    await sleep(800);
    const r = await page.evaluate(() => ({
      pwned: window.__pwned, imgs: document.querySelectorAll('#content img').length,
      text: document.getElementById('content').innerText,
      medals: [...document.querySelectorAll('#content .medal')].map(m => m.textContent),
    }));
    ok(!r.pwned && r.imgs === 0, 'r.html executed or rendered injected markup');
    ok(r.text.includes('<img src=x'), 'player name should be shown as plain text');
    ok(r.text.includes('16 נק׳'), 'points must be recomputed from games (16), got: ' + r.text.slice(0, 120));
    ok(r.medals.every(m => m === '🥇'), 'all four tied players should share gold, got ' + r.medals.join(''));
    console.log('r.html: injected payload inert, totals recomputed, ties share medal: OK');
    await ctx.close();
  }

  // ---- B3: editing game #2 must not inherit values typed into game #1 ----
  {
    const { ctx, page } = await fresh();
    await newTour(page, ['Ann', 'Ben', 'Cat', 'Dov']);
    await save(page, 20); await save(page, 25);
    const rows = page.locator('#history-list .history-item');
    await rows.nth(1).locator('button', { hasText: '✎' }).click();   // game #1 (list is newest-first)
    await page.fill('#edit-a', '30');
    await page.locator('#history-list .history-item').nth(0).locator('button', { hasText: '✎' }).click(); // game #2
    const v = await page.inputValue('#edit-a');
    ok(v === '25', 'edit row for game #2 should start at 25, got ' + v);
    console.log('B3: edit row starts from its own game: OK');

    // ---- Undo the last save ----
    await page.click('.icon-btn.cancel');
    await save(page, 10);
    ok((await tourOf(page)).history.length === 3, 'expected 3 games before undo');
    await page.click('#toast .toast-action');
    await sleep(200);
    ok((await tourOf(page)).history.length === 2, 'undo should remove the just-saved game');
    console.log('Undo: last save reverted from the toast: OK');

    // ---- Back button returns home instead of leaving the page ----
    ok(await page.isVisible('#game-screen'), 'should be on the game screen');
    await page.goBack();
    await sleep(300);
    ok(page.url().startsWith(APP) && await page.isVisible('#home-screen'), 'Back should land on home, url=' + page.url());
    console.log('Back button: game → home inside the app: OK');
    await ctx.close();
  }

  // ---- B4: deleting a game keeps the 4-player rotation valid ----
  for (let run = 0; run < 15; run++) {
    const { ctx, page } = await fresh();
    await newTour(page, ['P0', 'P1', 'P2', 'P3']);
    await save(page, 20); await save(page, 18);
    await page.locator('#history-list .history-item').nth(1).locator('.icon-btn.danger').click();
    await page.locator('#history-list .history-item').nth(1).locator('.icon-btn.danger').click();
    await sleep(150);
    const tr = await tourOf(page);
    ok(tr.history.length === 1, 'expected one game left');
    const nextIdx = pairIdx({ teamA: tr.next[0], teamB: tr.next[1] });
    ok(nextIdx !== pairIdx(tr.history[0]), 'next pairing repeats the remaining game (run ' + run + ')');
    await ctx.close();
  }
  console.log('B4: after a delete the next pairing is one not yet played this cycle: OK');

  // ---- B5 + B6: 10-player roster remembered; target change re-balances court 2 ----
  {
    const { ctx, page } = await fresh();
    const ten = ['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9'];
    await newTour(page, ten);
    await page.fill('#scoreA', '20');
    await page.fill('#scoreA2', '10');
    await page.fill('#game-target', '24');
    await page.dispatchEvent('#game-target', 'change');
    await sleep(150);
    const vals = await page.evaluate(() => ['scoreA', 'scoreB', 'scoreA2', 'scoreB2'].map(id => +document.getElementById(id).value));
    ok(vals[0] + vals[1] === 24 && vals[2] + vals[3] === 24, 'both courts should sum to 24, got ' + vals);
    console.log('B6: target change re-balances both courts: OK');
    await page.goto(APP);
    if (await page.isVisible('#nav-home-btn')) await page.click('#nav-home-btn');   // the live tournament reopens on load
    await page.click('#new-tour-btn');
    const kept = await page.evaluate(n => [...Array(n).keys()].map(i => (document.getElementById('p' + i) || {}).value), 10);
    ok(kept.join(',') === ten.join(','), 'setup should keep all 10 names, got ' + kept);
    console.log('B5: a 10-player roster is remembered for the next tournament: OK');
    await ctx.close();
  }

  // ---- B7 + podium ties ----
  {
    const { ctx, page } = await fresh();
    await newTour(page, ['constructor', '__proto__', 'Dan', 'dan2']);
    await save(page, 16);                    // 16–16: all four tied
    await page.click('#finish-btn');
    await page.click('#finish-yes');
    await sleep(300);
    const medals = await page.evaluate(() => ['.podium-first .medal', '.podium-rest .p:nth-child(1) .medal', '.podium-rest .p:nth-child(2) .medal']
      .map(s => document.querySelector(s).textContent));
    ok(medals.every(m => m === '🥇'), 'tied podium should be all gold, got ' + medals.join(''));
    console.log('Podium: tied players share the same medal: OK');
    await page.goto(APP);
    if (await page.isVisible('#nav-home-btn')) await page.click('#nav-home-btn');
    const names = await page.evaluate(() => [...document.querySelectorAll('#alltime-body tr td:first-child')].map(td => td.textContent));
    ok(names.includes('constructor') && names.includes('__proto__'), 'all-time table lost prototype-named players: ' + names);
    ok(({}).pts === undefined, 'Object.prototype polluted');
    console.log('B7: "constructor"/"__proto__" appear in the all-time table: OK');
    await ctx.close();
  }

  // ---- Sync: a stale device never overwrites newer games; deletes stick ----
  {
    const mk = async () => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      await ctx.addInitScript(() => {
        localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
        localStorage.setItem('padelzit-cloud-key', 'k');
      });
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(e.message));
      return { ctx, page };
    };
    const auth = async (page, btn) => {
      if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
      await page.fill('#cloud-email', 'sync@x.io');
      await page.fill('#cloud-pass', 'secret123');
      await page.click(btn);
      await sleep(900);
    };
    const state = async () => (await fetch(MOCK + '/__state')).json();
    const A = await mk(), B = await mk();
    await A.page.goto(APP);
    await auth(A.page, '#cloud-signup-btn');
    await A.page.click('#new-tour-btn');
    for (let i = 0; i < 4; i++) await A.page.fill('#p' + i, 'S' + i);
    await A.page.click('#start-btn');
    await save(A.page, 20);
    await sleep(2000);
    const tid = (await tourOf(A.page)).id;
    await B.page.goto(APP);
    await auth(B.page, '#cloud-login-btn');
    await sleep(800);
    await save(A.page, 22);                         // A: game 2
    await sleep(2000);
    let row = (await state()).rows.find(r => r.id === tid);
    ok(row && row.games === 2, 'cloud should have 2 games after A, got ' + (row && row.games));
    await B.page.goto(APP);                         // B still holds the 1-game copy locally…
    await B.page.evaluate(() => { saveDb(); });     // …and triggers a background push
    await sleep(2200);
    row = (await state()).rows.find(r => r.id === tid);
    ok(row && row.games === 2, 'stale device overwrote newer games: cloud has ' + (row && row.games));
    console.log('Sync: a stale device does not overwrite newer games: OK');

    // A deletes the tournament; B must neither resurrect nor keep showing it.
    await A.page.evaluate(id => { view = 'home'; activeId = null; render(); deleteTournament(id); deleteTournament(id); }, tid);
    await sleep(2200);
    ok(!(await state()).rows.some(r => r.id === tid), 'delete did not reach the cloud');
    await B.page.evaluate(() => syncNow(true));
    await sleep(1500);
    ok(!(await state()).rows.some(r => r.id === tid), 'B resurrected the deleted tournament');
    const bHas = await B.page.evaluate(id => db.tournaments.some(t => t.id === id), tid);
    ok(!bHas, 'B still shows a tournament deleted on A');
    console.log('Sync: a delete on one device sticks on the others: OK');
    await A.ctx.close(); await B.ctx.close();
  }

  ok(errors.length === 0, 'page errors: ' + errors.join(' | '));
  console.log('ALL RENEWAL CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
