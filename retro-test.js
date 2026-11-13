// Cross-device shared leaderboard, the reported scenario:
//  1. Alice adds Bob to a real game by his exact email — WITHOUT being friends.
//  2. Adding by email auto-sends Bob a friend request (that's the missing link).
//  3. Alice plays + finishes. Bob isn't a friend yet, so he isn't credited...
//  4. ...but his slot is remembered (tour.links).
//  5. Bob accepts. Alice's next sync reconciles the past games into claims and
//     pushes Bob's stats.
//  6. Bob now sees himself + Alice on the shared leaderboard, AND on the home
//     screen (the shared table is mirrored there so both see it without hunting).
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK = 'http://localhost:9021';

async function mkctx(browser) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
    localStorage.setItem('padelzit-cloud-key', 'k');
  });
  return ctx;
}
async function openCloud(p) { if (await p.isVisible('#cloud-open-btn')) await p.click('#cloud-open-btn'); }
async function signup(p, e, pw) { await openCloud(p); await p.fill('#cloud-email', e); await p.fill('#cloud-pass', pw); await p.click('#cloud-signup-btn'); await sleep(800); }
async function syncViaMenu(p) {
  if (await p.isHidden('#menu-sync')) await p.click('#user-chip');
  await sleep(150); await p.click('#menu-sync'); await sleep(1100);
  if (await p.isVisible('#menu-sync')) await p.click('#user-chip'); await sleep(150);
}

(async () => {
  const browser = await chromium.launch();

  const ctxA = await mkctx(browser); const pa = await ctxA.newPage();
  const ctxB = await mkctx(browser); const pb = await ctxB.newPage();
  await pa.goto('http://localhost:8000/index.html');
  await pb.goto('http://localhost:8000/index.html');
  await signup(pa, 'alice2@test.com', 'secret123');
  await signup(pb, 'bob2@test.com', 'secret123');

  // Alice organizes: herself (me) + Bob BY EMAIL (not a friend) + two anon.
  await pa.click('#new-tour-btn');
  await pa.fill('#p0', 'Alice');
  await pa.fill('#p1', 'bob2@test.com');
  await pa.fill('#p2', 'Anon1');
  await pa.fill('#p3', 'Anon2');
  await (await pa.$$('.me-toggle'))[0].click();
  await pa.click('#start-btn');
  await sleep(1200);

  // Bob is remembered (links) but NOT credited yet (claims has only Alice).
  const t0 = await pa.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0]);
  const bobUid = await pb.evaluate(() => JSON.parse(localStorage.getItem('padelzit-session')).user.id);
  if (!(bobUid in (t0.links || {}))) throw new Error('Bob should be remembered in tour.links even before friendship');
  if (bobUid in (t0.claims || {})) throw new Error('Bob must NOT be credited before the friendship is confirmed');
  console.log('Adding a non-friend by email links him for later but credits nobody yet: OK');

  for (let r = 1; r <= 3; r++) { await pa.fill('#scoreA', String(20 + r)); await pa.click('#save-btn'); await sleep(300); }
  await pa.click('#finish-btn'); await sleep(200); await pa.click('#finish-yes'); await sleep(1500);

  // The email-add auto-sent Bob a friend request. Bob syncs and accepts.
  await syncViaMenu(pb);
  await pb.click('#friends-btn'); await sleep(400);
  if (await pb.isHidden('#pending-card')) throw new Error('Bob should have a pending friend request from the email add');
  console.log('Adding by email auto-sent a friend request to the added player: OK');
  await pb.click('#pending-list .friend-actions .accept'); await sleep(800);

  // Alice syncs → reconcile promotes Bob and pushes the now-eligible stats.
  await syncViaMenu(pa);
  const t1 = await pa.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0]);
  if (!(bobUid in (t1.claims || {}))) throw new Error('past game should be credited to Bob after he becomes a friend');
  console.log('Becoming friends retroactively credits the games already played: OK');
  await sleep(600);

  // Bob now sees himself with real points on the shared leaderboard.
  const lb = await pb.evaluate(async () => {
    const r = await fetch('http://localhost:9021/rest/v1/rpc/get_friends_leaderboard', {
      method: 'POST', headers: { apikey: 'k', Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('padelzit-session')).access_token, 'Content-Type': 'application/json' }, body: '{}',
    });
    return r.json();
  });
  const bobRow = (lb || []).find(r => r.uid === bobUid);
  if (!bobRow || bobRow.alltime_score <= 0) throw new Error('Bob should now have points on the shared leaderboard: ' + JSON.stringify(lb));
  if (!(lb || []).some(r => r.uid !== bobUid)) throw new Error('the shared leaderboard should include Alice too');
  console.log('The added player sees his real-game points on the shared leaderboard: OK');

  // ...and the shared table is mirrored on Bob's HOME screen.
  await pb.click('#friends-back-btn'); await sleep(200);
  await syncViaMenu(pb);
  if (await pb.isHidden('#home-friends-card')) throw new Error('the shared table should be mirrored on the home screen once you have a friend');
  const homeRows = await pb.$$eval('#home-friends-list .friend-row', els => els.length);
  if (homeRows < 2) throw new Error('home shared table should list both players, got rows=' + homeRows);
  console.log('The shared table also appears on the home screen (no hunting): OK');

  await ctxA.close(); await ctxB.close();
  console.log('ALL RETRO TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
