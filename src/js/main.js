// 你来的那晚 — app controller: intro → form → time-rewind → the night's sky → poster / 合盘 / share.
import { loadCatalog, mwAt } from './catalog.js';
import { SkyRenderer } from './renderer.js';
import { Overlay } from './overlay.js';
import { Camera, ease, angDiff } from './camera.js';
import { Cosmos } from './audio.js';
import {
  skyState, skyMatrix, zonedToUtc, zonedParts, radec, mul, altAz, SIDEREAL_DAY_MS, yearsBetween, DEG,
} from './astro.js';
import { computeFacts, renderFacts, factsPeek, describe } from './facts.js';
import { $, $$, show, toast, icon, escapeHtml } from './ui.js';
import { parseLink, linkFor, shareLink, setShareTarget, isWeChat, isMobile } from './share.js';
import { slotHtml, activateSlots, initAnalytics, track } from './monetize.js';
import { PosterStudio, POSTER_STYLES } from './poster.js';
import { computeHepan, HepanView } from './hepan.js';
import { drawMoon } from './overlay.js';

const BG = [4 / 255, 6 / 255, 13 / 255];
// eslint-disable-next-line no-undef
const DATA_V = typeof __DATA_VERSION__ !== 'undefined' ? __DATA_VERSION__ : String(Date.now());
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`birthsky:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`birthsky:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const pad = (n) => String(n).padStart(2, '0');

const app = {
  catalog: null, renderer: null, overlay: null, cam: new Camera(), audio: new Cosmos(),
  mode: 'intro', link: { kind: null },
  me: store.get('me'), viewing: null, own: true, partner: null,
  moment: new Date(), lat: 39.9, lon: 116.4, live: true,
  home: null, sky: null, facts: null, sel: null,
  w: innerWidth, h: innerHeight, dpr: 1,
  vis: {
    reveal: -2, mwAmt: 0, starGain: 1, dustGain: 1, sizeGain: 1, crisp: 1, flash: 0, exposure: 1,
    lines: 0, linesProgress: 0, labels: 0, names: 0, ring: 0, bodies: 1, bodyLabels: 1,
    sweepOn: 0, sweep: 0, terrainH: 0.05, dome: 0, dayMask: 0,
    trail: { on: false, fade: 0.95, opacity: 0, Ms: [], clear: false, gain: 0.55 },
  },
  camPreset: 'intro',
  drag: null, pointers: new Map(), vel: { az: 0, alt: 0 }, lastTap: null,
  rewind: null, listen: null, night: null, gyro: null,
  muted: !!store.get('muted'),
  frameTimes: [],
};

// ------------------------------------------------------------------ tweens
const tweens = [];
function tween(obj, key, to, dur, fn = ease.inOut, delay = 0) {
  for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].obj === obj && tweens[i].key === key) tweens.splice(i, 1);
  return new Promise((res) => tweens.push({ obj, key, to, dur, fn, start: performance.now() + delay, from: null, res }));
}
function runTweens(now) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (now < tw.start) continue;
    if (tw.from === null) {
      tw.from = tw.obj[tw.key];
      if (tw.key === 'az') tw.to = tw.from + angDiff(tw.from, tw.to);
    }
    const t = tw.dur <= 0 ? 1 : Math.min(1, (now - tw.start) / tw.dur);
    tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.fn(t);
    if (t >= 1) { tweens.splice(i, 1); tw.res(); }
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ layout & camera presets
function domeRect() {
  // the largest dome that fits between the title block and the time strip, leaving room for 北/南/东/西
  const wide = app.w >= 960;
  const right = wide ? app.w - 396 : app.w;
  const top = $('.who').getBoundingClientRect().bottom + 40;
  const guest = $('#hud').classList.contains('is-guest');
  const lowEl = guest ? $('#guest-bar') : $('#time-strip');
  const lowTop = lowEl.getBoundingClientRect().top;
  const bottom = (lowTop > top + 120 ? lowTop : app.h - 200) - 38;
  const R = Math.max(90, Math.min(right / 2 - 38, (bottom - top) / 2, 420));
  return { cx: right / 2, cy: (top + bottom) / 2, R };
}

function preset(name) {
  const w = app.w, h = app.h;
  if (name === 'intro') {
    return { cx: w / 2, cy: h * 0.36, domeR: Math.max(h * 0.95, w * 0.95), alt: 55, zoom: 1 };
  }
  if (name === 'form') {
    const sheetTop = h - $('#form').offsetHeight;
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st')) || 0;
    const avail = Math.max(120, (w >= 960 ? h * 0.42 : sheetTop) - top);
    const R = Math.max(70, Math.min(w * 0.4, avail / 2 - 34));
    return { cx: w / 2, cy: top + avail / 2 + 4, domeR: R, alt: 90, az: 180, zoom: 1 };
  }
  if (name === 'horizon') {
    return { cx: app.w / 2, cy: app.h * 0.45, domeR: Math.max(app.h * 1.05, app.w), alt: 28, zoom: 1 };
  }
  const d = domeRect();
  return { cx: d.cx, cy: d.cy, domeR: d.R, alt: 90, az: 180, zoom: 1 };
}

function moveCamera(name, dur = 2200, fn = ease.inOut) {
  app.camPreset = name;
  const p = preset(name);
  const c = app.cam;
  const jobs = [];
  for (const k of ['cx', 'cy', 'domeR', 'alt', 'zoom', 'az']) {
    if (p[k] === undefined) continue;
    if (dur <= 0) c[k] = p[k];
    else jobs.push(tween(c, k, p[k], dur, fn));
  }
  return Promise.all(jobs);
}

function layout() {
  app.w = innerWidth; app.h = innerHeight;
  document.documentElement.style.setProperty('--vh', `${app.h / 100}px`);
  app.dpr = Math.min(window.devicePixelRatio || 1, app.lowPower ? 1.25 : 2);
  app.renderer?.resize(app.w, app.h, app.dpr);
  app.overlay?.resize(app.w, app.h, app.dpr);
  if (!app.rewind) moveCamera(app.camPreset, 0);
}

// ------------------------------------------------------------------ boot
async function boot() {
  setupIcons();
  layout();
  app.link = parseLink();
  introCopy();
  initAnalytics();
  const bar = $('#btn-start .btn-progress i');
  try {
    app.catalog = await loadCatalog('data/', `?v=${DATA_V}`, (p) => { bar.style.width = `${Math.round(p * 80)}%`; });
  } catch (e) {
    console.error(e);
    $('#btn-start .btn-label').textContent = '加载失败，请刷新重试';
    return;
  }
  try {
    app.renderer = new SkyRenderer($('#sky'), app.catalog);
  } catch (e) {
    console.error(e);
    $('#fallback').hidden = false;
    show('#intro', false);
    return;
  }
  app.overlay = new Overlay($('#overlay'), app.catalog);
  app.posters = new PosterStudio(app.catalog);
  app.hepanView = new HepanView(app);
  layout();
  moveCamera('intro', 0);
  faceMilkyWay();
  app.sky = skyState(app.moment, app.lat, app.lon);
  requestAnimationFrame(frame);

  import('./cities.js').then(async (m) => {
    app.cities = m;
    await m.loadCities(`data/cities.json?v=${DATA_V}`);
    bar.style.width = '100%';
    const home = m.guessHomeCity();
    if (home) {
      app.home = home;
      if (app.mode === 'intro' && app.live) { app.lat = home.lat; app.lon = home.lon; app.skyDirty = true; if (!app.drag) faceMilkyWay(); }
    }
  }).catch((e) => console.warn('cities', e));

  // eyes adjusting to the dark
  tween(app.vis, 'reveal', 6.6, 5200, ease.out, 200);
  tween(app.vis, 'mwAmt', 1.6, 6000, ease.inOut, 600);
  await wait(1400);
  const start = $('#btn-start');
  start.disabled = false;
  start.querySelector('.btn-label').textContent = app.link.kind === 'person' ? '去看看' : app.link.kind === 'invite' ? '开始合盘' : app.link.kind === 'result' ? '查看合盘' : '开启';
  bindEvents();
}

function introCopy() {
  const L = app.link;
  const nm = (p) => escapeHtml(p.name || 'TA');
  if (L.kind === 'person') {
    $('#intro-eyebrow').textContent = 'A Night Shared With You';
    $('#intro-lede').innerHTML = `${nm(L.a)} 想让你看看，<br>TA 出生那晚的天空。`;
  } else if (L.kind === 'invite') {
    $('#intro-eyebrow').textContent = 'An Invitation';
    $('#intro-lede').innerHTML = `${nm(L.a)} 想和你合一下星空。<br>你们出生那晚，有多少颗星同时亮着？`;
  } else if (L.kind === 'result') {
    $('#intro-eyebrow').textContent = 'Two Skies';
    $('#intro-lede').innerHTML = `${nm(L.a)} 与 ${nm(L.b)}<br>出生那晚的星空合盘`;
  }
  $$('#intro .intro-body > *, #intro .intro-actions').forEach((el, i) => {
    el.classList.add('reveal');
    el.style.animationDelay = `${0.5 + i * 0.45}s`;
  });
}

function faceMilkyWay() {
  // The opening sky is scenery, not a claim about "now": pick the hour today when the Milky Way stands
  // most gloriously over the viewer's city, and face its brightest stretch.
  const now = Date.now();
  let best = { score: -1, h: 0, az: 160 };
  for (let h = 0; h < 24; h++) {
    const M = skyMatrix(new Date(now + h * 3600e3), app.lat, app.lon);
    const Mt = [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
    for (let az = 0; az < 360; az += 12) {
      let L = 0;
      for (const alt of [22, 34, 46, 58, 70]) {
        const n = [Math.cos(alt * DEG) * Math.cos(az * DEG), Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG)];
        const e = mul(Mt, n);
        L += mwAt(app.catalog.mwLum, Math.atan2(e[1], e[0]) / DEG, Math.asin(e[2]) / DEG) * (alt < 30 ? 0.7 : 1);
      }
      if (L > best.score) best = { score: L, h, az };
    }
  }
  app.introOffset = best.h * 3600e3;
  app.moment = new Date(now + app.introOffset);
  app.skyDirty = true;
  app.cam.az = best.az - 10; // the slow pan then drifts across it
}

function setupIcons() {
  icon('#btn-sound', app.muted ? 'soundOff' : 'soundOn');
  icon('#btn-view', 'eye');
  icon('#btn-night', 'play');
  icon('#btn-listen .ico', 'listen');
  icon('#btn-poster .ico', 'poster');
  icon('#btn-hepan .ico', 'hepan');
  icon('#btn-share .ico', 'share');
  icon('#btn-hp-back', 'back');
  $$('[data-close]').forEach((b) => icon(b, 'close'));
  $('#btn-sound').classList.toggle('is-on', !app.muted);
}

// ------------------------------------------------------------------ frame loop
let lastT = 0, skyStamp = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  const dt = Math.min(0.05, t - lastT || 0.016);
  lastT = t;
  runTweens(now);
  perfWatch(dt);

  const cam = app.cam;
  if (app.mode === 'intro' && !app.drag) cam.az += dt * 1.1;
  if (!app.drag && !app.gyro?.on) {
    if (Math.abs(app.vel.az) > 0.01 || Math.abs(app.vel.alt) > 0.01) {
      cam.az += app.vel.az * dt; cam.alt = Math.max(6, Math.min(90, cam.alt + app.vel.alt * dt));
      const k = Math.exp(-dt * 3.2);
      app.vel.az *= k; app.vel.alt *= k;
    }
  }
  if (app.gyro?.on && app.gyro.target) {
    const g = app.gyro.target;
    cam.az += angDiff(cam.az, g.az) * Math.min(1, dt * 8);
    cam.alt += (g.alt - cam.alt) * Math.min(1, dt * 8);
  }

  if (app.rewind) stepRewind(now);
  else if (app.night) stepNight(dt);
  else if (app.live && now - skyStamp > 1000) { app.moment = new Date(Date.now() + (app.introOffset || 0)); skyStamp = now; app.skyDirty = true; }
  if (app.skyDirty || !app.sky) {
    app.sky = skyState(app.moment, app.lat, app.lon);
    app.skyDirty = false;
  }
  if (app.listen) stepListen(now);

  cam.update();
  const v = app.vis;
  v.dome = smooth(50, 86, cam.alt);
  const s = frameState(t);
  app.renderer.render(s.gl);
  app.overlay.draw(s.ov);
}

function frameState(t) {
  const sky = app.sky, v = app.vis, cam = app.cam;
  const sunAlt = sky.sun.alt;
  const gl = {
    cam, M: sky.M, time: t, sun: sky.sun.n, moon: sky.moon.n,
    moonIllum: sky.moonPhase.illum * (sky.moon.alt > -2 ? 1 : 0) * v.bodies,
    twilight: smooth(-18, -2, sunAlt) * 0.92 * v.dayMask, day: smooth(-3, 10, sunAlt) * 0.6 * v.dayMask,
    reveal: v.reveal, mwAmt: v.mwAmt, starGain: v.starGain, dustGain: v.dustGain, sizeGain: v.sizeGain * sizeForView(),
    crisp: v.crisp, flash: v.flash, sweep: v.sweep, sweepOn: v.sweepOn,
    sel: app.sel?.type === 'star' ? app.sel.index : -1, twinkle: 1, terrainH: v.terrainH,
    bg: BG, dome: v.dome, exposure: v.exposure, grain: 0.014, vignette: 0.55, trail: v.trail,
  };
  const ov = { cam, M: sky.M, sky, vis: v, sel: app.sel };
  return { gl, ov };
}

function sizeForView() {
  // stars read a little larger when the dome is small, and when zoomed in
  const R = app.cam.domeR * app.cam.zoom;
  return Math.max(0.78, Math.min(1.6, Math.pow(R / 190, 0.35)));
}

function perfWatch(dt) {
  if (app.lowPower || app.mode === 'intro') return;
  const f = app.frameTimes;
  f.push(dt);
  if (f.length > 90) f.shift();
  if (f.length === 90) {
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    if (avg > 0.034) { app.lowPower = true; layout(); }
  }
}

// ------------------------------------------------------------------ people & moments
function momentOf(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm] = p.time.split(':').map(Number);
  return zonedToUtc(y, m, d, hh, mm, p.city.tz);
}

function fmtWhen(p, sep = ' ') {
  const [y, m, d] = p.date.split('-').map(Number);
  return `${y} 年 ${m} 月 ${d} 日${sep}${p.unknownTime ? '夜里' : p.time}`;
}

function titleFor(p, own) {
  if (own) return p.name ? `${p.name}出生那晚的星空` : '你出生那晚的星空';
  return `${p.name || 'TA'}出生那晚的星空`;
}

// ------------------------------------------------------------------ intro → form
function onStart() {
  app.audio.start();
  app.audio.setMuted(app.muted);
  track('start', app.link.kind || 'direct');
  show('#intro', false);
  const L = app.link;
  if (L.kind === 'person') {
    rewindTo(L.a, { own: false });
  } else if (L.kind === 'result') {
    app.viewing = L.a;
    setPlace(L.a);
    showHepan(L.a, L.b, { fromLink: true });
  } else if (L.kind === 'invite') {
    openForm(app.me ? 'hepan-confirm' : 'hepan-self');
  } else {
    openForm('self');
  }
}

function setPlace(p) {
  app.live = false;
  app.moment = momentOf(p);
  app.lat = p.city.lat; app.lon = p.city.lon;
  app.skyDirty = true;
}

let formKind = 'self';
let formCity = null;
function openForm(kind) {
  formKind = kind;
  app.mode = 'form';
  document.body.className = 'in-form';
  const other = app.link.a;
  const titles = {
    self: ['回到那一夜', '你是哪一天来到这个世界的？', '回到那一夜'],
    'hepan-self': ['星空合盘', `${other?.name || 'TA'} 在等你。你是哪一天出生的？`, '开始合盘'],
    'hepan-confirm': ['星空合盘', '用这个生日来合盘吗？', '开始合盘'],
    partner: ['星空合盘', 'TA 是哪一天来到这个世界的？', '合盘'],
  }[kind];
  $('#form-eyebrow').textContent = titles[0];
  $('#form-title').textContent = titles[1];
  $('#btn-go .btn-label').textContent = titles[2];
  $('#f-name').parentElement.querySelector('span').textContent = kind === 'partner' ? 'TA 的名字' : '名字';
  const src = kind === 'partner' ? null : app.me;
  $('#f-name').value = src?.name || '';
  $('#f-date').value = src?.date || '';
  $('#f-time').value = src?.time || '22:00';
  $('#f-unknown').checked = !!src?.unknownTime;
  syncUnknown();
  formCity = src?.city || (app.home ? cityFromResult(app.home) : null);
  $('#f-city').value = formCity ? cityLabel(formCity) : '';
  $('#f-date').max = new Date().toISOString().slice(0, 10);
  $('#f-err').textContent = '';
  $('#form').classList.add('is-open');
  $('#form').setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => setTimeout(() => moveCamera('form', 2600), 60));
  tween(app.vis, 'ring', 1, 1500, ease.inOut, 1200);
  tween(app.vis, 'lines', 0.6, 1500, ease.inOut, 1600);
  tween(app.vis, 'linesProgress', 1, 3000, ease.inOut, 1600);
  tween(app.vis, 'terrainH', 0.028, 2600);
}

function closeForm() {
  $('#form').classList.remove('is-open');
  $('#form').setAttribute('aria-hidden', 'true');
  $('#f-suggest').classList.remove('is-open');
  document.activeElement?.blur?.();
}

function cityFromResult(c) {
  return { name: c.name, region: c.region || (c.country && c.cc !== 'CN' ? c.country : ''), lat: c.lat, lon: c.lon, tz: c.tz };
}
function cityLabel(c) {
  return c.region ? `${c.name} · ${c.region}` : c.name;
}

function syncUnknown() {
  const un = $('#f-unknown').checked;
  $('#f-time-wrap').classList.toggle('is-disabled', un);
  $('#f-time').disabled = un;
  if (un) $('#f-time').value = '22:00';
}

let suggestItems = [], suggestHl = -1;
function renderSuggest(q) {
  const list = $('#f-suggest');
  if (!app.cities?.citiesReady() || !q.trim()) { list.classList.remove('is-open'); return; }
  suggestItems = app.cities.searchCities(q, 8);
  suggestHl = suggestItems.length ? 0 : -1;
  list.innerHTML = suggestItems.map((c, i) => `<li role="option" data-i="${i}" class="${i === 0 ? 'is-hl' : ''}"><span>${escapeHtml(c.name)}</span><small>${escapeHtml([c.region, c.cc === 'CN' ? '' : c.country].filter(Boolean).join(' · '))}</small></li>`).join('')
    || '<li aria-disabled="true"><span>没有找到这个城市</span><small>试试附近的大城市</small></li>';
  list.classList.add('is-open');
}
function pickSuggest(i) {
  const c = suggestItems[i];
  if (!c) return;
  formCity = cityFromResult(c);
  $('#f-city').value = cityLabel(formCity);
  $('#f-suggest').classList.remove('is-open');
  $('#f-err').textContent = '';
}

function readForm() {
  const date = $('#f-date').value;
  const unknown = $('#f-unknown').checked;
  const time = unknown ? '22:00' : ($('#f-time').value || '22:00').slice(0, 5);
  if (!date) return { err: '请选择出生日期' };
  if (date < '1900-01-01') return { err: '目前支持 1900 年以后的日期' };
  if (!formCity) return { err: '请从列表里选择出生城市' };
  const p = { name: $('#f-name').value.trim().slice(0, 12), date, time, unknownTime: unknown, city: formCity };
  if (momentOf(p) > new Date()) return { err: '这一天还没有到来哦' };
  return { p };
}

async function submitForm() {
  if (formKind === 'hepan-confirm') {
    closeForm();
    return showHepan(app.me, app.link.a);
  }
  const { p, err } = readForm();
  if (err) { $('#f-err').textContent = err; return; }
  closeForm();
  if (formKind === 'partner') {
    app.partner = p;
    track('hepan_manual');
    return showHepan(app.me, p);
  }
  app.me = p;
  store.set('me', p);
  if (formKind === 'hepan-self') {
    await rewindTo(p, { own: true, then: () => showHepan(p, app.link.a) });
    return;
  }
  rewindTo(p, { own: true });
}

// ------------------------------------------------------------------ the rewind
const REWIND_MS = 6200;
function rewindTo(person, { own, then } = {}) {
  track('rewind', own ? 'own' : 'guest');
  app.mode = 'rewind';
  document.body.className = 'in-rewind';
  hideHud();
  stopListen(); stopNight();
  app.sel = null;
  const target = momentOf(person);
  const startT = app.moment.getTime();
  tween(app.vis, 'mwAmt', 1, 3000);
  const D = 4 * SIDEREAL_DAY_MS + ((((startT - target.getTime()) % SIDEREAL_DAY_MS) + SIDEREAL_DAY_MS) % SIDEREAL_DAY_MS);
  const years = Math.max(0, yearsBetween(target, new Date()));
  app.live = false;
  app.rewind = {
    t0: performance.now() + 700, person, own, then, target, startT,
    from: { lat: app.lat, lon: app.lon }, D, lastT: null, years,
  };
  moveCamera('dome', 2600);
  const v = app.vis;
  tween(v, 'lines', 0, 500); tween(v, 'labels', 0, 400); tween(v, 'names', 0, 400);
  tween(v, 'bodies', 0, 600); tween(v, 'ring', 0.5, 800);
  tween(v, 'crisp', 0.18, 1200, ease.inOut, 500);
  tween(v, 'dayMask', 0.14, 900);
  tween(v, 'terrainH', 0.028, 1500);
  v.trail.on = true; v.trail.clear = true; v.trail.opacity = 1; v.trail.fade = 0.955;
  $('#rw-date').textContent = fmtDateParts(zonedParts(new Date(startT), person.city.tz));
  $('#rw-sub').textContent = years >= 1 ? `回到 ${Math.floor(years)} 年前` : `回到 ${Math.max(1, Math.round(years * 365))} 天前`;
  show('#rewind', true);
  setTimeout(() => app.audio.rewind(REWIND_MS / 1000), 700);
  return new Promise((res) => { app.rewind.done = res; });
}

function fmtDateParts(z) {
  return `${z.y} . ${pad(z.m)} . ${pad(z.d)}`;
}

function stepRewind(now) {
  const r = app.rewind;
  const s = Math.max(0, Math.min(1, (now - r.t0) / REWIND_MS));
  const e = ease.inOut(s);
  const T = r.target.getTime() + (1 - e) * r.D;
  const lat = lerp(r.from.lat, r.person.city.lat, ease.inOutSine(s));
  const dLon = ((((r.person.city.lon - r.from.lon) % 360) + 540) % 360) - 180;
  const lon = r.from.lon + dLon * ease.inOutSine(s);
  // sub-steps keep the trails continuous while the sky spins fast
  const prevT = r.lastT ?? T;
  const spinDeg = Math.abs(prevT - T) / SIDEREAL_DAY_MS * 360;
  const n = Math.max(1, Math.min(18, Math.ceil(spinDeg / 0.6)));
  const Ms = [];
  for (let i = 1; i <= n; i++) Ms.push(skyMatrix(new Date(prevT + (T - prevT) * (i / n)), lat, lon));
  r.lastT = T;
  // light is deposited per degree the sky turns (not per second), so trails read equally well at any
  // spin speed or frame rate; the exponential fade keeps them from burning in near the pole
  const dt = Math.min(0.1, Math.max(0.004, (now - (r.lastNow ?? now - 16)) / 1000));
  r.lastNow = now;
  app.vis.trail.fade = Math.exp(-dt / 0.6);
  app.vis.trail.gain = 0.24 * Math.min(1, spinDeg / n / 0.6);
  app.vis.trail.Ms = Ms;
  app.vis.trail.clear = s === 0 && r.cleared !== true;
  if (s > 0) r.cleared = true;
  app.moment = new Date(T);
  app.lat = lat; app.lon = lon;
  app.skyDirty = true;
  const shown = new Date(r.startT - ease.inOut(Math.min(1, s * 1.08)) * (r.startT - r.target.getTime()));
  $('#rw-date').textContent = fmtDateParts(zonedParts(shown, r.person.city.tz));
  if (s > 0.72 && !r.named) {
    r.named = true;
    $('#rw-sub').textContent = `${r.person.city.name}${r.person.name ? ` · ${r.person.name}` : ''}`;
  }
  if (s >= 1) arrive();
}

async function arrive() {
  const r = app.rewind;
  app.rewind = null;
  const v = app.vis;
  app.moment = r.target;
  app.lat = r.person.city.lat; app.lon = r.person.city.lon;
  app.skyDirty = true;
  v.trail.on = false;
  app.audio.arrive();
  v.flash = 0.55;
  tween(v, 'flash', 0, 1600, ease.out);
  tween(v.trail, 'opacity', 0, 2600, ease.out).then(() => { v.trail.clear = true; });
  tween(v, 'crisp', 1, 1400, ease.out);
  tween(v, 'dayMask', 1, 2200, ease.inOut, 400);
  tween(v, 'bodies', 1, 1800, ease.inOut, 300);
  tween(v, 'ring', 1, 1500, ease.inOut, 200);
  v.linesProgress = 0;
  tween(v, 'lines', 1, 800, ease.inOut, 700);
  tween(v, 'linesProgress', 1, 4200, ease.inOut, 700);
  tween(v, 'labels', 1, 1600, ease.inOut, 2600);
  tween(v, 'names', 1, 1600, ease.inOut, 3000);
  show('#rewind', false);
  $('#arr-meta').textContent = `${fmtWhen(r.person, ' · ')} · ${r.person.city.name}`;
  $('#arr-line').textContent = r.own ? '这是你来的那晚' : `这是 ${r.person.name || 'TA'} 来的那晚`;
  show('#arrival', true);
  track('arrive', r.own ? 'own' : 'guest');
  enterSky(r.person, { own: r.own });
  await wait(3600);
  show('#arrival', false);
  showHud();
  r.done?.();
  if (r.then) { await wait(900); r.then(); }
}

// ------------------------------------------------------------------ the sky view
function enterSky(person, { own }) {
  app.mode = 'sky';
  app.viewing = person;
  app.own = own;
  app.birth = momentOf(person);
  app.sky = skyState(app.birth, person.city.lat, person.city.lon);
  app.facts = computeFacts(app.catalog, person, app.birth, app.sky);
  $('#h-eyebrow').textContent = own ? '你来的那晚' : `${person.name || 'TA'} 来的那晚`;
  $('#h-title').textContent = titleFor(person, own);
  $('#h-meta').textContent = `${fmtWhen(person)} · ${person.city.name}`;
  renderFactsPanel();
  resetScrub();
  const hud = $('#hud');
  hud.classList.toggle('is-guest', !own);
  if (!own) {
    $('#guest-text').innerHTML = `这是 <b>${escapeHtml(person.name || 'TA')}</b> 出生那晚的星空。<br>你出生的那晚，天上又是什么样子？`;
  }
  if (own) {
    setShareTarget(linkFor('person', person), `${titleFor(person, true)}｜${app.facts.visible} 颗星星在头顶`);
  } else {
    document.title = `${titleFor(person, false)}｜你来的那晚`;
  }
}

function renderFactsPanel() {
  const own = app.own;
  const items = renderFacts($('#facts-body'), app.facts, { subject: own ? '你' : 'TA', person: app.viewing, slotHtml: slotHtml('facts') });
  activateSlots($('#facts-body'));
  $('#facts-peek').innerHTML = factsPeek(app.facts);
  const mc = $('#facts-body canvas[data-moon]');
  if (mc) {
    const ctx = mc.getContext('2d');
    ctx.scale(2, 2);
    const angle = app.facts.moon.waxing ? 0 : Math.PI;
    drawMoon(ctx, 20, 20, 13, app.facts.moon.illum, angle, { glow: 0 });
  }
  $$('#facts-body .fact').forEach((el) => {
    const it = items[+el.dataset.k];
    el.addEventListener('click', () => {
      if (!it.target) return;
      toggleFacts(false);
      select(it.target, true);
    });
  });
}

function showHud() {
  show('#hud', true);
  if (!app.own) show('#guest-bar', true);
  document.body.className = 'in-hud';
  moveCamera('dome', 1200);
}
function hideHud() {
  show('#hud', false);
  show('#guest-bar', false);
  toggleFacts(false);
  hideCard();
}

function toggleFacts(open) {
  const f = $('#facts');
  const next = open ?? !f.classList.contains('is-open');
  f.classList.toggle('is-open', next);
  $('#facts-handle').setAttribute('aria-expanded', String(next));
}

// selection & star card
function select(sel, fly = false) {
  app.sel = sel;
  const d = describe(app.catalog, sel, app.sky, app.facts);
  if (!d) return hideCard();
  const card = $('#star-card');
  card.innerHTML = `<h3>${d.title}${d.sub ? `<small>${d.sub}</small>` : ''}</h3><p class="sc-meta">${escapeHtml(d.meta)}</p><p>${d.text}</p>`;
  card.classList.add('is-open');
  if (sel.type === 'star') {
    const pos = app.catalog.stars.pos, i = sel.index;
    const n = mul(app.sky.M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    const { alt } = altAz(n);
    const info = app.catalog.names.get(i);
    app.audio.star(Math.max(0, alt) / 90, info?.mag ?? 2, 0.6, 0, 0);
    if (fly && alt < 0) toast(`${info?.zh || '它'}那一刻在地平线以下`);
  } else {
    const b = app.sky.bodies.find((x) => x.id === sel.id);
    if (b) app.audio.body(b.id, Math.max(0, b.alt) / 90, 0);
    if (fly && b && b.alt < 0) toast(`${b.zh}那一刻在地平线以下`);
  }
}
function hideCard() {
  $('#star-card').classList.remove('is-open');
  app.sel = null;
}

// ------------------------------------------------------------------ time scrubber (the whole night)
const NIGHT_SPAN = 6 * 3600 * 1000;
function resetScrub() {
  $('#scrub').value = 500;
  $('#birth-mark').style.left = '50%';
  updateScrubLabel();
}
function scrubTo(v) {
  if (!app.birth) return;
  app.moment = new Date(app.birth.getTime() + ((v - 500) / 500) * NIGHT_SPAN);
  app.skyDirty = true;
  updateScrubLabel();
}
function updateScrubLabel() {
  if (!app.viewing) return;
  const z = zonedParts(app.moment, app.viewing.city.tz);
  $('#scrub-time').textContent = `${pad(z.hh)}:${pad(z.mm)}`;
}
function toggleNight() {
  if (app.night) return stopNight();
  if (+$('#scrub').value >= 995) $('#scrub').value = 0;
  app.night = { v: +$('#scrub').value };
  icon('#btn-night', 'pause');
  $('#btn-night').classList.add('is-on');
}
function stepNight(dt) {
  const n = app.night;
  n.v += dt * 42; // the whole 12-hour night in ~24 s
  if (n.v >= 1000) { n.v = 1000; stopNight(); }
  $('#scrub').value = n.v;
  scrubTo(n.v);
}
function stopNight() {
  if (!app.night) return;
  app.night = null;
  icon('#btn-night', 'play');
  $('#btn-night').classList.remove('is-on');
}

// ------------------------------------------------------------------ listen: the sky as a melody
const LISTEN_S = 36;
function toggleListen() {
  if (app.listen) return stopListen();
  if (app.camPreset !== 'dome' || app.cam.zoom > 1.01) moveCamera('dome', 900);
  stopNight();
  hideCard();
  const notes = [];
  const pos = app.catalog.stars.pos, mag = app.catalog.stars.mag;
  const n = [0, 0, 0];
  for (const [i, info] of app.catalog.names) {
    if (mag[i] > 3.4) break;
    mul(app.sky.M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], n);
    if (n[2] < 0.03) continue;
    notes.push({ kind: 'star', i, az: Math.atan2(n[1], n[0]), alt01: Math.asin(n[2]) / (Math.PI / 2), mag: mag[i], bv: 0.6, done: false });
  }
  for (const b of app.sky.bodies) {
    if (b.alt <= 0 || b.id === 'Sun') continue;
    notes.push({ kind: 'body', id: b.id, az: Math.atan2(b.n[1], b.n[0]), alt01: b.alt / 90, done: false });
  }
  const start = Math.PI; // start from the north... sweeping clockwise on screen (decreasing azimuth)
  app.listen = { t0: performance.now() + 500, start, notes, last: start };
  app.vis.sweep = start;
  tween(app.vis, 'sweepOn', 1, 700);
  app.audio.duck(true);
  $('#btn-listen').classList.add('is-on');
  icon('#btn-listen .ico', 'stop');
  $('#btn-listen span').textContent = '停止';
  track('listen');
}
function stepListen(now) {
  const L = app.listen;
  const s = (now - L.t0) / (LISTEN_S * 1000);
  if (s < 0) return;
  if (s >= 1) return stopListen();
  const sweep = L.start - s * Math.PI * 2;
  app.vis.sweep = sweep;
  const a0 = L.last, a1 = sweep;
  const grid = 0.15;
  for (const nt of L.notes) {
    if (nt.done) continue;
    // passed when the (decreasing) sweep crosses the note's azimuth
    const rel0 = mod(a0 - nt.az), rel1 = mod(a1 - nt.az);
    if (rel1 > rel0 || rel0 < 0.0001) {
      nt.done = true;
      const t = app.audio.now();
      const when = Math.ceil(t / grid) * grid;
      let p;
      if (nt.kind === 'star') {
        const pos = app.catalog.stars.pos;
        const v = mul(app.sky.M, [pos[nt.i * 3], pos[nt.i * 3 + 1], pos[nt.i * 3 + 2]]);
        p = app.cam.project(v, {});
        app.audio.star(nt.alt01, nt.mag, nt.bv, p ? (p.x / app.w) * 1.6 - 0.8 : 0, when);
      } else {
        const b = app.sky.bodies.find((x) => x.id === nt.id);
        p = b && app.cam.project(b.n, {});
        app.audio.body(nt.id, nt.alt01, when);
      }
      if (p) app.overlay.addRipple(p.x, p.y, undefined, nt.kind === 'body' ? 1.6 : Math.max(0.6, 1.4 - nt.mag * 0.25));
    }
  }
  L.last = sweep;
}
function mod(a) { const t = Math.PI * 2; return ((a % t) + t) % t; }
function stopListen() {
  if (!app.listen) return;
  app.listen = null;
  tween(app.vis, 'sweepOn', 0, 900);
  app.audio.duck(false);
  $('#btn-listen').classList.remove('is-on');
  icon('#btn-listen .ico', 'listen');
  $('#btn-listen span').textContent = '聆听星空';
}

// ------------------------------------------------------------------ view toggle & gyro
async function toggleView() {
  const toHorizon = app.camPreset !== 'horizon';
  stopListen();
  if (toHorizon) {
    moveCamera('horizon', 1800);
    tween(app.vis, 'terrainH', 0.05, 1800);
    $('#btn-view').classList.add('is-on');
    icon('#btn-view', 'dome');
    if (isMobile && 'DeviceOrientationEvent' in window) await enableGyro();
  } else {
    disableGyro();
    moveCamera('dome', 1800);
    tween(app.vis, 'terrainH', 0.028, 1800);
    $('#btn-view').classList.remove('is-on');
    icon('#btn-view', 'eye');
  }
}

async function enableGyro() {
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return;
    }
  } catch { return; }
  if (!app.gyro) {
    app.gyro = { on: false, target: null };
    window.addEventListener('deviceorientation', (e) => {
      if (!app.gyro.on || e.beta == null) return;
      const heading = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : (e.absolute && e.alpha != null ? 360 - e.alpha : null);
      if (heading == null) return;
      const orient = (screen.orientation?.angle ?? window.orientation ?? 0);
      const alt = Math.max(4, Math.min(89, e.beta - 90));
      app.gyro.target = { az: (heading + orient + 360) % 360, alt };
      if (!app.gyro.announced) { app.gyro.announced = true; toast('举起手机，转动看看那晚的天空'); }
    }, true);
  }
  app.gyro.on = true;
}
function disableGyro() {
  if (app.gyro) { app.gyro.on = false; app.gyro.target = null; }
}

// ------------------------------------------------------------------ gestures
function bindGestures() {
  const el = $('#overlay');
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture?.(e.pointerId);
    app.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cam = app.cam;
    if (app.pointers.size === 1) {
      app.drag = { x: e.clientX, y: e.clientY, t: performance.now(), az: cam.az, alt: cam.alt, moved: false, lx: e.clientX, ly: e.clientY, lt: performance.now() };
      app.vel.az = app.vel.alt = 0;
    } else if (app.pointers.size === 2) {
      const [a, b] = [...app.pointers.values()];
      app.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom };
      if (app.drag) app.drag.moved = true;
    }
    if (app.gyro?.on) disableGyro();
  });
  el.addEventListener('pointermove', (e) => {
    if (!app.pointers.has(e.pointerId)) return;
    app.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cam = app.cam;
    if (app.pointers.size >= 2 && app.pinch) {
      const [a, b] = [...app.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.zoom = Math.max(0.85, Math.min(7, app.pinch.zoom * d / app.pinch.d));
      return;
    }
    const g = app.drag;
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (Math.hypot(dx, dy) > 6) g.moved = true;
    if (!g.moved || app.mode === 'rewind') return;
    const k = 57.3 / (cam.domeR * 0.5 * cam.zoom) * 0.5;
    cam.az = g.az - dx * k * (cam.alt > 60 ? -1 : 1) * (cam.alt > 60 ? (e.clientY > cam.cy ? -1 : 1) : 1);
    cam.alt = Math.max(6, Math.min(90, g.alt + dy * k));
    const now = performance.now(), dtm = Math.max(1, now - g.lt);
    app.vel.az = ((cam.az - (g.prevAz ?? cam.az)) / dtm) * 1000;
    app.vel.alt = ((cam.alt - (g.prevAlt ?? cam.alt)) / dtm) * 1000;
    g.prevAz = cam.az; g.prevAlt = cam.alt; g.lt = now;
    if (app.camPreset === 'dome' && cam.alt < 88) app.camPreset = 'free';
  });
  const end = (e) => {
    const g = app.drag;
    app.pointers.delete(e.pointerId);
    if (app.pointers.size < 2) app.pinch = null;
    if (app.pointers.size > 0) return;
    app.drag = null;
    if (!g) return;
    if (performance.now() - g.lt > 80) app.vel.az = app.vel.alt = 0;
    if (!g.moved && performance.now() - g.t < 400) onTap(e.clientX, e.clientY);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    app.cam.zoom = Math.max(0.85, Math.min(7, app.cam.zoom * Math.exp(-e.deltaY * 0.0015)));
  }, { passive: false });
}

function onTap(x, y) {
  const now = performance.now();
  const last = app.lastTap;
  app.lastTap = { x, y, t: now };
  if (last && now - last.t < 320 && Math.hypot(last.x - x, last.y - y) < 30) {
    app.lastTap = null;
    hideCard();
    if (app.mode === 'sky') {
      disableGyro();
      $('#btn-view').classList.remove('is-on'); icon('#btn-view', 'eye');
      tween(app.vis, 'terrainH', 0.028, 900);
      moveCamera('dome', 900);
    }
    return;
  }
  if (app.mode !== 'sky') return;
  if ($('#facts').classList.contains('is-open')) return toggleFacts(false);
  const hit = app.overlay.pick({ cam: app.cam, M: app.sky.M, sky: app.sky }, x, y);
  if (hit) select(hit);
  else hideCard();
}

// ------------------------------------------------------------------ poster
let posterStyle = 'night';
async function openPoster(kind = 'single') {
  stopListen();
  const modal = $('#poster');
  const p = app.viewing;
  app.posterKind = kind;
  $('#p-title').value = kind === 'hepan' ? app.hepanView.defaultTitle() : titleFor(p, app.own);
  $('#p-line').value = kind === 'hepan' ? app.hepanView.defaultLine() : `那一刻，${app.facts.visible.toLocaleString('en-US')} 颗星星在头顶亮着`;
  $('#poster-styles').innerHTML = POSTER_STYLES.map((s) => `<button role="radio" data-style="${s.id}" aria-checked="${s.id === posterStyle}"><i style="background:${s.swatch}"></i>${s.name}</button>`).join('');
  $('#poster-tip').textContent = isWeChat ? '长按图片保存，发到朋友圈' : '保存图片，分享给朋友';
  $('#btn-save').hidden = isWeChat;
  show(modal, true);
  track('poster', kind);
  await renderPoster();
}

let posterJob = 0;
async function renderPoster() {
  const job = ++posterJob;
  const img = $('#poster-img');
  img.classList.remove('is-ready');
  $('#poster-loading').classList.remove('is-done');
  await wait(60);
  const texts = { title: $('#p-title').value.trim(), line: $('#p-line').value.trim() };
  let canvas;
  if (app.posterKind === 'hepan') {
    canvas = await app.posters.hepan(app.hepanView.result, { style: posterStyle, texts, url: app.hepanView.link() });
  } else {
    const p = app.viewing;
    canvas = await app.posters.single({ person: p, sky: skyState(app.birth, p.city.lat, p.city.lon), facts: app.facts,
      style: posterStyle, texts, url: linkFor('invite', p), culture: app.overlay.culture });
  }
  if (job !== posterJob) return;
  app.posterCanvas = canvas;
  img.onload = () => { img.classList.add('is-ready'); $('#poster-loading').classList.add('is-done'); };
  img.src = canvas.toDataURL('image/jpeg', 0.92);
}

async function savePoster() {
  const c = app.posterCanvas;
  if (!c) return;
  const name = `你来的那晚-${app.viewing?.date || 'sky'}.jpg`;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.94));
  if (!blob) return;
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (isMobile && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '你来的那晚' }); track('poster_share'); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('海报已保存');
  track('poster_save');
}

// ------------------------------------------------------------------ 合盘
function openHepan() {
  stopListen();
  if (!app.own) {
    // viewing a friend's sky: 合盘 them with me
    if (app.me) return showHepan(app.me, app.viewing);
    app.link = { kind: 'invite', a: app.viewing };
    hideHud();
    return openForm('hepan-self');
  }
  show('#hepan-invite', true);
}

function showHepan(a, b, opts = {}) {
  hideHud();
  closeForm();
  app.mode = 'hepan';
  document.body.className = 'in-hepan';
  const result = computeHepan(app.catalog, a, b, momentOf);
  track('hepan', opts.fromLink ? 'link' : 'new');
  app.hepanView.show(result, opts);
  setShareTarget(linkFor('result', a, b), `${a.name || '我'}和${b.name || 'TA'}的星空合盘：重合度 ${result.score}%`);
}

function leaveHepan() {
  app.hepanView.hide();
  if (app.viewing && app.birth) {
    app.mode = 'sky';
    setPlace(app.viewing);
    enterSky(app.viewing, { own: app.own });
    showHud();
  } else if (app.me) {
    rewindTo(app.me, { own: true });
  } else {
    openForm('self');
  }
}

// exposed for hepan.js
app.api = {
  tween, moveCamera, showHud, hideHud, openPoster, leaveHepan, rewindTo, openForm, setPlace, enterSky, momentOf,
  shareResult: (a, b, result) => shareLink({
    url: linkFor('result', a, b),
    title: `${a.name || '我'}和${b.name || 'TA'}的星空合盘：重合度 ${result.score}%`,
    text: '我们出生那晚，有这么多颗星同时亮着',
    guide: '点击右上角 <b>···</b><br>把合盘结果发给 TA',
  }),
  inviteOthers: (a) => shareLink({
    url: linkFor('invite', a),
    title: `${a.name || '我'}邀请你来星空合盘｜你来的那晚`,
    text: '我们出生那晚，有多少颗星同时照着我们？',
    guide: '点击右上角 <b>···</b><br>邀请朋友来合盘',
  }),
  mySky: () => {
    app.hepanView.hide();
    if (app.me) rewindTo(app.me, { own: true });
    else { app.link = { kind: null }; openForm('self'); }
  },
};

// ------------------------------------------------------------------ events
function bindEvents() {
  bindGestures();
  $('#btn-start').addEventListener('click', onStart);
  $('#btn-go').addEventListener('click', submitForm);
  $('#f-unknown').addEventListener('change', syncUnknown);
  const city = $('#f-city');
  city.addEventListener('focus', () => { city.select?.(); if (!app.cities?.citiesReady()) toast('城市列表加载中…'); });
  city.addEventListener('input', () => { formCity = null; renderSuggest(city.value); });
  city.addEventListener('keydown', (e) => {
    const items = $$('#f-suggest li[data-i]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggestHl = Math.max(0, Math.min(items.length - 1, suggestHl + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((li, i) => li.classList.toggle('is-hl', i === suggestHl));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestHl >= 0) pickSuggest(suggestHl);
    }
  });
  city.addEventListener('blur', () => setTimeout(() => $('#f-suggest').classList.remove('is-open'), 180));
  $('#f-suggest').addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); pickSuggest(+li.dataset.i); }
  });

  $('#btn-sound').addEventListener('click', () => {
    app.muted = !app.muted;
    store.set('muted', app.muted);
    if (!app.muted) app.audio.start();
    app.audio.setMuted(app.muted);
    icon('#btn-sound', app.muted ? 'soundOff' : 'soundOn');
    $('#btn-sound').classList.toggle('is-on', !app.muted);
  });
  $('#btn-culture').addEventListener('click', () => {
    const cn = app.overlay.culture !== 'cn';
    app.overlay.culture = cn ? 'cn' : 'iau';
    $('#btn-culture span').textContent = cn ? '星座' : '星官';
    $('#btn-culture').classList.toggle('is-on', cn);
    app.vis.linesProgress = 0;
    tween(app.vis, 'linesProgress', 1, 2200, ease.inOut);
    toast(cn ? '中国古代星官 · 三垣二十八宿' : '国际通用 88 星座');
  });
  $('#btn-view').addEventListener('click', toggleView);
  $('#btn-night').addEventListener('click', toggleNight);
  $('#scrub').addEventListener('input', (e) => { stopNight(); scrubTo(+e.target.value); });
  $('#scrub-time').addEventListener('click', () => { stopNight(); resetScrub(); scrubTo(500); });
  $('#facts-handle').addEventListener('click', () => toggleFacts());
  $('#btn-listen').addEventListener('click', toggleListen);
  $('#btn-poster').addEventListener('click', () => openPoster('single'));
  $('#btn-hepan').addEventListener('click', openHepan);
  $('#btn-share').addEventListener('click', () => {
    const p = app.viewing;
    track('share', app.own ? 'own' : 'guest');
    shareLink({
      url: linkFor('person', p),
      title: `${titleFor(p, app.own)}｜你来的那晚`,
      text: '看看你出生那晚，天上是什么样子',
      guide: '点击右上角 <b>···</b><br>发送给朋友，或分享到朋友圈',
    });
  });
  $('#btn-guest-mine').addEventListener('click', () => {
    hideHud();
    app.link = { kind: null };
    if (app.me) rewindTo(app.me, { own: true });
    else openForm('self');
  });
  $('#btn-guest-hepan').addEventListener('click', openHepan);
  $('#btn-invite').addEventListener('click', () => {
    show('#hepan-invite', false);
    track('invite');
    app.api.inviteOthers(app.viewing);
  });
  $('#btn-manual').addEventListener('click', () => {
    show('#hepan-invite', false);
    hideHud();
    openForm('partner');
  });
  $('#btn-hp-back').addEventListener('click', leaveHepan);

  $('#poster-styles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]');
    if (!b) return;
    posterStyle = b.dataset.style;
    $$('#poster-styles [data-style]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    renderPoster();
  });
  let tt = 0;
  for (const id of ['#p-title', '#p-line']) $(id).addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(renderPoster, 450); });
  $('#btn-save').addEventListener('click', savePoster);
  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) {
        show(m, false);
        // closing the form-less 合盘 invite from a finished 合盘 should not strand the user
        if (m.id === 'about' && app.mode === 'intro') show('#intro', true);
      }
    });
  });
  $('#btn-about').addEventListener('click', openAbout);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal.is-active').forEach((m) => show(m, false));
  });
}

function openAbout() {
  $('#about-body').innerHTML = `
    <p>「你来的那晚」按照真实的天文数据，重现你出生那一刻、在你出生的城市，头顶的星空。</p>
    <h4>隐私</h4>
    <p>所有计算都在你的手机上完成。我们没有服务器，不收集、不上传你的生日。你分享的链接里会带上你填写的日期、时间、城市和名字，只有收到链接的人能看到。</p>
    <h4>数据与致谢</h4>
    <p>恒星：HYG Database v4.1（CC BY-SA 4.0，astronexus）<br>星座连线、中文星名、银河轮廓：d3-celestial（BSD，Olaf Frohn），银河轮廓源自 J. R. Vieira，中国星官源自 Stellarium skycultures<br>日月行星：Astronomy Engine（MIT，Don Cross）<br>城市：GeoNames（CC BY 4.0）<br>音乐：浏览器实时合成，无版权素材。</p>
    <h4>精度</h4>
    <p>日月行星位置误差小于 1 角分；恒星位置为 J2000 历元并计入岁差。星星的大小与颜色经过艺术化处理。</p>`;
  show('#about', true);
}

window.addEventListener('resize', () => layout());
window.addEventListener('orientationchange', () => setTimeout(layout, 250));
boot();

// debugging hook for QA in the browser pane
window.__birthsky = app;
