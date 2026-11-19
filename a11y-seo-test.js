// Accessibility (IS 5568) and search/AI-visibility guards: landmarks, skip
// link, announced selection state, team-named steppers, crawlable Hebrew
// content in the raw HTML, noindex on per-tournament results, crawl files.
const { chromium } = require('playwright');
const fs = require('fs');
const APP = 'http://localhost:8000/index.html';
function ok(c, m) { if (!c) throw new Error('FAIL: ' + m); }

(async () => {
  // ---- raw HTML (what non-JS crawlers see) ----
  const raw = fs.readFileSync(__dirname + '/index.html', 'utf8');
  ok(/<link rel="canonical" href="https:\/\/padel\.azma\.app\/">/.test(raw), 'index canonical');
  ok(/"@type": "WebApplication"/.test(raw), 'index JSON-LD');
  ok(raw.includes('מה זה פאדלז׳יט ואיך זה עובד?') && raw.includes('אמריקנו:'), 'crawlable Hebrew explainer in raw HTML');
  ok(/<meta name="robots" content="noindex/.test(fs.readFileSync(__dirname + '/r.html', 'utf8')), 'r.html noindex');
  ['pwa/robots.txt', 'pwa/sitemap.xml', 'pwa/llms.txt', 'americano.html', 'accessibility.html'].forEach(f =>
    ok(fs.existsSync(__dirname + '/' + f), f + ' missing'));
  ok(fs.readFileSync(__dirname + '/pwa/robots.txt', 'utf8').includes('Sitemap: https://padel.azma.app/sitemap.xml'), 'robots declares sitemap');
  const deploy = fs.readFileSync(__dirname + '/.github/workflows/deploy-pages.yml', 'utf8');
  ['americano.html', 'accessibility.html', 'r.js'].forEach(f => ok(deploy.includes('cp ' + f), 'deploy copies ' + f));
  console.log('SEO: canonical, JSON-LD, crawlable explainer, noindex results, crawl files, deploy: OK');

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ reducedMotion: 'reduce' })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(APP);

  // ---- landmarks + skip link ----
  ok(await page.locator('main#main-content').count() === 1, 'one <main>');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.id) === 'skip-link', 'skip link is the first tab stop');
  ok(await page.isVisible('#about-card[open]'), 'explainer opens for first-time users');
  ok(await page.isVisible('#a11y-link'), 'accessibility statement linked from home');
  console.log('A11y: main landmark, skip link first, explainer, statement link: OK');

  // ---- setup: grouped chips announce their selection ----
  await page.click('#new-tour-btn');
  const pressed = await page.evaluate(() => ['count-row', 'format-row', 'target-chips'].map(id => {
    const row = document.getElementById(id);
    return row.getAttribute('role') === 'group' && row.querySelectorAll('[aria-pressed="true"]').length === 1;
  }));
  ok(pressed.every(Boolean), 'each chip group has role=group and exactly one pressed chip: ' + pressed);
  console.log('A11y: chip groups announce the selected option: OK');

  // ---- game: +/- buttons name their team ----
  for (let i = 0; i < 4; i++) await page.fill('#p' + i, ['Ann', 'Ben', 'Cat', 'Dov'][i]);
  await page.click('#start-btn');
  const labels = await page.evaluate(() => [...document.querySelectorAll('#scoreA ~ .step, .stepper .step')].slice(0, 2).map(b => b.getAttribute('aria-label')));
  ok(labels.every(l => l && /Ann|Ben|Cat|Dov/.test(l) && !/^[+-]1$/.test(l)), 'stepper labels name the team: ' + labels);
  console.log('A11y: +/- steppers announce which team they change: OK');

  // ---- English toggle swaps the explainer ----
  await page.click('#nav-home-btn');
  await page.click('#lang-btn');
  ok((await page.textContent('#about-summary')).startsWith('What is PadelZit'), 'explainer translated');
  await page.click('#lang-btn');
  ok((await page.textContent('#about-summary')).startsWith('מה זה'), 'explainer back in Hebrew');
  console.log('i18n: explainer follows the language toggle: OK');

  ok(errors.length === 0, 'page errors: ' + errors.join(' | '));
  console.log('ALL A11Y/SEO CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
