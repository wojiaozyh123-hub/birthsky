// Dev only: the whole product flow in headless Chromium (SwiftShader), with screenshots of every stage.
//   node tools/dev/flow.mjs [stage…]      stages: own keep gift pair print guest (default: all)
// Screenshots → .cache/dev/flow/*.jpg; console errors are printed and fail the run.
import fs from 'node:fs';
import path from 'node:path';
import { serve, launch } from './shell-harness.mjs';

const OUT = path.resolve('.cache/dev/flow');
fs.mkdirSync(OUT, { recursive: true });
const want = new Set(process.argv.slice(2));
const run = (k) => !want.size || want.has(k);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const { server, base } = await serve();
const browser = await launch();
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
});
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.stack || e)));

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 70 });
  console.log('  shot', name);
};
const mode = () => page.evaluate(() => window.__birthsky?.mode);
const until = async (fn, ms = 20000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await wait(150);
  }
  throw new Error(`timeout: ${label || fn}`);
};
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 8000 }); await page.click(sel); };
const typeDigits = async (sel, s) => { await page.focus(sel); await page.keyboard.type(s, { delay: 30 }); };

async function fillForm(y, m, d, hh, mm, city, name = '') {
  await until(() => document.getElementById('form')?.classList.contains('on'), 8000, 'form');
  await wait(900);
  if (name) { await page.focus('#f-name'); await page.keyboard.type(name); }
  await typeDigits('#f-y', y); await typeDigits('#f-m', m); await typeDigits('#f-d', d);
  if (hh) { await page.click('#f-hh', { clickCount: 3 }); await typeDigits('#f-hh', hh); await typeDigits('#f-mm', mm); }
  await click('#f-city');
  await until(() => document.getElementById('city-page')?.classList.contains('on'), 5000, 'city page');
  await page.keyboard.type(city, { delay: 40 });
  await wait(600);
  await page.keyboard.press('Enter');
  await wait(700);
  await click('#btn-go');
}

async function toSky(label) {
  await until(() => window.__birthsky?.mode === 'rewind', 15000, 'rewind');
  await wait(2500);
  await shot(`${label}-rewind`);
  await until(() => ['sky', 'gift', 'keep'].includes(window.__birthsky?.mode), 40000, 'arrive');
  await wait(2600);
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await until(() => !document.getElementById('btn-start')?.classList.contains('is-loading') && window.__birthsky?.renderer, 40000, 'intro ready');
  await wait(3500);
  await shot('01-intro');

  if (run('own') || run('keep') || run('gift') || run('pair') || run('tools') || run('tip')) {
    await click('#btn-start');
    await wait(1200);
    await shot('02-form');
    await fillForm('1998', '07', '14', '22', '00', '杭州', '小明');
    await toSky('03');
    await shot('04-sky');
    // tour
    await page.click('#caption').catch(() => {});
    await wait(2200);
    await shot('05-tour');
    // 那一夜
    await page.evaluate(() => document.getElementById('summary')?.click());
    await wait(1400);
    await shot('06-night');
    await page.evaluate(() => document.getElementById('night-close')?.click());
    await wait(900);
  }

  if (run('tip')) {
    await page.evaluate(() => window.__birthsky.chrome.showChrome());
    await wait(1200);
    await shot('40-sky-icons');
    await page.evaluate(() => document.getElementById('tip')?.click());
    await wait(900);
    await shot('41-tip-big');
    await page.mouse.click(30, 120);
    await wait(700);
    await page.evaluate(() => document.querySelector('#meta .mi')?.click());
    await wait(1500);
    await page.evaluate(() => { const b = document.getElementById('night-body'); if (b) b.scrollTop = b.scrollHeight; });
    await wait(600);
    await shot('42-night-sponsor');
    console.log('  sponsor', JSON.stringify(await page.evaluate(() => [document.getElementById('night-slot')?.innerText, [...document.querySelectorAll('#colophon *')].map((e) => e.textContent).find((t) => t.includes('赞助'))])));
    await page.evaluate(() => document.getElementById('night-close')?.click());
    await wait(900);
  }

  if (run('tools')) {
    await page.evaluate(() => window.__birthsky.chrome.showChrome());
    await wait(400);
    await page.evaluate(() => document.getElementById('a-listen')?.click());
    await wait(4000);
    await shot('30-listen');
    console.log('  listen', await mode());
    await page.evaluate(() => document.getElementById('listen-stop')?.click());
    await wait(3000);
    await page.evaluate(() => document.querySelector('#meta .tw')?.click());
    await wait(1500);
    await shot('31-ruler');
    console.log('  ruler open', await page.evaluate(() => window.__birthsky.ruler.isOpen));
    await page.evaluate(() => document.getElementById('r-play')?.click());
    await wait(3000);
    await shot('32-ruler-play');
    await page.evaluate(() => document.getElementById('r-done')?.click());
    await wait(1200);
    await page.mouse.click(195, 300);
    await wait(1500);
    await shot('33-tap');
  }

  if (run('keep')) {
    await page.evaluate(() => window.__birthsky.chrome.showChrome());
    await wait(500);
    await page.evaluate(() => document.getElementById('a-keep')?.click());
    await until(() => window.__birthsky.mode === 'keep', 6000, 'keep');
    await wait(2600);
    await shot('07-viewfinder-wall');
    await page.evaluate(() => document.getElementById('kf-tab-card')?.click());
    await wait(2600);
    await shot('08-viewfinder-card');
    await page.evaluate(() => document.getElementById('kf-go')?.click());
    await until(() => document.getElementById('keep-img')?.classList.contains('on'), 30000, 'export');
    await wait(800);
    await shot('09-result');
    await page.evaluate(() => document.getElementById('kr-print-go')?.click());
    await wait(700);
    await shot('10-order');
    const code = await page.evaluate(() => document.getElementById('ko-code')?.value);
    fs.writeFileSync(path.join(OUT, 'order-code.txt'), code || '');
    console.log('  order code', (code || '').length, 'chars');
    await page.evaluate(() => document.getElementById('ko-close')?.click());
    await page.evaluate(() => document.getElementById('kr-done')?.click());
    await wait(1500);
  }

  if (run('gift')) {
    await page.evaluate(() => window.__birthsky.chrome.showChrome());
    await wait(500);
    await page.evaluate(() => document.getElementById('a-gift')?.click());
    await wait(1000);
    await shot('11-gift-form');
    await fillForm('2000', '05', '20', '23', '10', '成都', '小红');
    await toSky('12-gift');
    await until(() => window.__birthsky.mode === 'keep', 15000, 'gift viewfinder');
    await wait(2800);
    await shot('13-gift-viewfinder');
    console.log('  metrics', JSON.stringify(await page.evaluate(() => ({ sy: scrollY, vv: visualViewport && [visualViewport.offsetTop, visualViewport.height, visualViewport.scale],
      app: document.getElementById('app').getBoundingClientRect().top, H: window.__birthsky.chrome.H, ih: innerHeight,
      sky: document.getElementById('sky').getBoundingClientRect().top, doc: document.documentElement.scrollHeight, bodyTop: document.body.getBoundingClientRect().top,
      top: document.getElementById('kf-top').getBoundingClientRect().top, frame: document.getElementById('kf-frame').getBoundingClientRect().top }))));
    await page.evaluate(() => document.getElementById('kf-go')?.click());
    await until(() => document.getElementById('keep-img')?.classList.contains('on'), 30000, 'gift export');
    await wait(800);
    await shot('14-gift-result');
    console.log('  layers', JSON.stringify(await page.evaluate(() => ['keep', 'keep-result'].map((id) => { const e = document.getElementById(id); const c = getComputedStyle(e); return [id, e.className, c.opacity, c.visibility, c.zIndex, c.backgroundColor]; }))));
    await page.evaluate(() => document.getElementById('kr-print-go')?.click());
    await wait(700);
    const code = await page.evaluate(() => document.getElementById('ko-code')?.value);
    fs.writeFileSync(path.join(OUT, 'gift-order-code.txt'), code || '');
    await page.evaluate(() => document.getElementById('ko-close')?.click());
    await page.evaluate(() => document.getElementById('kr-done')?.click());
    await wait(1500);
    await shot('15-after-gift');
  }

  if (run('pair')) {
    await page.evaluate(() => window.__birthsky.goMine());
    await toSky('16-mine');
    await page.evaluate(() => window.__birthsky.chrome.showChrome());
    await page.evaluate(() => document.getElementById('a-pair')?.click());
    await wait(1200);
    await shot('17-pair-invite');
    await page.evaluate(() => document.getElementById('pi-manual')?.click());
    await wait(800);
    await fillForm('2000', '01', '02', '06', '10', '成都', '小红');
    await until(() => window.__birthsky.mode === 'pair', 15000, 'pair');
    await wait(5000);
    await shot('18-pair');
  }

  if (run('print')) {
    const code = fs.existsSync(path.join(OUT, 'gift-order-code.txt')) ? fs.readFileSync(path.join(OUT, 'gift-order-code.txt'), 'utf8') : '';
    if (code) {
      const p2 = await browser.newPage();
      await p2.setViewport({ width: 1280, height: 900 });
      p2.on('pageerror', (e) => errors.push(String(e.stack || e)));
      await p2.goto(`${base}?print=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' });
      await p2.waitForFunction(() => document.getElementById('keep-img')?.classList.contains('on'), { timeout: 40000 });
      await wait(600);
      await p2.screenshot({ path: path.join(OUT, '19-print-page.jpg'), type: 'jpeg', quality: 70 });
      console.log('  shot 19-print-page');
    }
  }

  if (run('guest')) {
    const p3 = await browser.newPage();
    await p3.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone) Mobile' });
    p3.on('pageerror', (e) => errors.push(String(e.stack || e)));
    const link = await page.evaluate(() => location.href);
    await p3.goto(link, { waitUntil: 'domcontentloaded' });
    await wait(6000);
    await p3.screenshot({ path: path.join(OUT, '20-link-intro.jpg'), type: 'jpeg', quality: 70 });
    console.log('  shot 20-link-intro', link.slice(0, 80));
  }
  if (run('links')) {
    // build the three link kinds from inside the app, then open each in a fresh phone page
    const P = { name: '小红', date: '2000-05-20', time: '23:10', unknownTime: false, city: { name: '成都', region: '四川', lat: 30.67, lon: 104.07, tz: 'Asia/Shanghai' } };
    const links = await page.evaluate(async (P) => {
      const s = await import('/js/share.js');
      return { person: s.linkFor('person', P), gift: s.linkFor('gift', P, null, { from: '小明' }), invite: s.linkFor('invite', P) };
    }, P);
    for (const [k, url] of Object.entries(links)) {
      const pg = await browser.newPage();
      await pg.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone) Mobile' });
      pg.on('pageerror', (e) => errors.push(`${k}: ${String(e.stack || e)}`));
      await pg.goto(url.replace(/^https?:\/\/[^/]+\/(birthsky\/)?/, base), { waitUntil: 'domcontentloaded' });
      await pg.waitForFunction(() => !document.getElementById('btn-start')?.classList.contains('is-loading') && window.__birthsky?.renderer, { timeout: 40000 });
      await wait(3600);
      await pg.screenshot({ path: path.join(OUT, `21-${k}-intro.jpg`), type: 'jpeg', quality: 70 });
      await pg.click('#btn-start');
      if (k === 'invite') {
        await wait(1500);
        await pg.screenshot({ path: path.join(OUT, `22-${k}-form.jpg`), type: 'jpeg', quality: 70 });
      } else {
        await pg.waitForFunction(() => window.__birthsky?.mode === 'sky', { timeout: 40000 });
        await wait(k === 'person' ? 9000 : 2500);
        await pg.screenshot({ path: path.join(OUT, `22-${k}-sky.jpg`), type: 'jpeg', quality: 70 });
      }
      console.log('  link', k, 'ok');
      await pg.close();
    }
  }
} catch (e) {
  errors.push(`FLOW: ${e.message}`);
  await shot('zz-failure').catch(() => {});
}
console.log(errors.length ? `\n${errors.length} error(s):\n${errors.slice(0, 20).join('\n')}` : '\nno errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
