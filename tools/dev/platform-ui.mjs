// Dev check for ui.js (toast, hint queue + once-flags + dwell, press) and monetize.js (slot rows, click
// tracking) in headless Chromium.   node tools/dev/platform-ui.mjs   → exit 1 on failure, shots in .cache/dev/
import path from 'node:path';
import { startServer, launch, watch, outDir, sleep } from './platform-harness.mjs';

const { server, base } = await startServer();
const browser = await launch();
const errors = [];
const results = [];
const expect = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

try {
  const page = await browser.newPage();
  watch(page, errors);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base + 'dev/platform-ui.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
  await page.evaluate(() => localStorage.removeItem('birthsky:hints'));
  // headless Chromium produces no frames for a moment after load; transitions would sit at their start
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(600);

  // --- API surface
  const api = await page.evaluate(() => Object.keys(window.ui).sort());
  expect('ui exports', ['$', '$$', 'clearHint', 'escapeHtml', 'fmtNum', 'hint', 'hintDwell', 'hintSeen', 'markHint', 'press', 'show', 'toast']
    .every((k) => api.includes(k)) && !api.includes('ICONS') && !api.includes('icon'), api.join(','));

  // --- dwell formula
  const dw = await page.evaluate(() => [ui.hintDwell('你好'), ui.hintDwell('拖动可以环顾四周，轻触一颗星，听它的故事。'), ui.hintDwell('星'.repeat(60)), ui.hintDwell('a b')]);
  expect('hintDwell clamp(1.6+0.16n, 3.2, 9) s', dw[0] === 3200 && dw[1] === 1600 + 160 * 21 && dw[2] === 9000 && dw[3] === 3200, JSON.stringify(dw));
  expect('fmtNum', await page.evaluate(() => ui.fmtNum(4267.4) === '4,267'));

  // --- toast
  await page.evaluate(() => { ui.toast('三垣二十八宿'); });
  await sleep(450);
  let t = await page.evaluate(() => { const el = document.getElementById('toast'); return { op: getComputedStyle(el.firstElementChild).opacity, html: el.innerHTML, text: el.textContent, on: el.classList.contains('is-on') }; });
  expect('toast in (noWidow markup)', +t.op > 0.95 && t.on && t.text === '三垣二十八宿' && t.html.includes('class="nw"'), JSON.stringify(t));
  await page.screenshot({ path: path.join(outDir, 'platform-ui-toast.png') });
  await sleep(1600 + 320 + 420 - 450 + 150);
  t = await page.evaluate(() => { const el = document.getElementById('toast'); return { text: el.textContent, on: el.classList.contains('is-on') }; });
  expect('toast out after 1.6 s', t.text === '' && !t.on, JSON.stringify(t));

  // --- hint queue: timing, silence gap, once flags, has-hint
  const timeline = await page.evaluate(async () => {
    const log = [];
    const t0 = performance.now();
    addEventListener('birthsky:hint', (e) => log.push([e.detail.key, e.detail.on, Math.round(performance.now() - t0)]));
    const p1 = ui.hint('k1', '第一句提示。', { ms: 400 });
    const p2 = ui.hint('k2', '第二句提示。', { ms: 400 });
    const dup = await ui.hint('k1', '重复的键。');
    await new Promise((r) => setTimeout(r, 700));
    const mid = { hasHint: document.getElementById('stage').classList.contains('has-hint'), op: getComputedStyle(document.querySelector('#hint-slot .hint-text')).opacity,
      html: document.getElementById('hint-slot').innerHTML };
    const r = await Promise.all([p1, p2]);
    await new Promise((res) => setTimeout(res, 700));
    const again = await ui.hint('k1', '第一句提示。');
    const stored = JSON.parse(localStorage.getItem('birthsky:hints'));
    return { log, dup, mid, r, again, stored, seen: ui.hintSeen('k1'), after: document.getElementById('stage').classList.contains('has-hint') };
  });
  const [a, b, c, d] = timeline.log;
  expect('hint dedupe while queued', timeline.dup === false);
  expect('hint visible with .has-hint on the parent, noWidow applied', timeline.mid.hasHint && +timeline.mid.op > 0.95 && timeline.mid.html.includes('class="nw"'), JSON.stringify(timeline.mid));
  expect('hint 1 dwell ≈ 620 in + 400', a?.[1] === true && b?.[0] === 'k1' && b[1] === false && Math.abs(b[2] - a[2] - 1020) < 80, JSON.stringify(timeline.log));
  expect('hint 2 waits out 500 + silence 600', c?.[0] === 'k2' && c[1] === true && c[2] - b[2] >= 1090 && c[2] - b[2] < 1250, `gap ${c?.[2] - b?.[2]} ms`);
  expect('hint promises resolve true', timeline.r.every((x) => x === true));
  expect('once flag stored and respected', timeline.again === false && timeline.seen && timeline.stored.k1 === 1 && timeline.stored.k2 === 1, JSON.stringify(timeline.stored));
  expect('.has-hint removed after', timeline.after === false);

  // force, hold + clearHint, clear drops the queue
  const hold = await page.evaluate(async () => {
    const shown = ui.hint('k1', '正在绘制 1179 × 2556', { force: true, hold: true });
    const queued = ui.hint(null, '排队的提示。');
    await new Promise((r) => setTimeout(r, 2000 + 1200));
    const span = document.querySelector('#hint-slot .hint-text');
    const stillUp = getComputedStyle(span).opacity;
    ui.clearHint();
    const [s, q] = await Promise.all([shown, queued]);
    await new Promise((r) => setTimeout(r, 200));
    const fading = +getComputedStyle(span).opacity;
    await new Promise((r) => setTimeout(r, 400));
    return { stillUp, s, q, fading, text: document.getElementById('hint-slot').textContent };
  });
  expect('hold stays until clearHint; queue dropped', +hold.stillUp > 0.95 && hold.s === true && hold.q === false && hold.fading < 0.9 && hold.text === '', JSON.stringify(hold));

  // screenshot of a real hint over the stage
  await page.evaluate(() => { ui.hint('look', '拖动可以环顾四周，轻触一颗星，听它的故事。'); });
  await sleep(1400); // after the 600 ms silence from clearHint and the 620 ms fade in
  await page.screenshot({ path: path.join(outDir, 'platform-ui-hint.png') });
  await page.evaluate(() => ui.clearHint());
  await sleep(1200);

  // --- press
  const pr = await page.evaluate(async () => {
    const el = document.getElementById('a-keep');
    const off = ui.press('#actions button');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    await new Promise((r) => setTimeout(r, 120));
    const down = { op: getComputedStyle(el).opacity, cls: el.classList.contains('is-pressed'), tr: el.style.transition };
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0 }));
    await new Promise((r) => setTimeout(r, 320));
    const up = { op: getComputedStyle(el).opacity, cls: el.classList.contains('is-pressed'), tr: el.style.transition, inline: el.style.opacity };
    off();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0 }));
    const unbound = el.style.opacity;
    return { down, up, unbound };
  });
  expect('press .45 in 80 ms, back in 240 ms, unbind', Math.abs(pr.down.op - 0.45) < 0.01 && pr.down.cls && pr.down.tr.includes('80ms')
    && Math.abs(pr.up.op - 1) < 0.01 && !pr.up.cls && pr.up.inline === '' && pr.up.tr === '' && pr.unbound === '', JSON.stringify(pr));

  // --- monetize
  const mon = await page.evaluate(() => {
    const out = {};
    out.none = [mon.slotHtml('night'), mon.slotHtml('pair'), mon.slotHtml('keep')].join('');
    CONFIG.ads.provider = 'sponsor';
    out.emptyTitle = mon.slotHtml('night');
    Object.assign(CONFIG.ads.sponsor, { title: '某某天文馆 · 七夕观星夜', text: '8 月 X 日，带 TA 去看真正的银河', url: 'https://example.com/?a=1&b=<2>', image: '' });
    out.night = mon.slotHtml('night');
    out.keep = mon.slotHtml('keep');
    out.legacy = mon.slotHtml('facts') === out.night;
    out.unknown = mon.slotHtml('sky');
    CONFIG.ads.placements.keep = false;
    out.keepOff = mon.slotHtml('keep');
    CONFIG.ads.placements.keep = true;
    CONFIG.ads.sponsor.url = 'javascript:alert(1)';
    out.badUrl = mon.slotHtml('pair');
    CONFIG.ads.sponsor.url = 'https://example.com/';
    document.getElementById('night-slot').innerHTML = mon.slotHtml('night');
    document.getElementById('keep-slot').innerHTML = mon.slotHtml('keep');
    // click tracking through 百度统计's queue (no script is loaded here)
    CONFIG.analytics.provider = 'baidu'; CONFIG.analytics.baidu.id = 'test';
    window._hmt = [];
    mon.activateSlots(document.querySelector('.plate'));
    mon.activateSlots(document.querySelector('.plate')); // idempotent
    const a = document.querySelector('#night-slot a');
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    out.hmt = window._hmt;
    out.rowH = a.getBoundingClientRect().height;
    out.keepText = document.querySelector('#keep-slot a').textContent;
    out.styleFirst = document.head.firstElementChild.id;
    out.events = mon.EVENTS;
    return out;
  });
  expect('slots empty with provider none / no title', mon.none === '' && mon.emptyTitle === '');
  expect('night row: link, tag, title, text, escaped url', /class="ad-row"/.test(mon.night) && mon.night.includes('rel="noopener sponsored"')
    && mon.night.includes('<span class="ad-tag">赞助</span>') && mon.night.includes('&amp;b=&lt;2&gt;') && !mon.night.includes('<img'), mon.night);
  expect('keep line 「赞助　{title}」', mon.keepText === '赞助　某某天文馆 · 七夕观星夜' && /class="ad-line"/.test(mon.keep));
  expect('legacy place names, unknown place, placement off, unsafe url', mon.legacy && mon.unknown === '' && mon.keepOff === '' && mon.badUrl.startsWith('<div class="ad-row"') && !mon.badUrl.includes('javascript'));
  expect('ad_click tracked once per click', JSON.stringify(mon.hmt) === JSON.stringify([['_trackEvent', 'birthsky', 'ad_click', 'night']]), JSON.stringify(mon.hmt));
  expect('row ≥ 44 px, style prepended', mon.rowH >= 44 && mon.styleFirst === 'ad-style', `h ${mon.rowH}`);
  expect('EVENTS', ['caption_next', 'plate_open', 'ruler_open', 'listen', 'keep_open', 'keep_done', 'pair_invite', 'pair_result', 'share', 'guest_mine', 'ad_click'].every((e) => mon.events.includes(e)));
  await page.screenshot({ path: path.join(outDir, 'platform-ui-ad.png') });
  console.log('screenshots in', outDir);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
process.exit(errors.length || results.some((r) => !r.ok) ? 1 : 0);
