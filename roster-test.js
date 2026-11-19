// Player roster: nickname profile, directory lookup by exact email/nickname,
// roster suggestions, name resolution at setup, anonymous players untouched.
// Attribution (claims) for a non-friend match is covered by friends-test.js —
// it now requires a confirmed friendship, not just a directory match.
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
  await page.goto('http://localhost:8000/index.html');

  // ---- A signs up and sets a nickname ----
  if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
  await page.fill('#cloud-email', 'ariel@test.com');
  await page.fill('#cloud-pass', 'secret123');
  await page.click('#cloud-signup-btn');
  await sleep(800);
  await page.click('#user-chip'); await sleep(150);
  await page.fill('#menu-nick', 'ace');
  await page.click('#menu-nick-save');
  await sleep(600);
  await page.click('#user-chip'); await sleep(150); // close menu
  console.log('A signed up and saved nickname "ace": OK');

  // ---- A runs a tournament; names accumulate into the roster ----
  await page.click('#new-tour-btn');
  for (let i = 0; i < 4; i++) await page.fill('#p' + i, ['Dana', 'Yossi', 'Noa', 'Omer'][i]);
  await page.click('#start-btn');
  await sleep(1800);
  await page.click('#game-home-btn');
  await page.click('#new-tour-btn');
  const options = await page.$$eval('#roster-list option', o => o.map(x => x.value));
  if (!['Dana', 'Yossi', 'Noa', 'Omer'].every(n => options.includes(n))) {
    throw new Error('roster datalist missing names: ' + options);
  }
  console.log('Roster accumulates played names (datalist suggestions): OK');
  await page.click('#setup-back-btn');

  // ---- A signs out: roster is wiped from the device ----
  await page.click('#user-chip'); await sleep(150);
  await page.click('#menu-logout'); await sleep(500);
  await page.click('#new-tour-btn');
  const emptyOpts = await page.$$eval('#roster-list option', o => o.length);
  if (emptyOpts !== 0) throw new Error('roster survived sign-out: ' + emptyOpts);
  await page.click('#setup-back-btn');
  console.log('Sign-out wipes the roster from the device: OK');

  // ---- B signs up on the same device ----
  if (await page.isVisible('#cloud-open-btn')) await page.click('#cloud-open-btn');
  await page.fill('#cloud-email', 'boaz@test.com');
  await page.fill('#cloud-pass', 'secret456');
  await page.click('#cloud-signup-btn');
  await sleep(800);

  // ---- B cannot claim a nickname already taken (case-insensitive) ----
  // A already owns "ace"; B tries "ACE" and must be refused + rolled back.
  await page.click('#user-chip'); await sleep(150);
  await page.fill('#menu-nick', 'ACE');
  await page.click('#menu-nick-save');
  await sleep(700);
  const toastTxt = await page.textContent('#toast').catch(() => '');
  if (!/תפוס|taken/i.test(toastTxt)) throw new Error('expected a "nickname taken" toast, got: ' + toastTxt);
  const bNick = await page.evaluate(() => JSON.parse(localStorage.getItem('puddlezit-db-v2')).profile.nickname);
  if (bNick) throw new Error('a rejected nickname must be rolled back locally, got: ' + bNick);
  const bServerNick = await page.evaluate(async () => {
    const sess = JSON.parse(localStorage.getItem('padelzit-session'));
    const r = await fetch('http://localhost:9021/rest/v1/profiles?user_id=eq.' + sess.user.id + '&select=nickname', { headers: { apikey: 'k', Authorization: 'Bearer ' + sess.access_token } });
    return (await r.json())[0].nickname;
  });
  if (bServerNick) throw new Error('the server must not have stored the taken nickname, got: ' + bServerNick);
  console.log('A taken nickname is refused case-insensitively and rolled back (no duplicate identities): OK');
  await page.click('#user-chip'); await sleep(150); // close menu

  await page.click('#new-tour-btn');

  // Directory lookup by nickname fills the first empty slot.
  await page.fill('#dir-q', 'ace');
  await page.click('#dir-btn');
  await sleep(600);
  const dirMsg = await page.textContent('#dir-result');
  if (!/ace/.test(dirMsg)) throw new Error('directory lookup by nickname failed: ' + dirMsg);
  const p0 = await page.inputValue('#p0');
  if (p0 !== 'ace') throw new Error('found player should fill slot 0, got: ' + p0);
  // Not friends yet, so this is a neutral "registered, not a friend" badge —
  // NOT the green "linked" badge, which is reserved for confirmed friends.
  const badge0 = await page.textContent('#link-badge-0');
  if (!badge0.trim()) throw new Error('badge missing for directory-found player');
  const badge0Cls = await page.getAttribute('#link-badge-0', 'class');
  if (!badge0Cls.includes('neutral')) throw new Error('expected neutral (not-yet-friend) badge, got class: ' + badge0Cls);
  console.log('Directory lookup by exact nickname → slot filled, neutral badge (not yet a friend): OK');

  // Typing an email links that registered player at start time.
  await page.fill('#p1', 'ariel@test.com'); // same person by email — should dedupe with roster...
  // use plain anonymous names for the rest
  await page.fill('#p2', 'Guest1');
  await page.fill('#p3', 'Guest2');
  // p1 duplicates p0 (both resolve to A) → expect uniqueness error
  await page.click('#start-btn');
  await sleep(600);
  const dupErr = await page.textContent('#setup-error');
  if (!dupErr.trim()) throw new Error('expected duplicate-player error when email resolves to an already-placed player');
  console.log('Email resolving to an already-placed player → duplicate error: OK');

  // Replace p1 with an anonymous name and start.
  await page.fill('#p1', 'Rami');
  await page.click('#start-btn');
  await sleep(1200);
  const tourInfo = await page.evaluate(() => {
    const tr = JSON.parse(localStorage.getItem('puddlezit-db-v2')).tournaments[0];
    return { players: tr.players, claims: tr.claims };
  });
  if (tourInfo.players[0] !== 'ace') throw new Error('resolved display name wrong: ' + tourInfo.players);
  // boaz and ariel are NOT friends: the correct name still gets used, but
  // attribution (claims) requires mutual consent and must stay empty.
  if (Object.keys(tourInfo.claims).length !== 0) throw new Error('claims should be empty without friendship: ' + JSON.stringify(tourInfo.claims));
  if (tourInfo.players.some(n => n.includes('@'))) throw new Error('an email leaked into player names: ' + tourInfo.players);
  console.log('Start resolves the correct display name but does NOT attribute a non-friend: OK');

  // ---- Directory does NOT allow free-name search (privacy) ----
  await page.click('#game-home-btn');
  await page.click('#new-tour-btn');
  await page.fill('#dir-q', 'ariel'); // partial email / free text
  await page.click('#dir-btn');
  await sleep(500);
  const noHit = await page.textContent('#dir-result');
  if (/ace/.test(noHit)) throw new Error('free-text directory search should not match');
  console.log('Directory rejects free-text (exact email/nickname only): OK');
  await ctx.close();

  // ---- Add a registered player by FULL NAME (no nickname) ----
  // A user who signed up (e.g. via OAuth) with a full name but never set a
  // nickname must still be addable by that exact full name.
  const ctxN = await browser.newContext({ reducedMotion: 'reduce' });
  await ctxN.addInitScript(() => {
    localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
    localStorage.setItem('padelzit-cloud-key', 'k');
  });
  const pn = await ctxN.newPage();
  await pn.goto('http://localhost:8000/index.html');
  if (await pn.isVisible('#cloud-open-btn')) await pn.click('#cloud-open-btn');
  await pn.fill('#cloud-email', 'noa@test.com'); await pn.fill('#cloud-pass', 'secret123');
  await pn.click('#cloud-signup-btn'); await sleep(800);
  // Simulate an OAuth-style full name on the profile (no nickname), then push.
  await pn.evaluate(async () => {
    const sess = JSON.parse(localStorage.getItem('padelzit-session'));
    await fetch('http://localhost:9021/rest/v1/profiles?on_conflict=user_id', {
      method: 'POST', headers: { apikey: 'k', Authorization: 'Bearer ' + sess.access_token, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: sess.user.id, email: sess.user.email, name: 'Noa Cohen', nickname: null, roster: [] }),
    });
  });
  await ctxN.close();

  // A different account looks Noa up by her exact full name.
  const ctxM = await browser.newContext({ reducedMotion: 'reduce' });
  await ctxM.addInitScript(() => {
    localStorage.setItem('padelzit-cloud-url', 'http://localhost:9021');
    localStorage.setItem('padelzit-cloud-key', 'k');
  });
  const pm = await ctxM.newPage();
  await pm.goto('http://localhost:8000/index.html');
  if (await pm.isVisible('#cloud-open-btn')) await pm.click('#cloud-open-btn');
  await pm.fill('#cloud-email', 'gil@test.com'); await pm.fill('#cloud-pass', 'secret123');
  await pm.click('#cloud-signup-btn'); await sleep(800);
  await pm.click('#new-tour-btn');
  await pm.fill('#dir-q', 'Noa Cohen'); await pm.click('#dir-btn'); await sleep(600);
  const nameMsg = await pm.textContent('#dir-result');
  if (!/Noa Cohen/.test(nameMsg)) throw new Error('full-name directory lookup failed: ' + nameMsg);
  const filled = await pm.inputValue('#p0');
  if (filled !== 'Noa Cohen') throw new Error('full-name lookup should fill the slot with the name, got: ' + filled);
  console.log('Add a registered player by exact full name (no nickname): OK');
  await ctxM.close();

  if (errors.length) throw new Error('page errors: ' + errors.join('; '));
  console.log('ALL ROSTER TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
