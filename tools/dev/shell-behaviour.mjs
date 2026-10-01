// Dev only: behaviour tests for the shell modules (chrome.js, form.js, ruler.js) in headless Chromium on
// src/dev/shell.html?state=blank — real DOM, real timers, real keyboard.
//   node tools/dev/shell-behaviour.mjs [filter]
import { serve, launch } from './shell-harness.mjs';

const filter = process.argv[2] || '';
const { server, base } = await serve();
const browser = await launch();
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fresh(vp = { width: 390, height: 844 }, q = '') {
  const page = await browser.newPage();
  await page.setViewport({ ...vp, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.emulateTimezone('Asia/Shanghai');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}dev/shell.html?state=blank&settle=0${q}`);
  await page.waitForFunction(() => window.shellReady, { polling: 100, timeout: 60000 });
  page.errors = errors;
  return page;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
// timing tests run on real timers; on a loaded machine one retry absorbs a dropped frame or a late timer
async function run(name, fn, attempt = 1) {
  if (filter && !name.includes(filter)) return;
  const t = Date.now();
  let page;
  let err = null;
  try {
    page = await fresh();
    await fn(page);
    if (page.errors.length) throw new Error(`page errors: ${page.errors.join(' | ')}`);
  } catch (e) {
    err = e;
  } finally {
    await page?.close();
  }
  if (err && attempt < 2) return run(name, fn, attempt + 1);
  results.push(err ? [false, name, Date.now() - t, err.message] : [true, `${name}${attempt > 1 ? ' (2nd try)' : ''}`, Date.now() - t]);
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: got ${a}, want ${b} ±${tol}`); };

// ------------------------------------------------------------------------------------------------ form
test('form: typed date auto-advances 4/2/2/2 and impossible-second digits', async (page) => {
  await page.evaluate(() => { window.__res = null; window.shell.form.open('self', { delay: 0 }).then((r) => { window.__res = r; }); });
  await sleep(700);
  await page.click('#f-y');
  await page.keyboard.type('1998714', { delay: 30 });
  let v = await page.evaluate(() => ['f-y', 'f-m', 'f-d', 'f-hh', 'f-mm'].map((id) => document.getElementById(id).value).concat(document.activeElement.id));
  eq(v, ['1998', '07', '14', '22', '00', 'f-hh'], 'after 1998 7 14');
  await page.keyboard.type('3', { delay: 30 });   // 时 first digit 3 > 2 → 03, advance
  v = await page.evaluate(() => [document.getElementById('f-hh').value, document.activeElement.id]);
  eq(v, ['03', 'f-mm'], '时 3 → 03');
  await page.keyboard.type('47', { delay: 30 });
  v = await page.evaluate(() => [document.getElementById('f-mm').value, document.activeElement?.id || '']);
  eq(v[0], '47', '分');
  ok(v[1] !== 'f-mm', 'focus leaves after 分');
  // backspace on an empty field goes back
  await page.click('#f-d');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');   // 14 → 1 (no padding, no advance on delete)
  eq(await page.evaluate(() => [document.getElementById('f-d').value, document.activeElement.id]), ['1', 'f-d'], 'delete never pads');
  await page.keyboard.press('Backspace');   // → empty
  await page.keyboard.press('Backspace');   // empty → back to 月
  v = await page.evaluate(() => document.activeElement.id);
  eq(v, 'f-m', 'backspace on empty 日 → 月');
  // overflow typing into 年 spills into 月 and 日
  await page.evaluate(() => { for (const id of ['f-y', 'f-m', 'f-d']) document.getElementById(id).value = ''; });
  await page.click('#f-y');
  await page.keyboard.type('20000102', { delay: 20 });
  v = await page.evaluate(() => ['f-y', 'f-m', 'f-d'].map((id) => document.getElementById(id).value));
  eq(v, ['2000', '01', '02'], 'continuous typing');
});

test('form: validation copy in spec order, error clears on input', async (page) => {
  const r = await page.evaluate(async () => {
    const { form } = window.shell;
    form.open('self', { delay: 0 });
    await new Promise((x) => setTimeout(x, 500));
    const set = (y, m, d) => { document.getElementById('f-y').value = y; document.getElementById('f-m').value = m; document.getElementById('f-d').value = d; };
    const err = () => { form.submit(); return document.getElementById('f-err').textContent; };
    const out = [];
    set('1998', '', ''); out.push(err());
    set('2023', '02', '30'); out.push(err());
    set('1899', '12', '31'); out.push(err());
    set('2099', '01', '01'); out.push(err());
    set('1998', '07', '14'); out.push(err());
    out.push(document.getElementById('f-err').classList.contains('on'));
    document.getElementById('f-y').value = '199';
    document.getElementById('f-y').dispatchEvent(new Event('input'));
    out.push(document.getElementById('f-err').classList.contains('on'));
    return out;
  });
  eq(r, ['出生日期还没填完', '日历上没有这一天，再看看月和日', '目前只能回到 1900 年以后', '这一天还没有到来', '出生城市还没选', true, false], 'errors');
});

test('form: city page — 常用, search, Enter picks, field shows 杭州 · 浙江, submit resolves + stores me', async (page) => {
  await page.evaluate(() => { window.__res = undefined; window.shell.form.open('self', { delay: 0 }).then((r) => { window.__res = r; }); });
  await sleep(600);
  await page.click('#f-city');
  await page.waitForFunction(() => document.querySelectorAll('#city-list li').length === 10, { polling: 100, timeout: 30000 });
  const common = await page.evaluate(() => [...document.querySelectorAll('#city-list .cp-name')].map((x) => x.textContent).join(''));
  eq(common, '北京上海广州深圳成都杭州重庆武汉西安南京', '常用');
  ok(await page.evaluate(() => document.getElementById('form').classList.contains('under')), 'form steps back under the city page');
  await page.keyboard.type('杭州');
  await page.waitForFunction(() => document.querySelector('#city-list li.is-hl .cp-name')?.textContent === '杭州', { polling: 100, timeout: 5000 });
  await page.keyboard.press('Enter');
  await sleep(100);
  eq(await page.evaluate(() => document.getElementById('f-city-value').textContent), '杭州 · 浙江', 'city field');
  ok(!(await page.evaluate(() => document.getElementById('form').classList.contains('under'))), 'form back');
  await page.evaluate(() => { document.getElementById('f-name').value = '小明'; document.getElementById('f-y').value = '1998'; document.getElementById('f-m').value = '07'; document.getElementById('f-d').value = '14'; });
  await page.click('#btn-go');
  await page.waitForFunction(() => window.__res !== undefined, { polling: 50, timeout: 3000 });
  const res = await page.evaluate(() => ({ r: window.__res, me: JSON.parse(localStorage.getItem('birthsky:me')), on: document.getElementById('form').classList.contains('on') }));
  eq([res.r.name, res.r.date, res.r.time, res.r.unknownTime, res.r.city.name, res.r.city.region, res.r.city.tz], ['小明', '1998-07-14', '22:00', false, '杭州', '浙江', 'Asia/Shanghai'], 'person');
  eq(res.me.date, '1998-07-14', 'stored me');
  ok(!res.on, 'form left');
  // no results line
  await page.evaluate(() => { window.shell.form.openCity(); });
  await page.keyboard.type('qqqqzx');
  await sleep(150);
  eq(await page.evaluate(() => document.getElementById('city-note').textContent), '没有找到这座城市，试试附近的大城市', 'none');
  await page.keyboard.press('Escape');
  ok(!(await page.evaluate(() => document.getElementById('city-page').classList.contains('on'))), 'Esc closes');
});

test('form: unknown time locks 22:00; partner never stored; confirm resolves me; 换一个生日 empties; 返回 → back', async (page) => {
  const r = await page.evaluate(async () => {
    const { form } = window.shell;
    const P = { name: '小明', date: '1998-07-14', time: '06:10', unknownTime: false, city: { name: '杭州', region: '浙江', lat: 30.29, lon: 120.16, tz: 'Asia/Shanghai' } };
    const out = {};
    let p = form.open('self', { delay: 0, me: P });
    await new Promise((x) => setTimeout(x, 300));
    out.prefill = ['f-y', 'f-m', 'f-d', 'f-hh', 'f-mm'].map((id) => document.getElementById(id).value).join(' ');
    document.getElementById('f-unknown').click();
    out.locked = [document.getElementById('f-hh').value, document.getElementById('f-mm').value, document.getElementById('f-hh').readOnly];
    form.submit();
    const self = await p;
    out.self = [self.time, self.unknownTime];
    localStorage.removeItem('birthsky:me');
    p = form.open('partner', { delay: 0 });
    await new Promise((x) => setTimeout(x, 300));
    out.partnerTitle = document.getElementById('form-title').textContent;
    out.partnerLabel = document.getElementById('f-name-label').textContent;
    out.partnerGo = document.querySelector('#btn-go .lbl').textContent;
    out.partnerEmpty = document.getElementById('f-y').value === '';
    document.getElementById('f-y').value = '2000'; document.getElementById('f-m').value = '01'; document.getElementById('f-d').value = '02';
    form._setCity(P.city);
    form.submit();
    out.partner = (await p).date;
    out.partnerStored = localStorage.getItem('birthsky:me');
    p = form.open('hepan-confirm', { delay: 0, me: P, inviter: { name: '小红' } });
    await new Promise((x) => setTimeout(x, 300));
    out.confirm = [document.getElementById('form-over').textContent, document.getElementById('form-title').textContent, document.getElementById('f-confirm-line').textContent,
      document.querySelector('#btn-go .lbl').textContent, document.getElementById('btn-go-2').textContent, document.getElementById('form-edit').hidden];
    document.getElementById('btn-go-2').click();
    out.switched = [window.shell.form.kind, document.getElementById('form-edit').hidden, document.getElementById('f-y').value, document.getElementById('form-over').textContent];
    document.getElementById('form-back').click();
    out.back = await p;
    return out;
  });
  eq(r.prefill, '1998 07 14 06 10', 'prefill');
  eq(r.locked, ['22', '00', true], 'unknown locks');
  eq(r.self, ['22:00', true], 'unknown → 22:00');
  eq([r.partnerTitle, r.partnerLabel, r.partnerGo, r.partnerEmpty], ['TA 是哪一天来的？', 'TA 的名字（可不填）', '放在一起看', true], 'partner copy');
  eq(r.partner, '2000-01-02', 'partner person');
  eq(r.partnerStored, null, 'partner never stored');
  eq(r.confirm, ['小红想和你一起抬头', '是这一天吗？', '1998 年 7 月 14 日 06:10 · 杭州', '就用这个', '换一个生日', true], 'confirm copy');
  eq(r.switched, ['hepan-self', false, '', '小红想知道你来的那天'], '换一个生日');
  eq(r.back, 'back', '返回');
});

// ------------------------------------------------------------------------------------------------ ruler
test('ruler: drag 1:1, release near birth snaps with one bell, play 30 min/s, 回到那一刻 springs, idle closes', async (page) => {
  await page.evaluate(() => {
    const { ruler, app } = window.shell;
    window.__bells = [];
    window.__closed = null;
    window.__times = 0;
    const birth = new Date('1998-07-14T14:00:00Z');
    ruler.open({ birth, tz: 'Asia/Shanghai', lat: 30.29, lon: 120.16, at: new Date(birth.getTime() + 30 * 60000),
      onTime: () => { window.__times++; }, onClose: (d, m, reason) => { window.__closed = { m, reason }; } });
    let last = performance.now();
    const loop = (t) => { ruler.step((t - last) / 1000); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    void app;
  });
  await sleep(500);
  let s = await page.evaluate(() => [document.getElementById('r-time').textContent, document.getElementById('r-rel').textContent]);
  eq(s, ['22:30', '出生后 30 分钟'], 'readout at +30');
  // drag right by 29.3 px ≈ −27.5 min → +2.5 min, slowly (no fling)
  const band = await page.$('#r-band');
  const box = await band.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(200, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(200 + i * 2.933, y); await sleep(30); }
  await sleep(120);
  const mid = await page.evaluate(() => window.shell.ruler.minutes);
  near(mid, 2.5, 0.2, 'drag is 1:1 (64 px/h)');
  await page.mouse.up();
  await sleep(900);
  s = await page.evaluate(() => [window.shell.ruler.minutes, window.__bells.length, document.getElementById('r-rel').textContent, document.getElementById('r-back').classList.contains('away')]);
  eq(s, [0, 1, '出生那一刻', false], 'snap to birth, one bell');
  // play
  await page.click('#r-play');
  eq(await page.evaluate(() => document.getElementById('r-play').textContent), '暂停', 'play label');
  await sleep(1000);
  const played = await page.evaluate(() => window.shell.ruler.minutes);
  near(played, 30, 6, '1 h per 2 s');
  await page.click('#r-play');
  await sleep(100);
  ok(await page.evaluate(() => document.getElementById('r-back').classList.contains('away')), '回到那一刻 shows when away');
  await page.click('#r-back');
  await sleep(3400);
  s = await page.evaluate(() => [Math.round(window.shell.ruler.minutes * 100) / 100, window.__bells.length]);
  eq(s, [0, 2], 'spring back to birth (ω 3), bell on arrival');
  await sleep(6400);
  s = await page.evaluate(() => window.__closed);
  eq(s?.reason, 'idle', '6 s idle closes');
});

test('ruler: fling decays (τ .35) and rubber-bands at the end; sunrise/sunset tint for a dawn birth', async (page) => {
  const r = await page.evaluate(async () => {
    const { ruler } = window.shell;
    const birth = new Date('1998-07-14T20:30:00Z'); // 04:30 Hangzhou, sunrise ≈ 05:1x
    ruler.open({ birth, tz: 'Asia/Shanghai', lat: 30.29, lon: 120.16 });
    const out = { sun: ruler.sun.map((e) => [e.kind, Math.round(e.t)]), days: document.querySelectorAll('#r-strip .day').length,
      ml: [...document.querySelectorAll('#r-strip .ml')].map((x) => x.textContent), labels: [...document.querySelectorAll('#r-strip .lb')].map((x) => x.textContent) };
    ruler._release(200); // 200 min/s fling
    const xs = [];
    for (let i = 0; i < 300; i++) { ruler.step(1 / 60); if (i % 30 === 0) xs.push(ruler.minutes); }
    out.flingEnd = ruler.minutes;
    out.mode = ruler.mode;
    ruler.t = 300; ruler._release(900); // past the end
    let peak = 0;
    for (let i = 0; i < 400; i++) { ruler.step(1 / 60); peak = Math.max(peak, ruler.minutes); }
    out.peak = peak; out.final = ruler.minutes;
    ruler.close();
    return out;
  });
  ok(r.sun.length === 1 && r.sun[0][0] === 'rise' && r.sun[0][1] > 20 && r.sun[0][1] < 60, `sun events ${JSON.stringify(r.sun)}`);
  ok(r.days === 1, `day tint segments ${r.days}`);
  ok(r.ml.length === 1 && /^日出 05:\d\d$/.test(r.ml[0]), `micro labels ${r.ml}`);
  eq(r.labels, ['01:00', '04:00', '07:00', '10:00'], 'labels every 3 h from the birth hour');
  near(r.flingEnd, 200 * 0.35, 6, 'fling travels v·τ');
  ok(r.peak > 360 && r.peak < 400, `rubber band overshoot ${r.peak}`);
  eq(r.final, 360, 'snaps back inside the range');
});

// ------------------------------------------------------------------------------------------------ chrome
test('chrome: caption swap 360/120/620, subtitle breaks at clauses, transient dwell', async (page) => {
  const r = await page.evaluate(async () => {
    const { c } = window.shell;
    c.scene('sky');
    const t = document.getElementById('cap-text');
    await c.caption('今晚你看到的织女星，光是在 2001 年出发的，那年你 3 岁。', { key: 'a' });
    const html = t.innerText;
    await new Promise((x) => setTimeout(x, 700));
    const t0 = performance.now();
    const samples = [];
    const p = c.caption('那晚是一轮亏凸月，被照亮 73%。', { key: 'b' });
    const sample = () => samples.push([Math.round(performance.now() - t0), +getComputedStyle(t).opacity, t.textContent.slice(0, 3)]);
    while (performance.now() - t0 < 1400) { sample(); await new Promise((x) => requestAnimationFrame(x)); }
    await p;
    const t1 = performance.now();
    const ok = await c.caption('轻触', { transient: true, ms: 400 });
    return { html, samples, transient: Math.round(performance.now() - t1), ok, gone: c.captionKey };
  });
  eq(r.html.split('\n'), ['今晚你看到的织女星，', '光是在 2001 年出发的，那年你 3 岁。'], 'clause break');
  const firstNew = r.samples.find((x) => x[2] === '那晚是');
  const old = r.samples.filter((x) => x[2] === '今晚你');
  ok(old.length && old[old.length - 1][0] >= 400, `old text kept through out + blank (${JSON.stringify(r.samples.filter((x, i) => i % 6 === 0))})`);
  ok(old.some((x) => x[0] > 300 && x[1] < 0.15), 'old text faded out by ~360 ms');
  ok(firstNew && firstNew[0] >= 470 && firstNew[0] < 650, `new text after 360 + 120 ms (${firstNew?.[0]})`);
  const last = r.samples[r.samples.length - 1];
  ok(last[2] === '那晚是' && last[1] > 0.9, `new text in by ~1100 ms (${last})`);
  near(r.transient, 620 + 400 + 500 + 360 + 120, 200, 'transient lifetime (swap + in + dwell + out)');
  eq(r.gone, null, 'transient caption gone');
});

test('chrome: idle manager (D-4) — first visit never hides; 8 s idle → 1200 ms fade; drag hides 240 ms, back 600 ms after settle; tap toggles', async (page) => {
  const r = await page.evaluate(async () => {
    const { c } = window.shell;
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    c.scene('sky'); c.meta('1998 年 7 月 14 日 22:00 · 杭州', '22:00'); c.summary('亏凸月'); c.actions('own'); c.toggles({ culture: 'cn', sound: true, gyro: null });
    c.showChrome({ first: true });
    const out = {};
    for (let i = 0; i < 600; i++) c.frame({ dt: 1 / 60, settled: true }); // 10 s, never touched
    out.firstVisit = c.chromeOn;
    c.pointerDown(); c.pointerUp();                                         // first touch (a tap)
    out.tap = c.tapSky();
    out.afterTap = c.chromeOn;
    out.tap2 = c.tapSky();
    for (let i = 0; i < 470; i++) c.frame({ dt: 1 / 60, settled: true });
    out.at78 = c.chromeOn;
    for (let i = 0; i < 20; i++) c.frame({ dt: 1 / 60, settled: true });
    out.at81 = c.chromeOn;
    out.metaHi = document.getElementById('meta').classList.contains('hi');
    out.capOn = document.getElementById('cap-wrap').classList.contains('on');
    c.tapSky();
    c.pointerDown(); c.dragStart();
    out.drag = [c.chromeOn, getComputedStyle(document.getElementById('actions')).transitionDuration.split(',')[0]];
    c.pointerUp();
    for (let i = 0; i < 20; i++) c.frame({ dt: 1 / 60, settled: false });   // still moving
    out.moving = c.chromeOn;
    for (let i = 0; i < 30; i++) c.frame({ dt: 1 / 60, settled: true });    // 0.5 s settled
    out.at05 = c.chromeOn;
    for (let i = 0; i < 8; i++) c.frame({ dt: 1 / 60, settled: true });     // 0.63 s
    out.at06 = c.chromeOn;
    c.suspend('plate', true);
    for (let i = 0; i < 600; i++) c.frame({ dt: 1 / 60, settled: true });
    out.suspended = c.chromeOn;
    await wait(10);
    return out;
  });
  eq(r.firstVisit, true, 'first visit: no auto-hide before the first touch');
  eq([r.tap, r.afterTap, r.tap2], ['hide', false, 'show'], 'tap toggles');
  eq([r.at78, r.at81], [true, false], 'hides after 8 s idle');
  eq([r.metaHi, r.capOn], [false, false], 'meta back to α.40, caption fades with chrome');
  eq(r.drag, [false, '0.24s'], 'drag hides in 240 ms');
  eq([r.moving, r.at05, r.at06], [false, false, true], 'returns 600 ms after settle');
  eq(r.suspended, true, 'plate suspends auto-hide');
});

test('chrome: tags — enter after 800 ms settled inside the central 30 %, leave 600 ms after exiting 40 %', async (page) => {
  const r = await page.evaluate(async () => {
    const { c } = window.shell;
    const { Camera } = await import('/js/camera.js');
    const cam = new Camera(); cam.setSize(390, 844); cam.az = 180; cam.alt = 25; cam.fov = 72; cam.update();
    const n = cam.unproject(195 + 30, 422 - 40);
    c.scene('sky');
    c.setTags([{ key: 'moon', n, text: '月亮 · 亏凸月 73%' }]);
    const out = [];
    for (let i = 0; i < 40; i++) c.frame({ dt: 1 / 60, settled: true, cam });       // 0.67 s
    out.push(c.tags.length);
    for (let i = 0; i < 20; i++) c.frame({ dt: 1 / 60, settled: true, cam });       // 1.0 s
    out.push(c.tags.length && +c.tags[0].alpha.toFixed(2));
    for (let i = 0; i < 30; i++) c.frame({ dt: 1 / 60, settled: true, cam });
    out.push(+c.tags[0].alpha.toFixed(2));
    cam.az = 160; cam.update();                                                     // object leaves the centre
    for (let i = 0; i < 30; i++) c.frame({ dt: 1 / 60, settled: false, cam });       // 0.5 s outside
    out.push(+c.tags[0].alpha.toFixed(2));
    for (let i = 0; i < 40; i++) c.frame({ dt: 1 / 60, settled: false, cam });
    out.push(c.tags.length);
    return out;
  });
  eq(r[0], 0, 'not before 800 ms settled');
  ok(r[1] > 0 && r[1] < 1, `fading in ${r[1]}`);
  eq(r[2], 1, 'in');
  eq(r[3], 1, 'still there 500 ms after leaving');
  eq(r[4], 0, 'gone after 600 ms + fade');
});

test('chrome: rewind odometer lands on 1998.07.14, arrival hand-off flies into the meta line', async (page) => {
  const r = await page.evaluate(async () => {
    const { c, T } = window.shell;
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    const birth = new Date('1998-07-14T14:00:00Z'), now = new Date('2026-09-30T12:00:00Z');
    const D = 4.37 * 86164090.5;
    const { ease } = await import('/js/camera.js');
    const B = ease.bezier(0.55, 0, 0.12, 1);
    c.rewindStart({ from: now, to: birth, tz: 'Asia/Shanghai', sub: T.rewind.ago(birth, now), place: '杭州 · 小明', skippable: false });
    const out = { start: document.getElementById('rw-date').getAttribute('aria-label') };
    let placeAt = null;
    for (let f = 0; f <= 60; f++) {
      const u = f / 60;
      c.rewindFrame(new Date(birth.getTime() + (1 - B(u)) * D), u);
      if (placeAt === null && document.getElementById('rw-sub-b').classList.contains('on')) placeAt = u;
      await new Promise((x) => requestAnimationFrame(x));
    }
    out.placeAt = placeAt;
    c.arrive({ sub: '22:00 · 杭州', title: T.arrive.titleOwn });
    await wait(1600);
    const cell = parseFloat(getComputedStyle(document.getElementById('rw-date')).fontSize) * 1.2;
    out.digits = [...document.querySelectorAll('#rw-date .os')].map((s) => {
      const y = -new DOMMatrix(getComputedStyle(s).transform).m42 / cell;
      return Math.round(y * 100) / 100 % 10;
    }).join(',');
    out.sub = document.querySelector('#rw-sub .rs.on').textContent;
    out.card = [document.getElementById('rw-card').textContent, document.getElementById('rw-card').classList.contains('on')];
    const t0 = performance.now();
    const landing = c.land({ meta: '1998 年 7 月 14 日 22:00 · 杭州', time: '22:00' });
    await wait(200);
    out.metaEarly = +getComputedStyle(document.getElementById('meta')).opacity;
    await landing;
    out.land = Math.round(performance.now() - t0);
    out.after = [document.getElementById('rewind').classList.contains('on'), document.getElementById('meta').classList.contains('on'),
      document.getElementById('app').dataset.scene, document.querySelector('#meta .tw').textContent];
    return out;
  });
  eq(r.start, '2026.09.30', 'counter starts at today');
  ok(r.placeAt >= 0.72 && r.placeAt < 0.75, `sub-line becomes the place at 72 % (${r.placeAt})`);
  eq(r.digits, '1,9,9,8,0,7,1,4', 'odometer at 1998.07.14');
  eq(r.sub, '22:00 · 杭州', 'arrival sub-line');
  eq(r.card, ['这一夜，你来了', true], 'title card');
  near(r.land, 700, 120, 'shared-element move 700 ms');
  ok(r.metaEarly < 0.05, `meta line waits for the counter (opacity ${r.metaEarly} at 200 ms)`);
  eq(r.after, [false, true, 'sky', '22:00'], 'meta line in place, rewind layer gone');
});

test('chrome: plate events + exposure, swipe-free close, 在天上看 emits look; pair invite cancel; strip crossfade + idle', async (page) => {
  const r = await page.evaluate(async () => {
    const { c } = window.shell;
    const wait = (ms) => new Promise((x) => setTimeout(x, ms));
    const ev = [];
    for (const n of ['exposure', 'plate', 'look', 'invite', 'strip-close', 'poem-next']) c.on(n, (d) => ev.push([n, d?.value ?? d?.key ?? d?.reason ?? d?.kind ?? d]));
    c.scene('sky');
    c.openNight({ meta: 'm', rows: [{ key: 'moon', label: '月亮', text: 't', meta: 'x', action: '在天上看', target: { type: 'body', id: 'Moon' } }], poem: { lines: ['星垂平野阔，月涌大江流。'], attribution: '杜甫《旅夜书怀》', count: '' } });
    await wait(700);
    document.querySelector('[data-poem]').click();
    document.querySelector('[data-look]').click();
    await wait(450);
    const closed = !document.getElementById('night').classList.contains('on');
    c.openAbout();
    await wait(600);
    const about = [document.getElementById('night-title').textContent, getComputedStyle(document.getElementById('night-foot')).display];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wait(450);
    c.pairInvite(true);
    await wait(700);
    document.getElementById('pi-cancel').click();
    await wait(450);
    const scene = document.getElementById('app').dataset.scene;
    c.strip({ name: '大角星', latin: 'Arcturus', meta: 'm', story: 's' });
    await wait(50);
    c.strip({ name: '织女星', latin: 'Vega', meta: 'm', story: 's' });
    const mid = document.getElementById('s-name').textContent;
    await wait(600);
    const after = document.getElementById('s-name').textContent;
    for (let i = 0; i < 12 * 60 + 5; i++) c.frame({ dt: 1 / 60, settled: true });
    return { ev, closed, about, scene, mid, after, stripOpen: document.getElementById('app').classList.contains('strip-open') };
  });
  eq(r.ev.slice(0, 2), [['exposure', 0.55], ['plate', 'night']], 'plate open events');
  ok(r.ev.some((e) => e[0] === 'poem-next'), '换一首 emits poem-next');
  ok(r.ev.some((e) => e[0] === 'look' && e[1] === 'moon'), 'look emitted with the row key');
  ok(r.closed, '在天上看 closes the plate');
  eq(r.about, ['关于', 'none'], 'about plate: colophon only');
  ok(r.ev.filter((e) => e[0] === 'exposure').map((e) => e[1]).join() === '0.55,1,0.55,1,0.5,1', `exposure sequence ${JSON.stringify(r.ev)}`);
  ok(r.ev.some((e) => e[0] === 'invite' && e[1] === 'cancel'), 'invite cancel');
  eq(r.scene, 'sky', 'cancel returns to the sky');
  eq([r.mid, r.after], ['大角星', '织女星'], 'strip crossfades (500 out / 700 in)');
  ok(r.ev.some((e) => e[0] === 'strip-close' && e[1] === 'idle') && !r.stripOpen, 'strip closes after 12 s idle');
});

test('chrome: intro timeline — title 1.2 s, lede 2.6 s, CTA 3.4 s; progress label; ready crossfade', async (page) => {
  const r = await page.evaluate(async () => {
    const { c } = window.shell;
    const on = (id) => document.getElementById(id).classList.contains('on');
    c.intro();
    c.introProgress(0.62);
    const out = { label: document.querySelector('#btn-start .lbl').textContent, p: document.getElementById('btn-start').style.getPropertyValue('--p') };
    const t0 = performance.now();
    const at = {};
    while (performance.now() - t0 < 3700) {
      for (const id of ['intro-title', 'intro-lede', 'intro-cta', 'intro-hint', 'btn-about']) if (!at[id] && on(id)) at[id] = Math.round(performance.now() - t0);
      await new Promise((x) => setTimeout(x, 20));
    }
    out.at = at;
    c.introReady('回到那一晚');
    await new Promise((x) => setTimeout(x, 900));
    out.ready = [document.querySelector('#btn-start .lbl').textContent, document.getElementById('btn-start').classList.contains('is-loading')];
    let started = false;
    c.on('start', () => { started = true; });
    document.getElementById('btn-start').click();
    out.started = started;
    return out;
  });
  eq([r.label, r.p], ['载入星表 62%', '0.620'], 'loading label + fill');
  near(r.at['intro-title'], 1200, 80, 'title');
  near(r.at['intro-lede'], 2600, 80, 'lede');
  near(r.at['intro-cta'], 3400, 80, 'CTA');
  near(r.at['btn-about'], 3580, 80, '关于 staggered');
  eq(r.ready, ['回到那一晚', false], 'ready');
  ok(r.started, 'start event');
});

test('shell: no <em>, no backdrop-filter, no running CSS animation, no radius outside the window/frame', async (page) => {
  const r = await page.evaluate(async () => {
    const { c } = window.shell;
    c.scene('sky'); c.meta('1998 年 7 月 14 日 22:00 · 杭州', '22:00'); c.showChrome();
    const all = [...document.querySelectorAll('*')];
    return {
      em: document.querySelectorAll('em').length,
      bf: all.filter((e) => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none'); }).length,
      anim: all.filter((e) => getComputedStyle(e).animationName !== 'none').map((e) => e.id || e.className),
      radius: all.filter((e) => { const s = getComputedStyle(e); return parseFloat(s.borderTopLeftRadius) > 0 && !e.classList.contains('kf-frame') && !e.matches('.r-strip .dot'); }).map((e) => e.id || e.className),
      sheets: [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } }).filter((t) => /infinite|backdrop-filter/.test(t)),
    };
  });
  eq(r.em, 0, '<em>');
  eq(r.bf, 0, 'backdrop-filter');
  eq(r.anim, [], 'CSS animations');
  eq(r.radius, [], 'radius');
  eq(r.sheets, [], 'infinite / backdrop-filter rules');
});

// sequentially: a page that is not in front gets no animation frames
try {
  for (const [name, fn] of tests) await run(name, fn);
} finally {
  await browser.close();
  server.close();
}
let failed = 0;
for (const [pass, name, ms, err] of results) {
  if (!pass) failed++;
  console.log(`${pass ? '✓' : '✗'} ${name} (${ms} ms)${pass ? '' : `\n    ${err}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
