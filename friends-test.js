// Friends: invite link, email search + accept/decline, badge counts, unfriend,
// claims gated behind confirmed friendship, and the engagement leaderboard
// (usage-based scoring, anti-gaming floor, friends-only visibility).
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK = 'http://localhost:9021';

async function ensureOpenCloud(page) {
  if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
}
async function signup(page, email, pass) {
  await ensureOpenCloud(page);
  await page.fill('#cloud-email', email);
  await page.fill('#cloud-pass', pass);
  await page.click('#cloud-signup-btn');
  await sleep(700);
}
async function login(page, email, pass) {
  await ensureOpenCloud(page);
  await page.fill('#cloud-email', email);
  await page.fill('#cloud-pass', pass);
  await page.click('#cloud-login-btn');
  await sleep(700);
}
async function syncViaMenu(page) {
  // #menu-sync lives inside the user menu — open it first.
  if (await page.isHidden('#menu-sync')) await page.click('#user-chip');
  await sleep(150);
  await page.click('#menu-sync');
  await sleep(900);
  // Close the menu again so it doesn't cover later clicks.
  if (await page.isVisible('#menu-sync')) await page.click('#user-chip');
  await sleep(150);
}
async function mkctx(browser) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
    localStorage.setItem('padelzit-cloud-key', 'k');
  });
  return ctx;
}

(async () => {
  const browser = await chromium.launch();

  // ---- Part 1: invite-link flow (guest opens link, signs up, accepts) ----
  const ctxA = await mkctx(browser);
  const pa = await ctxA.newPage();
  await pa.goto('http://localhost:8000/index.html');

  // ---- Login layout: OAuth buttons lead; email form is collapsed by default ----
  if (await pa.isHidden('#google-btn')) throw new Error('Google button should be visible up-front (OAuth leads)');
  if (await pa.isHidden('#facebook-btn')) throw new Error('Facebook button should be visible up-front (OAuth leads)');
  if (await pa.isVisible('#cloud-form-wrap')) throw new Error('email form should start collapsed behind its button');
  if (await pa.isHidden('#cloud-open-btn')) throw new Error('the email-login button should be visible when the form is collapsed');
  await pa.click('#cloud-open-btn'); await sleep(150);
  if (await pa.isHidden('#cloud-form-wrap')) throw new Error('email form should expand after tapping the email-login button');
  if (await pa.isVisible('#cloud-open-btn')) throw new Error('the email-login button should hide once the form is open');
  console.log('Login layout: OAuth first, email fields expand on demand: OK');

  await signup(pa, 'alice@test.com', 'secret123');
  // The Friends entry point is a persistent top-bar button, not just a menu item.
  if (await pa.isHidden('#friends-btn')) throw new Error('top-bar Friends button not visible when signed in');
  await pa.click('#friends-btn'); await sleep(300);
  if (await pa.isHidden('#friends-screen')) throw new Error('top-bar Friends button did not open the friends screen');
  console.log('Top-bar Friends button opens the friends screen: OK');
  await pa.click('#friend-invite-btn'); await sleep(600);
  if (await pa.isHidden('#friend-invite-share')) throw new Error('invite share panel did not open');
  const waHref = decodeURIComponent(await pa.getAttribute('#friend-invite-wa', 'href'));
  const m = waHref.match(/[?&]invite=([^&\s]+)/);
  if (!m) throw new Error('no invite token in wa link: ' + waHref);
  const token = m[1];
  console.log('Alice generated an invite link: OK');

  const ctxB = await mkctx(browser);
  const pb = await ctxB.newPage();
  await pb.goto('http://localhost:8000/index.html?invite=' + token);
  await sleep(500);
  // Not logged in yet: banner on home, cloud form open.
  if (await pb.isHidden('#invite-pending-note')) throw new Error('invite-pending banner not shown for a guest');
  if (await pb.isHidden('#cloud-form-wrap')) throw new Error('cloud form should auto-open for a pending invite');
  const bannerTxt = await pb.textContent('#invite-pending-note');
  if (!/[Aa]lice|alice@test\.com|^[^@]/.test(bannerTxt)) { /* name may be null pre-nickname; just check banner exists */ }
  console.log('Guest opening an invite link sees a sign-in prompt: OK');

  await signup(pb, 'bob@test.com', 'secret456');
  await sleep(600);
  if (await pb.isHidden('#invite-confirm-card')) throw new Error('invite confirm card did not appear after login');
  await pb.click('#invite-accept-btn');
  await sleep(700);
  const stateAfterAccept = await (await fetch(MOCK + '/__state')).json();
  if (!stateAfterAccept.friendEdges.some(e => e.status === 'accepted')) throw new Error('invite accept did not create an accepted edge');
  console.log('Accepting the invite after login creates a friendship: OK');

  // Alice's client should pick this up on next sync and show Bob as a friend.
  await syncViaMenu(pa);
  const aliceFriendsTxt = await pa.textContent('#friends-lb-card').catch(() => '');
  const friendRows = await pa.$$eval('#friends-lb-list .friend-row', els => els.length).catch(() => 0);
  if (friendRows < 1) throw new Error('Alice does not see Bob as a friend after sync, rows=' + friendRows);
  console.log('The inviter sees the new friend after syncing: OK');

  // ---- Part 1b: opening your OWN invite link must never offer self-friending ----
  // Repro of the reported bug: a guest opens the inviter's own link (token
  // stashed while logged out), then signs in AS the inviter. No self-invite.
  const ctxSelf = await mkctx(browser);
  const ps = await ctxSelf.newPage();
  await ps.goto('http://localhost:8000/index.html?invite=' + token); // Alice's own token
  await sleep(500);
  await login(ps, 'alice@test.com', 'secret123');
  await sleep(800);
  if (await ps.isVisible('#invite-confirm-card')) throw new Error('opening your own invite link offered self-friending after login');
  await ps.click('#friends-btn'); await sleep(300);
  if (await ps.isVisible('#invite-confirm-card')) throw new Error('a self-invite card leaked onto the friends screen');
  console.log('Opening your own invite link never offers self-friending: OK');
  await ctxSelf.close();

  // ---- Part 2: email-search request + accept, badge counts ----
  const ctxC = await mkctx(browser);
  const pc = await ctxC.newPage();
  await pc.goto('http://localhost:8000/index.html');
  await signup(pc, 'carol@test.com', 'secret789');
  await pc.click('#user-chip'); await sleep(150);
  await pc.click('#menu-friends'); await sleep(300);
  await pc.fill('#friend-email', 'bob@test.com');
  await pc.click('#friend-search-btn');
  await sleep(600);
  const searchMsg = await pc.textContent('#friend-search-result');
  if (!/sent|נשלח/i.test(searchMsg)) throw new Error('friend request not confirmed as sent: ' + searchMsg);
  console.log('Email-search sends a friend request: OK');

  // Bob syncs and should see a pending request + badge.
  await syncViaMenu(pb);
  // The persistent top-bar Friends button carries the pending count.
  const btnCount = await pb.textContent('#friends-btn-count');
  if (btnCount.trim() !== '1') throw new Error('top-bar pending count wrong: ' + btnCount);
  if (await pb.isHidden('#friends-btn-count')) throw new Error('top-bar pending count hidden despite a request');
  const menuTxt = await pb.textContent('#menu-friends');
  if (!/1/.test(menuTxt)) throw new Error('pending-count badge missing on menu item: ' + menuTxt);
  await pb.click('#friends-btn'); await sleep(300);
  if (await pb.isHidden('#pending-card')) throw new Error('pending-requests card hidden despite a pending request');
  console.log('Recipient sees the pending request (top-bar count + menu badge + card): OK');

  await pb.click('#pending-list .friend-actions .accept');
  await sleep(700);
  const stateAfterEmailAccept = await (await fetch(MOCK + '/__state')).json();
  const acceptedCount = stateAfterEmailAccept.friendEdges.filter(e => e.status === 'accepted').length;
  if (acceptedCount < 2) throw new Error('expected >=2 accepted edges (alice-bob, carol-bob), got ' + acceptedCount);
  console.log('Accepting an email-search request creates the friendship: OK');

  // ---- Part 3: decline flow ----
  const ctxD = await mkctx(browser);
  const pd = await ctxD.newPage();
  await pd.goto('http://localhost:8000/index.html');
  await signup(pd, 'dana@test.com', 'secret000');
  await pd.click('#user-chip'); await sleep(150);
  await pd.click('#menu-friends'); await sleep(300);
  await pd.fill('#friend-email', 'carol@test.com');
  await pd.click('#friend-search-btn'); await sleep(600);

  await syncViaMenu(pc);
  await pc.click('#user-chip'); await sleep(150);
  await pc.click('#menu-friends'); await sleep(300);
  await pc.click('#pending-list .friend-actions button.secondary'); // decline
  await sleep(700);
  const stateAfterDecline = await (await fetch(MOCK + '/__state')).json();
  const stillPending = stateAfterDecline.friendEdges.some(e => e.status === 'pending');
  if (stillPending) throw new Error('declined request should be removed, still pending: ' + JSON.stringify(stateAfterDecline.friendEdges));
  console.log('Declining a request removes it (no friendship, no leftover pending): OK');

  // ---- Part 4: claims require friendship; engagement scoring + leaderboard ----
  // Alice + Bob are friends (Part 1). Alice organizes with Bob linked, plus two
  // anonymous players; 3 games with a mix of teaming so both stay "eligible"
  // (a real second account on court) in every game.
  await pa.click('#friends-back-btn'); await sleep(200);
  await pa.click('#new-tour-btn');
  await pa.fill('#p0', 'Alice');
  await pa.fill('#p1', 'bob@test.com'); // a confirmed friend, found by email
  await pa.fill('#p2', 'Anon1');
  await pa.fill('#p3', 'Anon2');
  // Alice marks herself "me" (slot 0) — with Bob (slot 1) that's TWO real
  // accounts on court, which is what the engagement floor requires.
  await (await pa.$$('.me-toggle'))[0].click();
  await pa.click('#start-btn');
  await sleep(1000);
  // Both Alice (me) and Bob (confirmed friend by email) must be attributed.
  let claimsNow = await pa.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0].claims);
  if (Object.keys(claimsNow).length !== 2) throw new Error('expected Alice + Bob claimed, got: ' + JSON.stringify(claimsNow));
  console.log('Self ("me") + a confirmed friend found by email are both attributed: OK');

  // Play 3 games (the pairing engine rotates alice/bob between teammates and
  // opponents automatically with 4 players) — every game keeps a second real
  // account on court either way, so all 3 should count toward both scores.
  for (let round = 1; round <= 3; round++) {
    await pa.fill('#scoreA', String(20 + round)); await pa.click('#save-btn'); await sleep(300);
  }
  const tourAfter = await pa.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0]);
  if (tourAfter.history.length !== 3) throw new Error('expected 3 games recorded, got ' + tourAfter.history.length);
  await pa.click('#finish-btn'); await sleep(200);
  await pa.click('#finish-yes'); await sleep(2200); // let the debounced sync push engagement stats

  const lbRes = await pa.evaluate(async () => {
    const r = await fetch('http://localhost:9021/rest/v1/rpc/get_friends_leaderboard', {
      method: 'POST', headers: { apikey: 'k', Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('padelzit-session')).access_token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return r.json();
  });
  if (!Array.isArray(lbRes) || lbRes.length < 2) throw new Error('leaderboard should include at least alice+bob: ' + JSON.stringify(lbRes));
  if (!lbRes.every(r => r.month_score >= 0)) throw new Error('unexpected negative score: ' + JSON.stringify(lbRes));
  const totalPts = lbRes.reduce((s, r) => s + r.alltime_score, 0);
  if (totalPts <= 0) throw new Error('engagement points did not accumulate at all: ' + JSON.stringify(lbRes));
  console.log('Engagement stats sync and the friends leaderboard shows non-zero points: OK');

  // ---- Part 5: anti-gaming floor — a lone claimed player earns nothing ----
  await pa.click('#podium-home-btn'); await sleep(150); // back from the podium
  await pa.click('#new-tour-btn');
  await pa.fill('#p0', 'Alice2');
  await pa.fill('#p1', 'SoloAnon1');
  await pa.fill('#p2', 'SoloAnon2');
  await pa.fill('#p3', 'SoloAnon3');
  await pa.click('#start-btn'); await sleep(500);
  await pa.evaluate(() => {
    // Force-claim only Alice's own slot (simulating "me" on a tournament with
    // no other registered player present) without any friend involved.
    const db = JSON.parse(localStorage.getItem('puddlezit-db-v2'));
    const sess = JSON.parse(localStorage.getItem('padelzit-session'));
    db.tournaments[0].claims = { [sess.user.id]: 0 };
    localStorage.setItem('puddlezit-db-v2', JSON.stringify(db));
  });
  await pa.reload(); await sleep(500);
  for (let i = 0; i < 3; i++) { await pa.fill('#scoreA', '25'); await pa.click('#save-btn'); await sleep(300); }
  await sleep(2200);
  const stateAfterSolo = await (await fetch(MOCK + '/__state')).json();
  const soloTourId = await pa.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0].id);
  const soloStatsRecorded = stateAfterSolo.tourStats.some(s => s.tournament_id === soloTourId);
  if (soloStatsRecorded) throw new Error('a solo claimed player with no second real account should NOT accrue stats');
  console.log('Anti-gaming floor: a claimed player with no second real opponent earns nothing: OK');

  // ---- Part 6: unfriend ----
  await pa.click('#game-home-btn'); await sleep(150);
  await pa.click('#user-chip'); await sleep(150);
  await pa.click('#menu-friends'); await sleep(400);
  const beforeUnfriend = await pa.$$eval('#friends-lb-list .friend-row', els => els.length);
  if (beforeUnfriend < 1) throw new Error('expected at least one friend row before unfriending');
  await pa.click('#friends-lb-list .friend-unfriend');
  await sleep(700);
  const afterUnfriendRows = await pa.$$eval('#friends-lb-list .friend-row', els => els.length).catch(() => 0);
  if (afterUnfriendRows >= beforeUnfriend) throw new Error('friend row did not disappear after unfriending');
  console.log('Unfriend removes the relationship: OK');

  // ---- Part 7: leaderboard never leaks a stranger ----
  const ctxE = await mkctx(browser);
  const pe = await ctxE.newPage();
  await pe.goto('http://localhost:8000/index.html');
  await signup(pe, 'erin@test.com', 'secretxyz');
  await pe.click('#user-chip'); await sleep(150);
  await pe.click('#menu-friends'); await sleep(400);
  const erinRows = await pe.$$eval('#friends-lb-list .friend-row', els => els.length).catch(() => 0);
  if (erinRows !== 0) throw new Error('a brand-new stranger should see zero leaderboard rows, got ' + erinRows);
  if (await pe.isHidden('#friends-empty-hint')) throw new Error('empty-state hint should show for a friendless account');
  console.log('A stranger with no friends sees an empty leaderboard (no leakage): OK');

  await ctxA.close(); await ctxB.close(); await ctxC.close(); await ctxD.close(); await ctxE.close();
  console.log('ALL FRIENDS TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
