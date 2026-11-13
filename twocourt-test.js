// Two-court rounds (8+ players) + chunk-A bug fixes.
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:8000/index.html');

  // ---- 8 players Americano: everyone plays, two courts, one save per round ----
  await page.click('#new-tour-btn');
  await page.click('.count-row .count-chip:nth-child(5)'); // "8"
  const names8 = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];
  for (let i = 0; i < 8; i++) await page.fill('#p' + i, names8[i]);
  await page.click('#start-btn');
  if (await page.isHidden('#court2-block')) throw new Error('court 2 not shown for 8 players');
  // All 8 distinct players across both courts, nobody resting.
  const shown = await page.evaluate(() => {
    const txt = id => document.getElementById(id).innerText;
    return txt('teamA-names') + ' ' + txt('teamB-names') + ' ' + txt('teamA2-names') + ' ' + txt('teamB2-names');
  });
  const found = names8.filter(n => shown.includes(n));
  if (found.length !== 8) throw new Error('expected all 8 on court, found ' + found.length);
  if (await page.isVisible('#resting-label')) throw new Error('resting label shown with 8 players (nobody rests)');
  console.log('8p: two courts, all 8 play, no resting: OK');

  // Round label spans two game numbers.
  const label = await page.textContent('#round-label');
  if (!/1–2/.test(label)) throw new Error('round label should span games 1–2, got: ' + label);

  // Court-2 validation: court 1 filled, court 2 missing → court-2-prefixed error.
  await page.fill('#scoreA', '20');
  await page.click('#save-btn');
  const errTxt = await page.textContent('#score-error');
  if (!/מגרש 2/.test(errTxt)) throw new Error('missing court-2 error prefix, got: ' + errTxt);
  // Fill court 2 → save adds TWO history games, everyone played 1.
  await page.fill('#scoreA2', '12');
  await page.click('#save-btn');
  await sleep(300);
  let stats = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('puddlezit-db-v2'));
    const tr = db.tournaments[0];
    return { games: tr.history.length, played: tr.gamesPlayed, next2: !!tr.next2 };
  });
  if (stats.games !== 2) throw new Error('expected 2 history games after round save, got ' + stats.games);
  if (!stats.played.every(g => g === 1)) throw new Error('everyone should have played 1, got ' + stats.played);
  if (!stats.next2) throw new Error('next round should again have court 2');
  console.log('8p: one save = both courts recorded, fair games: OK');

  // Range-error message fix: score above target with other side empty → errRange.
  await page.fill('#scoreA', '40');
  await page.click('#save-btn');
  const rangeErr = await page.textContent('#score-error');
  if (!/32|0/.test(rangeErr) || /נא להזין/.test(rangeErr)) throw new Error('expected range error, got: ' + rangeErr);
  await page.fill('#scoreA', ''); await page.fill('#scoreB', '');
  console.log('Range error (not "enter a score") for out-of-range input: OK');

  // ---- Mexicano rematch keeps format (bug fix) ----
  await page.click('#game-home-btn');
  await page.click('#new-tour-btn');
  await page.click('.count-row .count-chip:nth-child(1)'); // back to 4
  for (let i = 0; i < 4; i++) await page.fill('#p' + i, ['M1', 'M2', 'M3', 'M4'][i]);
  // choose mexicano (second format chip)
  await page.click('#format-row .count-chip:nth-child(2)');
  const meBtns = await page.$$('.me-toggle');
  await meBtns[0].click(); // mark M1 as me
  await page.click('#start-btn');
  await page.fill('#scoreA', '20'); await page.click('#save-btn');
  await sleep(200);
  await page.click('#finish-btn');
  await page.click('#finish-yes');
  await sleep(300);
  await page.click('#rematch-btn');
  await sleep(300);
  const re = await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('puddlezit-db-v2'));
    return { format: db.tournaments[0].format, meIndex: db.tournaments[0].meIndex };
  });
  if (re.format !== 'mexicano') throw new Error('rematch lost mexicano format: ' + re.format);
  if (re.meIndex !== 0) throw new Error('rematch lost meIndex: ' + re.meIndex);
  console.log('Rematch keeps Mexicano format + "me": OK');

  // ---- Mexicano edit recomputes the announced pairing (bug fix) ----
  // Play one game, note next pairing, then edit that game to flip the standings.
  await page.fill('#scoreA', '30'); await page.click('#save-btn');
  await sleep(200);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0].next);
  await page.click('#history-list .icon-btn'); // ✎ on the latest game
  await page.fill('#edit-a', '2');
  await page.click('#history-list .icon-btn.ok'); // ✔ save edit
  await sleep(200);
  const after = await page.evaluate(() => {
    const tr = JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0];
    // recompute expectation: mexicano next = by standings 1+4 vs 2+3
    return { next: tr.next, points: tr.points };
  });
  // The pairing must be consistent with the new standings: teammates are ranks {0,3} and {1,2}.
  const rank = after.points.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const expectTeams = JSON.stringify([[rank[0], rank[3]].sort(), [rank[1], rank[2]].sort()].map(x => x.join()).sort());
  const gotTeams = JSON.stringify([after.next[0].slice().sort(), after.next[1].slice().sort()].map(x => x.join()).sort());
  if (expectTeams !== gotTeams) throw new Error('mexicano next not recomputed after edit: ' + JSON.stringify(after.next) + ' points=' + after.points + ' before=' + JSON.stringify(before));
  console.log('Mexicano: editing a score re-pairs the announced next game: OK');

  // ---- 10 players: 8 play, 2 rest; fair spread over rounds ----
  await page.click('#game-home-btn');
  await page.click('#new-tour-btn');
  await page.click('#format-row .count-chip:nth-child(1)'); // americano
  await page.click('.count-row .count-chip:nth-child(7)'); // "10"
  for (let i = 0; i < 10; i++) await page.fill('#p' + i, 'P' + (i + 1));
  await page.click('#start-btn');
  if (await page.isHidden('#court2-block')) throw new Error('court 2 not shown for 10 players');
  if (await page.isHidden('#resting-label')) throw new Error('resting label missing for 10 players');
  for (let r = 0; r < 5; r++) {
    await page.fill('#scoreA', '20');
    await page.fill('#scoreA2', '18');
    await page.click('#save-btn');
    await sleep(150);
  }
  stats = await page.evaluate(() => {
    const tr = JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0];
    return { games: tr.history.length, played: tr.gamesPlayed };
  });
  if (stats.games !== 10) throw new Error('expected 10 games after 5 rounds, got ' + stats.games);
  const spread = Math.max(...stats.played) - Math.min(...stats.played);
  if (spread > 1) throw new Error('unfair rest rotation for 10p: spread ' + spread + ' (' + stats.played + ')');
  console.log('10p: two courts + fair rest rotation (spread ≤ 1): OK');

  await ctx.close();
  if (errors.length) throw new Error('page errors: ' + errors.join('; '));
  console.log('ALL TWO-COURT TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
