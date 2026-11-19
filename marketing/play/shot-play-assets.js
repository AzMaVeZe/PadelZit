// Generates the Google Play store assets into marketing/play/:
//   feature-graphic.png   1024x500  (from feature-graphic.html)
//   screenshot-1-home.png            signed-in home: tournaments + friends table
//   screenshot-2-game.png            a live game being scored
//   screenshot-3-friends.png         the friends leaderboard screen
//
// Play wants phone screenshots between 320px and 3840px on each side, with the
// long side no more than 2x the short side — 1080x1920 fits comfortably.
//
// Usage (from the repo root):
//   python3 -m http.server 8000 &
//   node mock-supabase.js &            # provides a fake cloud so the social
//   node marketing/play/shot-play-assets.js
//
// The screenshots use the mock backend so the leaderboard has real-looking rows
// without touching the production Supabase project or any real account.
const { chromium } = require('playwright');
const path = require('path');
const OUT = __dirname;
const APP = 'http://localhost:8000/index.html';
const MOCK = 'http://localhost:9021';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Phone-sized and portrait, high-DPI so text stays crisp at Play's display
// size. deviceScaleFactor sits alongside viewport (not inside it), and the
// viewport must be nested — passing width/height at the top level silently
// falls back to Playwright's 1280x720 default and yields landscape shots.
const PHONE = { viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 }; // -> 1080x1920

async function phoneCtx(browser) {
  const ctx = await browser.newContext({ ...PHONE, reducedMotion: 'reduce' });
  await ctx.addInitScript(url => {
    localStorage.setItem('padelzit-cloud-url', url);
    localStorage.setItem('padelzit-cloud-key', 'k');
  }, MOCK);
  return ctx;
}
async function openCloudForm(p) {
  if (await p.isVisible('#cloud-open-btn')) await p.click('#cloud-open-btn');
}
async function signup(p, email) {
  await openCloudForm(p);
  await p.fill('#cloud-email', email);
  await p.fill('#cloud-pass', 'secret123');
  await p.click('#cloud-signup-btn');
  await sleep(900);
}
async function syncViaMenu(p) {
  if (await p.isHidden('#menu-sync')) await p.click('#user-chip');
  await sleep(150);
  await p.click('#menu-sync');
  await sleep(1100);
  if (await p.isVisible('#menu-sync')) await p.click('#user-chip');
  await sleep(150);
}
// Without a nickname the leaderboard falls back to a generic "player" label,
// which looks broken in a store listing — give the demo accounts real names.
async function setNickname(p, nick) {
  if (await p.isHidden('#menu-nick')) await p.click('#user-chip');
  await sleep(200);
  await p.fill('#menu-nick', nick);
  await p.click('#menu-nick-save');
  await sleep(700);
  if (await p.isVisible('#menu-nick')) await p.click('#user-chip');
  await sleep(150);
}

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });

  // ---- 1024x500 feature graphic (static HTML, no app needed) ----
  const fg = await browser.newContext({ viewport: { width: 1024, height: 500 }, reducedMotion: 'reduce' });
  const fgp = await fg.newPage();
  await fgp.goto('file://' + path.join(OUT, 'feature-graphic.html'));
  await sleep(400);
  await fgp.screenshot({ path: path.join(OUT, 'feature-graphic.png') });
  await fg.close();
  console.log('feature-graphic.png (1024x500): OK');

  // ---- Two accounts so the friends leaderboard has more than one row ----
  const ctxA = await phoneCtx(browser); const pa = await ctxA.newPage();
  const ctxB = await phoneCtx(browser); const pb = await ctxB.newPage();
  await pa.goto(APP); await pb.goto(APP);
  await signup(pa, 'ariel@demo.app');
  await signup(pb, 'shachar@demo.app');
  await setNickname(pa, 'אריאל');
  await setNickname(pb, 'שחר');

  // A runs a real tournament with B linked by email, so both earn points.
  await pa.click('#new-tour-btn');
  await pa.fill('#p0', 'אריאל');
  await pa.fill('#p1', 'shachar@demo.app');
  await pa.fill('#p2', 'דנה');
  await pa.fill('#p3', 'יוסי');
  await (await pa.$$('.me-toggle'))[0].click();
  await pa.click('#start-btn');
  await sleep(1200);

  // Score two games, then grab the live-game shot mid-tournament.
  for (const s of [24, 27]) {
    await pa.fill('#scoreA', String(s));
    await pa.click('#save-btn');
    await sleep(350);
  }
  await pa.fill('#scoreA', '21');
  await sleep(250);
  await pa.screenshot({ path: path.join(OUT, 'screenshot-2-game.png') });
  console.log('screenshot-2-game.png: OK');

  // Finish so there is a champion and the stats sync.
  await pa.click('#save-btn'); await sleep(400);
  await pa.click('#finish-btn'); await sleep(250);
  await pa.click('#finish-yes'); await sleep(1600);

  // B accepts the auto-sent friend request -> shared leaderboard fills in.
  await syncViaMenu(pb);
  await pb.click('#friends-btn'); await sleep(500);
  const accept = await pb.$('#pending-list .friend-actions .accept');
  if (accept) { await accept.click(); await sleep(900); }
  await syncViaMenu(pa);
  await sleep(700);

  // Friends screen (leaderboard leads the screen).
  await pb.click('#friends-btn'); await sleep(700);
  await pb.screenshot({ path: path.join(OUT, 'screenshot-3-friends.png') });
  console.log('screenshot-3-friends.png: OK');

  // Home screen with tournaments + the friends table.
  await pa.click('#podium-home-btn').catch(() => {});
  await sleep(300);
  await syncViaMenu(pa);
  await sleep(600);
  await pa.screenshot({ path: path.join(OUT, 'screenshot-1-home.png') });
  console.log('screenshot-1-home.png: OK');

  await ctxA.close(); await ctxB.close();
  await browser.close();
  console.log('All Play assets written to marketing/play/');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
