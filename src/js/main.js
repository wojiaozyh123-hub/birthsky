// 你来的那晚 — the app controller (spec §4, S1–S21). Boot, the frame loop, and the flows between scenes:
// intro → form → rewind → arrival → the night (tour, name strip, 那一夜, ruler, listen) → 留存 / 两个人 / 送一张 / 分享.
// Every module does its own job; this file only wires them together:
//   camera.js + motion.js  the view (Camera, ViewRig)       renderer.js + overlay.js  the sky (WebGL + 2D)
//   chrome.js              the words on the stage          form.js / ruler.js / listen.js / gestures.js / gyro.js
//   keep.js                留存 and 送一张 (viewfinder, export, print order)      pair.js  两个人
import { loadCatalog, mwAt } from './catalog.js';
import { SkyRenderer } from './renderer.js';
import { Overlay } from './overlay.js';
import { Camera, standView, rewindView, altForHorizonAt, angDiff, ease } from './camera.js';
import { ViewRig, GLIDE, LOOK } from './motion.js';
import { Cosmos } from './audio.js';
import { skyState, skyMatrix, zonedToUtc, zonedParts, mul, DEG, SIDEREAL_DAY_MS } from './astro.js';
import {
  computeFacts, chooseHero, buildTour, nightRows, nightNote, describe, tagsFor,
} from './facts.js';
import { T, fmtTime, fmtWhen, nameOr, cjk } from './copy.js';
import { $, toast, hint, markHint, clearHint } from './ui.js';
import { parseLink, shareLink, setShareTarget, shareFor, isWeChat } from './share.js';
import { initAnalytics, track } from './monetize.js';
import { poemForPerson, poemSeed, attribution } from './poems.js';
import { recordPoem, countLine, statsEnabled } from './poemstats.js';
import { Chrome } from './chrome.js';
import { Form } from './form.js';
import { Ruler } from './ruler.js';
import { Listen } from './listen.js';
import { Gestures } from './gestures.js';
import { Gyro } from './gyro.js';
import { Keep } from './keep.js';
import { Pair } from './pair.js';
import { ICON } from './icons.js';
import { CONFIG } from './config.js';

const BG = [3 / 255, 4 / 255, 7 / 255];
// eslint-disable-next-line no-undef
const DATA_V = typeof __DATA_VERSION__ !== 'undefined' ? __DATA_VERSION__ : String(Date.now());
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`birthsky:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`birthsky:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const B_REWIND = ease.bezier(0.55, 0, 0.12, 1);
const SKYLIKE = new Set(['sky', 'listen', 'pair', 'arrive']);

export const app = {
  catalog: null, renderer: null, overlay: null, cam: new Camera(), rig: null, audio: new Cosmos(),
  chrome: null, form: null, ruler: null, listen: null, gestures: null, gyro: null, keep: null, pair: null,
  mode: 'intro', link: { kind: null }, me: store.get('me'),
  viewing: null, own: true, birth: null, subject: '你', receiverFrom: '',
  moment: new Date(), lat: 39.9, lon: 116.4, live: true, introOffset: 0, introAz: 160,
  sky: null, skyDirty: true, facts: null, hero: null, tour: [], tourI: 0, sel: null, hover: null,
  poemStep: 0, poemCount: null,
  muted: store.get('muted') === true, culture: store.get('culture') || 'cn',
  paused: false, rewind: null, arrival: null, widened: null,
  lines: { mode: 'off', focusIds: [], selId: null, origin: null, labels: true },
  reticle: null, heroTag: null, marker: null, pairView: null,
  settledAt: 0, needRest: false,
  vis: {
    reveal: -2, mwAmt: 0, starGain: 1, dustGain: 1, crisp: 1, exposure: 1, terrainH: 0.05, dayMask: 1, bodies: 1,
    sunAlpha: 1, listenOn: 0, sharedDim: 1, sharedT: 0, horizon: 0, compass: 0,
    trail: { on: false, fade: 0.95, opacity: 0, Ms: [], clear: false, gain: 0.24 },
  },
};
window.__birthsky = app; // dev / QA hook

// ------------------------------------------------------------------ scalar tweens (app.vis and friends)
const tweens = [];
function tween(obj, key, to, dur, fn = ease.fade, delay = 0) {
  for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].obj === obj && tweens[i].key === key) tweens.splice(i, 1);
  return new Promise((res) => tweens.push({ obj, key, to, dur, fn, start: performance.now() + delay, from: null, res }));
}
function runTweens(now) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (now < tw.start) continue;
    if (tw.from === null) tw.from = tw.obj[tw.key];
    const t = tw.dur <= 0 ? 1 : Math.min(1, (now - tw.start) / tw.dur);
    tw.obj[tw.key] = tw.from + (tw.to - tw.from) * tw.fn(t);
    if (t >= 1) { tweens.splice(i, 1); tw.res(); }
  }
}
app.tween = tween;
app.reduced = reduced;
app.wait = wait;
app.store = store;

// ------------------------------------------------------------------ people, places, modes
export function momentOf(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm] = (p.unknownTime ? '22:00' : p.time || '22:00').split(':').map(Number);
  return zonedToUtc(y, m, d, hh, mm, p.city.tz);
}
app.momentOf = momentOf;

function samePerson(a, b) {
  return !!a && !!b && a.date === b.date && a.time === b.time && a.city?.name === b.city?.name
    && Math.abs(a.city.lat - b.city.lat) < 1e-3 && Math.abs(a.city.lon - b.city.lon) < 1e-3;
}
app.samePerson = samePerson;

function setPlace(p, at = null) {
  app.live = false;
  app.moment = at || momentOf(p);
  app.lat = p.city.lat; app.lon = p.city.lon;
  app.skyDirty = true;
  app.sky = skyState(app.moment, app.lat, app.lon);
}
app.setPlace = setPlace;

function setMode(mode) {
  app.mode = mode;
  const scene = mode === 'arrive' ? 'rewind' : mode === 'gift' ? 'sky' : mode;
  app.chrome.scene(scene);
}
app.setMode = setMode;

const W = () => app.chrome.W;
const H = () => app.chrome.H;

// ------------------------------------------------------------------ framings
function introView() {
  const fov = W() >= 960 ? 60 : 70;
  const hfov = 2 * Math.atan(Math.tan((fov / 2) * DEG) * (W() / H())) / DEG;
  // the brightest Milky Way stretch sits at x = 0.38W: the view centre is a little to its right
  return { az: app.introAz + 0.12 * hfov, alt: altForHorizonAt(0.82, fov), fov };
}
function formView() {
  return { az: app.lat >= 0 ? 0 : 180, alt: -6.6, fov: 72 };
}
function stand(az, heroAlt) { return standView(az, W(), H(), heroAlt); }

/** Put a direction at (0.5W, 0.40H), never lifting the horizon above the stand framing. */
function viewFor(n, fov = app.cam.fov) {
  const alt = Math.asin(clamp(n[2], -1, 1)) / DEG;
  const az = Math.atan2(n[1], n[0]) / DEG;
  const base = stand(az).alt;
  const lift = Math.atan(0.2 * Math.tan((fov / 2) * DEG)) / DEG;
  return { az, alt: clamp(alt - lift, base, 82), fov };
}
function lookAt(n, profile = LOOK) {
  if (!n) return Promise.resolve(false);
  app.needRest = true;
  return app.rig.setTarget(viewFor(n, app.rig.target?.fov || app.cam.fov), profile);
}
app.lookAt = lookAt;
app.viewFor = viewFor;

// ------------------------------------------------------------------ boot
async function boot() {
  const chrome = app.chrome = new Chrome(app);
  app.cam.setSize(chrome.W, chrome.H);
  app.rig = new ViewRig(app.cam);
  app.form = new Form(app);
  app.ruler = new Ruler(app);
  app.listen = new Listen(app);
  app.gyro = new Gyro(app);
  app.citiesUrl = `data/cities.json?v=${DATA_V}`;
  app.link = parseLink();
  initAnalytics();
  bindChrome();
  setupIcons();
  setupTip();
  // a focused field may pan the page (keyboard / scrollIntoView); the stage is fixed, so always settle back
  document.addEventListener('focusout', () => setTimeout(() => {
    const t = (document.activeElement?.tagName || '').toLowerCase();
    if (t === 'input' || t === 'textarea') return;
    if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
    const a = document.getElementById('app');
    if (a && (a.scrollTop || a.scrollLeft)) { a.scrollTop = 0; a.scrollLeft = 0; }
  }, 60));
  chrome.toggles({ culture: app.culture, sound: !app.muted, gyro: app.gyro.available ? false : null });
  introCopy();

  try {
    app.catalog = await loadCatalog('data/', `?v=${DATA_V}`, (p) => chrome.introProgress(Math.min(0.96, p)));
  } catch (e) {
    console.error(e);
    chrome.introFailed();
    return;
  }
  try {
    app.renderer = new SkyRenderer($('#sky'), app.catalog);
  } catch (e) {
    console.error(e);
    chrome.fallback('webgl');
    return;
  }
  app.overlay = new Overlay($('#overlay'), app.catalog);
  app.overlay.setCulture(app.culture);
  app.gestures = new Gestures(app, $('#overlay'));
  app.keep = new Keep(app);
  app.pair = new Pair(app);
  layout();
  chrome.on('layout', layout);

  // the opening sky: today, at the hour the Milky Way stands best over the (guessed) home city
  try {
    const m = await Promise.race([import('./cities.js'), wait(1500).then(() => null)]);
    if (m) {
      app.cities = m;
      await Promise.race([m.loadCities(app.citiesUrl), wait(1200)]);
      const home = m.citiesReady?.() ? m.guessHomeCity() : null;
      if (home) { app.lat = home.lat; app.lon = home.lon; }
    }
  } catch (e) { console.warn('cities', e); }
  faceMilkyWay();
  app.rig.set(introView());
  app.sky = skyState(app.moment, app.lat, app.lon);
  requestAnimationFrame(frame);
  tween(app.vis, 'reveal', 6.6, 5200, ease.out, 100);
  tween(app.vis, 'mwAmt', 1, 6000, ease.inOut, 300);
  chrome.introProgress(1);
  const printCode = new URLSearchParams(location.search).get('print');
  if (printCode) { setMode('result'); app.keep.printPage(printCode); return; }
  chrome.introReady(app.introLabel);
  if (app.link.kind === 'gift') document.title = T.gift.docTitle(app.link.from);
}

function introCopy() {
  const L = app.link, me = app.me;
  let lede = T.intro.lede, label = T.intro.start, secondary = null;
  if (L.kind === 'person') { lede = T.link.person(L.a); label = T.link.personGo; }
  else if (L.kind === 'gift') { lede = T.gift.receiverLede(L.from, L.a); label = T.gift.receiverGo; }
  else if (L.kind === 'invite') { lede = T.link.invite(L.a); label = me ? T.link.inviteUse : T.link.inviteFill; secondary = me ? T.link.inviteOther : null; }
  else if (L.kind === 'result') { lede = T.link.result(L.a, L.b); label = T.link.resultGo; }
  app.introLabel = label;
  app.introLede = lede;
  app.introSecondary = secondary;
  const h = document.getElementById('intro-hint');
  if (h) h.textContent = T.intro.hint;
  app.chrome.intro({ lede, secondary });
}

function faceMilkyWay() {
  // The opening sky is scenery, not a claim about "now": the hour today when the Milky Way stands most
  // gloriously over the viewer's city, facing its brightest stretch.
  const now = Date.now();
  let best = { score: -1, h: 0, az: 160 };
  for (let h = 0; h < 24; h++) {
    const M = skyMatrix(new Date(now + h * 3600e3), app.lat, app.lon);
    const Mt = [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
    for (let az = 0; az < 360; az += 12) {
      let L = 0;
      for (const alt of [14, 24, 34, 44]) {
        const n = [Math.cos(alt * DEG) * Math.cos(az * DEG), Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG)];
        const e = mul(Mt, n);
        L += mwAt(app.catalog.mwLum, Math.atan2(e[1], e[0]) / DEG, Math.asin(e[2]) / DEG) * (alt < 20 ? 0.7 : 1);
      }
      if (L > best.score) best = { score: L, h, az };
    }
  }
  app.introOffset = best.h * 3600e3;
  app.moment = new Date(now + app.introOffset);
  app.skyDirty = true;
  app.introAz = best.az;
}

function layout() {
  const w = app.chrome.W, h = app.chrome.H;
  app.dpr = Math.min(window.devicePixelRatio || 1, app.lowPower ? 1.5 : 3);
  app.cam.setSize(w, h);
  app.renderer?.resize(w, h, app.dpr);
  app.overlay?.resize(w, h, app.dpr);
  app.keep?.layout();
  app.overlay?.setUIRects(app.chrome.uiRects());
}

// ------------------------------------------------------------------ frame loop
let lastT = 0, skyStamp = 0, perf = null;
function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  const dt = Math.min(0.05, Math.max(0.001, t - lastT || 0.016));
  lastT = t;
  runTweens(now);
  if (app.paused) return;
  probeQuality(dt, now);

  const { rig, cam, gestures } = app;
  if (app.mode === 'intro' && !gestures.down && rig.settled()) {
    // the intro breathes: ±5° over 60 s
    const v = introView();
    rig.follow({ az: app.introBase ?? v.az + 5 * Math.sin((now / 60000) * 2 * Math.PI) });
  }
  app.gyro.on && app.gyro.step(now);
  rig.step(dt);
  if (!Number.isFinite(cam.az) || !Number.isFinite(cam.alt) || !Number.isFinite(cam.fov)) {
    console.warn('view reset', cam.az, cam.alt, cam.fov);
    rig.set(app.mode === 'intro' ? introView() : stand(Number.isFinite(cam.az) ? cam.az : 180));
  }
  gestures.frame(now);
  app.listen.step(dt, now);
  if (app.ruler.isOpen) app.ruler.step(dt);
  if (app.rewind?.t0) stepRewind(now);
  else if (app.live && now - skyStamp > 1000) { app.moment = new Date(Date.now() + app.introOffset); skyStamp = now; app.skyDirty = true; }
  if (app.skyDirty || !app.sky) { app.sky = skyState(app.moment, app.lat, app.lon); app.skyDirty = false; }

  lookUpWiden();
  restRule(now);
  app.chrome.frame({ dt, settled: rig.settled(), cam });
  app.renderer.render(glState(t));
  if (app.rewind && app.rewind.t0) {
    if (!app.rewind.cleared) { app.overlay.clear(); app.rewind.cleared = true; }
  } else {
    app.overlay.draw(ovState(now));
  }
}

function glState(t) {
  const sky = app.sky, v = app.vis, cam = app.cam;
  const sunAlt = sky.sun.alt;
  return {
    cam, M: sky.M, time: t, sun: sky.sun.n, moon: sky.moon.n,
    moonIllum: sky.moonPhase.illum * (sky.moon.alt > -2 ? 1 : 0) * v.bodies,
    twilight: smooth(-18, -2, sunAlt) * 0.92 * v.dayMask, day: smooth(-3, 10, sunAlt) * 0.6 * v.dayMask,
    reveal: v.reveal, mwAmt: v.mwAmt, starGain: v.starGain, dustGain: v.dustGain,
    sizeGain: clamp(Math.pow(72 / cam.fov, 0.1), 0.92, 1.15),
    crisp: v.crisp, sel: app.sel?.type === 'star' ? app.sel.index : -1, twinkle: 1, terrainH: v.terrainH,
    bg: BG, exposure: v.exposure, dither: 0.004, vignette: 0.12,
    listenAz: cam.az, listenOn: v.listenOn,
    zB: app.pairView?.zB || null, sharedDim: app.pairView ? v.sharedDim : 1, sharedT: app.pairView ? v.sharedT : 0,
    trail: v.trail,
  };
}

function ovState(now) {
  const v = app.vis, sky = app.sky;
  const tags = app.mode === 'sky' || app.mode === 'pair' ? [...(app.heroTag ? [app.heroTag] : []), ...app.chrome.tags] : [];
  const pv = app.pairView;
  return {
    cam: app.cam, M: sky.M, sky, terrainH: v.terrainH, now, dragging: app.gestures.dragging,
    lines: app.mode === 'listen' && !app.gestures.dragging ? { mode: 'off' } : app.lines,
    reticle: app.reticle, tags, marker: app.marker,
    horizonLine: pv && !pv.nearlySame ? { zB: pv.zB, label: pv.label, progress: v.horizon } : null,
    compass: v.compass, bodies: v.bodies, sunAlpha: v.sunAlpha * v.dayMask, bodyDim: pv?.bodyDim || null,
    hover: app.hover,
  };
}

function probeQuality(dt, now) {
  // spec D-15: judge the device only while the intro plays (median of 90 frames after 1.2 s)
  if (app.mode !== 'intro' || app.lowPower !== undefined && perf?.done) return;
  perf = perf || { f: [], t0: now };
  if (now - perf.t0 < 1200 || document.hidden) return;
  perf.f.push(dt);
  if (perf.f.length < 90) return;
  const median = perf.f.sort((a, b) => a - b)[45];
  perf.done = true;
  if (median > 1 / 40) { app.lowPower = true; layout(); }
}

function lookUpWiden() {
  if (!SKYLIKE.has(app.mode) || app.mode === 'arrive') return;
  const cam = app.cam, tgt = app.rig.target || cam;
  if (!app.widened && cam.alt > 72 && (tgt.fov ?? cam.fov) >= 60 && (tgt.fov ?? cam.fov) < 99) {
    app.widened = { fov: tgt.fov ?? cam.fov };
    app.rig.setTarget({ fov: 100 }, GLIDE);
    hint('zenith', T.hint.zenith);
  } else if (app.widened && cam.alt < 66) {
    app.rig.setTarget({ fov: app.widened.fov }, GLIDE);
    app.widened = null;
  }
}

/** Rest rule: once the view has been still for 1.2 s, the two nearest asterisms grow in (no names). */
function restRule(now) {
  if (!(app.mode === 'sky' || app.mode === 'pair') || app.gestures.down) { app.settledAt = 0; return; }
  if (!app.rig.settled()) { app.settledAt = 0; return; }
  if (!app.settledAt) { app.settledAt = now; return; }
  if (!app.needRest || now - app.settledAt < 1200) return;
  app.needRest = false;
  const keep = app.lines.focusIds || [];
  const focus = app.overlay.focusAsterisms(app.cam, app.sky.M, 2, 22, { keep, keepDeg: 30 });
  app.lines = { mode: 'focus', focusIds: focus, selId: app.lines.selId, origin: null, labels: false };
}

// ------------------------------------------------------------------ gesture hooks (gestures.js asks these)
app.canTouch = () => !(app.rewind && app.rewind.t0) && !['form', 'result', 'pair-invite'].includes(app.mode) && !app.chrome.plateOpen && !app.paused;
app.canLook = () => ['intro', 'sky', 'listen', 'pair', 'keep', 'arrive', 'gift'].includes(app.mode);
app.onPointerDown = () => {
  app.chrome.pointerDown();
  if (app.mode === 'intro') app.introBase = null;
};
app.onDragStart = () => {
  app.chrome.dragStart();
  app.chrome.touched();
  if (app.mode !== 'listen') app.lines = { ...app.lines, mode: 'drag' };
  app.needRest = true;
  app.hover = null;
};
app.onDragEnd = () => {
  if (app.mode === 'intro') {
    const v = introView();
    app.introBase = app.cam.az;
    void v;
  }
};
app.onPointerUp = () => app.chrome.pointerUp();
app.onDragFar = () => { if (app.sel) closeStrip(); };
app.onDoubleTap = () => {
  if (!SKYLIKE.has(app.mode)) return;
  app.gyro.on && app.gyro.resetOffset();
  app.needRest = true;
  app.rig.setTarget(stand(app.cam.az), GLIDE);
};
app.onHover = (x, y) => {
  if (x === null || !SKYLIKE.has(app.mode)) { app.hover = null; return; }
  app.hover = app.overlay.pick(pickState(), x, y);
};
app.onKey = (name) => {
  if (name === 'space' && app.mode === 'sky') { openRuler({ play: true }); return true; }
  if (name === 'listen' && (app.mode === 'sky' || app.mode === 'listen')) { app.listen.toggle(); return true; }
  return false;
};
app.onGyroOff = () => app.chrome.toggles({ gyro: false });
app.onTap = (x, y) => {
  const mode = app.mode;
  if (mode === 'arrive') { skipArrival(); return; }
  if (app.ruler.isOpen) { app.ruler.close('sky'); return; }
  if (!SKYLIKE.has(mode)) return;
  const hit = app.overlay.pick(pickState(), x, y);
  if (hit) { select(hit); return; }
  const r = app.chrome.tapSky();
  if (r === 'strip') closeStrip(true);
};

function pickState() {
  return { cam: app.cam, M: app.sky.M, sky: app.sky, terrainH: app.vis.terrainH, sunAlpha: app.vis.sunAlpha * app.vis.dayMask };
}

// ------------------------------------------------------------------ icons and the tip (收款码)
function setupIcons() {
  for (const [id, ic, label] of [['r-play', 'play', T.ruler.play], ['r-back', 'back', T.ruler.back], ['r-done', 'done', T.ruler.done]]) {
    const b = document.getElementById(id);
    if (b) { b.innerHTML = ICON[ic]; b.setAttribute('aria-label', label); b.classList.add('ic'); }
  }
}

function setupTip() {
  const t = CONFIG.tip;
  const btn = $('#tip'), big = $('#tip-big');
  if (!t || !btn || !big) return;
  $('#tip-img').src = t.image;
  $('#tip-l').textContent = T.tip.label;
  btn.setAttribute('aria-label', t.line || T.tip.label);
  $('#tb-img').src = t.image;
  $('#tb-line').textContent = t.line;
  $('#tb-hint').textContent = t.hint;
  btn.hidden = false;
  btn.addEventListener('click', () => {
    track('tip_open');
    big.classList.add('on');
    big.setAttribute('aria-hidden', 'false');
  });
  // a long-press on the code belongs to WeChat (识别图中二维码); a tap anywhere else closes
  big.addEventListener('click', (e) => {
    if (e.target.closest('.tb-img')) return;
    big.classList.remove('on');
    big.setAttribute('aria-hidden', 'true');
  });
}

// ------------------------------------------------------------------ chrome events
function bindChrome() {
  const c = app.chrome;
  c.on('start', () => onStart('primary'));
  c.on('start2', () => onStart('secondary'));
  c.on('retry', () => location.reload());
  c.on('skip', () => skipRewind());
  c.on('exposure', ({ value, ms }) => tween(app.vis, 'exposure', value, ms ?? 900));
  c.on('summary', () => openNight());
  c.on('time', () => openRuler());
  c.on('caption', ({ dir }) => {
    if (dir === 'up') { openNight(); return; }
    if (app.mode === 'sky') tourStep(dir === 'prev' ? -1 : 1);
  });
  c.on('strip-close', () => closeStrip(true));
  c.on('listen-stop', () => app.listen.stop());
  c.on('look', ({ target, row }) => lookFromPlate(target, row));
  c.on('poem-next', () => nextPoem());
  c.on('other', async () => { c.closePlate(); const p = await askBirthday('self', { empty: true }); if (p) goNight(p, { own: true }); });
  c.on('invite', (k) => app.pair.onInvite(k));
  c.on('pair-switch', () => app.pair.switchSides());
  c.on('toggle', (k) => onToggle(k));
  c.on('action', (k) => onAction(k));
  c.on('act', (k) => onAct(k));
  c.on('chrome', () => app.overlay?.setUIRects(c.uiRects()));
  c.on('escape', () => onEscape());
}

function onToggle(k) {
  const c = app.chrome;
  if (k === 'culture') {
    app.culture = Chrome.nextCulture(app.culture);
    store.set('culture', app.culture);
    app.overlay.setCulture(app.culture);
    c.toggles({ culture: app.culture });
    toast(T.chrome.cultureToast[app.culture]);
    app.lines = { mode: app.culture === 'none' ? 'off' : 'focus', focusIds: [], selId: null, origin: null, labels: true };
    app.needRest = app.culture !== 'none';
  } else if (k === 'sound') {
    app.muted = !app.muted;
    store.set('muted', app.muted);
    app.audio.setMuted(app.muted);
    if (!app.muted) app.audio.start();
    c.toggles({ sound: !app.muted });
  } else if (k === 'gyro') {
    if (app.gyro.on) { app.gyro.disable(); c.toggles({ gyro: false }); return; }
    app.gyro.enable().then((ok) => {
      c.toggles({ gyro: !!ok });
      if (ok) hint('gyro', T.hint.gyro);
    });
  }
}

function onAction(k) {
  const own = app.own;
  switch (k) {
    case 'listen': app.listen.toggle(); break;
    case 'keep': app.keep.open({ format: app.pairView ? 'card' : 'wallpaper' }); break;
    case 'pair': own ? app.pair.invite() : app.pair.together(app.viewing); break;
    case 'gift': app.keep.startGift(); break;
    case 'share': share(app.pairView ? 'result' : own ? 'own' : 'guest'); break;
    case 'mine': goMine(); break;
    case 'send': share('result'); break;
    case 'again': share('invite'); break;
    case 'try': app.pair.tryIt(); break;
    default:
  }
}

function onAct(k) {
  if (k === 'hide') {
    tween(app.vis, 'dayMask', 0, 1600);
    app.chrome.captionActs([{ key: 'restore', label: T.hero.restoreSun }, { key: 'night', label: T.hero.nightOf }]);
  } else if (k === 'restore') {
    tween(app.vis, 'dayMask', 1, 1600);
    app.chrome.captionActs([{ key: 'hide', label: T.hero.hideSun }, { key: 'night', label: T.hero.nightOf }]);
  } else if (k === 'night') {
    openRuler({ night: true });
  } else if (k === 'mine') {
    goMine();
  } else if (k === 'together') {
    app.pair.together(app.viewing);
  }
}

function onEscape() {
  const c = app.chrome;
  if (c.plateOpen) { c.closePlate(); return; }
  if (app.ruler.isOpen) { app.ruler.close('escape'); return; }
  if (app.mode === 'keep' || app.mode === 'result') { app.keep.escape(); return; }
  if (app.mode === 'pair-invite') { app.pair.onInvite('cancel'); return; }
  if (app.listen.on) { app.listen.stop(); return; }
  if (app.sel) closeStrip(true);
}

// ------------------------------------------------------------------ S1 / S2 start
let starting = false;
async function onStart(which) {
  if (app.mode !== 'intro' || !app.catalog || !app.renderer || starting) return;
  starting = true;
  app.audio.setMuted(app.muted);
  app.audio.start();
  track('start', app.link.kind || 'direct');
  await app.chrome.introExit();
  starting = false;
  const L = app.link;
  if (L.kind === 'person') { goNight(L.a, { own: false }); return; }
  if (L.kind === 'gift') {
    // the friend who received a card: it is their own night
    if (!app.me) { app.me = L.a; store.set('me', L.a); }
    app.receiverFrom = L.from;
    goNight(L.a, { own: true, receiver: L.from });
    return;
  }
  if (L.kind === 'result') { goNight(L.a, { own: samePerson(L.a, app.me), then: () => app.pair.show(L.a, L.b, { guest: !samePerson(L.a, app.me) }) }); return; }
  if (L.kind === 'invite') {
    if (which === 'primary' && app.me) {
      goNight(app.me, { own: true, then: () => app.pair.show(app.me, L.a, { incoming: true }) });
      return;
    }
    const p = await askBirthday('hepan-self', { inviter: L.a, empty: which === 'secondary' });
    if (p) goNight(p, { own: true, then: () => app.pair.show(p, L.a, { incoming: true }) });
    return;
  }
  const p = await askBirthday('self');
  if (p) goNight(p, { own: true });
}

/** S3: the form over the lowered gaze. Resolves with a person, or null when the user went back. */
async function askBirthday(kind, ctx = {}) {
  const from = app.mode;
  const prevView = app.cam.snapshot();
  const prevChrome = app.chrome.chromeOn;
  closeStrip();
  app.listen.on && app.listen.stop({ now: true });
  setMode('form');
  app.chrome.hideChrome('form');
  if (from === 'intro') app.lat = app.lat || 39.9;
  app.rig.setTarget(formView(), GLIDE);
  tween(app.vis, 'exposure', 0.7, 900);
  const r = await app.form.open(kind, { inviter: ctx.inviter || app.link.a, me: app.me, empty: !!ctx.empty });
  window.scrollTo(0, 0);
  const appEl = document.getElementById('app');
  if (appEl) { appEl.scrollTop = 0; appEl.scrollLeft = 0; }
  tween(app.vis, 'exposure', 1, 900);
  if (r && r !== 'back') return r;
  // 返回: back to where we came from
  if (from === 'intro') {
    setMode('intro');
    app.introBase = null;
    app.rig.setTarget(introView(), GLIDE);
    app.chrome.intro({ lede: app.introLede, primary: app.introLabel, secondary: app.introSecondary, immediate: true });
  } else {
    setMode(from === 'gift' ? 'sky' : from);
    app.rig.setTarget(prevView, GLIDE);
    if (prevChrome) app.chrome.showChrome();
  }
  return null;
}
app.askBirthday = askBirthday;

function goMine() {
  track('guest_mine');
  if (app.me) { goNight(app.me, { own: true }); return; }
  askBirthday('self').then((p) => p && goNight(p, { own: true }));
}
app.goMine = goMine;

// ------------------------------------------------------------------ S4 rewind
/**
 * Rewind to a person's birth night and arrive (S4 → S5). opts: own (subject 你), receiver (gift sender's name),
 * gift (the 送一张 flow: the friend's sky, then the 贺卡 viewfinder), then() after the arrival has settled.
 */
async function goNight(person, opts = {}) {
  const { own = false } = opts;
  track('rewind', own ? 'own' : 'guest');
  app.listen.on && app.listen.stop({ now: true });
  closeStrip();
  app.pair?.leave({ quiet: true });
  if (app.ruler.isOpen) app.ruler.close('rewind');
  app.chrome.clearCaption(200);
  app.chrome.hideChrome('rewind');
  app.reticle = null; app.heroTag = null; app.marker = null; app.sel = null;
  app.lines = { mode: 'off', focusIds: [], selId: null, origin: null, labels: true };
  app.widened = null;
  setMode('rewind');
  const target = momentOf(person);
  const v = app.vis;
  tween(v, 'bodies', 0, 600);
  tween(v, 'crisp', 0.18, 1200, ease.inOut, 300);
  tween(v, 'dayMask', 0.14, 900);
  tween(v, 'mwAmt', 0.6, 1200);
  tween(v, 'compass', 0, 400);
  tween(v, 'exposure', 1, 600);
  const view = rewindView(person.city.lat, W(), H());
  const flip = Math.abs(angDiff(app.cam.az, view.az)) > 90 && Math.sign(app.lat || 1) !== Math.sign(person.city.lat || 1);
  const startT = app.moment.getTime();
  const D = 4 * SIDEREAL_DAY_MS + ((((startT - target.getTime()) % SIDEREAL_DAY_MS) + SIDEREAL_DAY_MS) % SIDEREAL_DAY_MS);
  app.live = false;
  const r = app.rewind = { person, opts, own, target, startT, D, from: { lat: app.lat, lon: app.lon }, t0: 0, lastT: null };
  if (flip && !reduced()) await app.chrome.cut(() => app.rig.set(view), { out: 700, hold: 300, in: 1400 });
  else await Promise.race([app.rig.setTarget(view, GLIDE), wait(2400)]);
  if (app.rewind !== r) return;
  v.trail.on = true; v.trail.clear = true; v.trail.opacity = 1;
  const seen = !!store.get('seenRewind');
  store.set('seenRewind', true);
  app.chrome.rewindStart({
    from: new Date(startT), to: target, tz: person.city.tz,
    sub: T.rewind.ago(target), place: T.rewind.place(person, own ? person.name : nameOr(person, '')), skippable: seen,
  });
  r.dur = reduced() ? 1600 : 6400;
  r.t0 = performance.now();
  app.audio.rewind(r.dur / 1000);
}
app.goNight = goNight;

function skipRewind() {
  const r = app.rewind;
  if (!r || !r.t0 || r.skipAt) return;
  const u = Math.min(1, (performance.now() - r.t0) / r.dur);
  r.skipAt = performance.now();
  r.skipU = u;
}

function stepRewind(now) {
  const r = app.rewind;
  let u = Math.min(1, (now - r.t0) / r.dur);
  if (r.skipAt) u = Math.min(1, r.skipU + (1 - r.skipU) * Math.min(1, (now - r.skipAt) / 1200));
  const b = B_REWIND(u);
  const T0 = r.target.getTime() + (1 - b) * r.D;
  const s = ease.inOutSine(u);
  const lat = lerp(r.from.lat, r.person.city.lat, s);
  const dLon = ((((r.person.city.lon - r.from.lon) % 360) + 540) % 360) - 180;
  const lon = r.from.lon + dLon * s;
  // light is deposited per degree the sky turns, and only while the camera is still
  const prevT = r.lastT ?? T0;
  const spinDeg = Math.abs(prevT - T0) / SIDEREAL_DAY_MS * 360;
  const n = Math.max(1, Math.min(12, Math.ceil(spinDeg / 0.6)));
  const Ms = [];
  const still = app.rig.speed() < 0.3;
  if (still) for (let i = 1; i <= n; i++) Ms.push(skyMatrix(new Date(prevT + (T0 - prevT) * (i / n)), lat, lon));
  r.lastT = T0;
  const dt = Math.min(0.1, Math.max(0.004, (now - (r.lastNow ?? now - 16)) / 1000));
  r.lastNow = now;
  const v = app.vis;
  v.trail.fade = Math.exp(-dt / 0.6);
  v.trail.gain = 0.24 * Math.min(1, spinDeg / n / 0.6);
  v.trail.Ms = Ms;
  v.trail.clear = !r.started;
  r.started = true;
  app.moment = new Date(T0);
  app.lat = lat; app.lon = lon;
  app.skyDirty = true;
  app.chrome.rewindFrame(app.moment, u);
  if (u >= 1) arrive();
}

// ------------------------------------------------------------------ S5 arrival
async function arrive() {
  const r = app.rewind;
  app.rewind = null;
  const p = r.person, { own, opts } = r;
  const v = app.vis;
  setPlace(p);
  setMode('arrive');
  app.audio.arrive();
  v.trail.Ms = [];
  tween(v.trail, 'opacity', 0, 800, ease.out).then(() => { v.trail.on = false; v.trail.clear = true; });
  tween(v, 'crisp', 1, 1200, ease.outQuart);
  v.exposure = 0.85; tween(v, 'exposure', 1, 1600);
  tween(v, 'bodies', 1, 1200, ease.fade, 300);
  tween(v, 'mwAmt', 1, 1600);
  tween(v, 'dayMask', 1, 2200, ease.fade, 400);
  tween(v, 'compass', 1, 1200, ease.fade, 1200);
  const guest = !own;
  const title = opts.receiver !== undefined && opts.receiver !== null && opts.receiver !== ''
    ? T.gift.receiverTitle : own ? T.arrive.titleOwn : T.arrive.titleGuest(nameOr(p));
  app.chrome.arrive({ sub: T.arrive.sub(p), title, guest });
  enterSky(p, { own });
  const a = app.arrival = { person: p, landed: false, skipped: false };
  await wait(800);
  if (app.arrival !== a) return;
  const hero = app.hero;
  const view = stand(hero.az, hero.alt > 0 ? hero.alt : undefined);
  await Promise.race([app.rig.path(view, { kind: 'arrival' }), wait(5600)]);
  if (app.arrival !== a) return;
  if (!a.skipped) await app.chrome.land({ meta: app.metaText, time: fmtTime(p) });
  landed(a, opts);
}

function skipArrival() {
  const a = app.arrival;
  if (!a || a.landed || a.skipped) return;
  a.skipped = true;
  app.chrome.skipArrival({ meta: app.metaText, time: fmtTime(a.person) });
}

async function landed(a, opts) {
  if (a.landed) return;
  a.landed = true;
  app.arrival = null;
  track('arrive', app.own ? 'own' : 'guest');
  setMode(opts.gift ? 'gift' : 'sky');
  app.chrome.rewindEnd();
  app.chrome.meta(app.metaText, fmtTime(a.person));
  app.chrome.summary(''); // the summary now lives in 那一夜 (the meta line's words open it)
  app.chrome.actions(app.own ? 'own' : 'guest');
  await wait(400);
  if (opts.gift) {
    app.chrome.caption(T.gift.arriveCaption(nameOr(a.person, '')), { key: 'gift', transient: true, ms: 2600 });
    await wait(1400);
    app.keep.open({ gift: opts.gift });
    return;
  }
  showHero({ enter: true, receiver: opts.receiver });
  await wait(600);
  app.chrome.showChrome({ first: true });
  app.chrome.iconLabels();
  app.chrome.tip(!!CONFIG.tip);
  app.chrome.restHints({ heroText: app.hero.caption });
  app.overlay.setUIRects(app.chrome.uiRects());
  if (app.own && !opts.receiver) countPoem();
  if (!app.own) {
    // S18: after the hero's dwell, the invite line in the caption slot
    const dwell = Math.min(9000, Math.max(3200, 1600 + 160 * app.hero.caption.replace(/\s/g, '').length));
    setTimeout(() => { if (app.mode === 'sky' && !app.own && app.tourI === 0) app.chrome.guestInvite(nameOr(app.viewing)); }, dwell + 1200);
  }
  opts.then?.();
}

// ------------------------------------------------------------------ the night
function enterSky(person, { own }) {
  app.viewing = person;
  app.own = own;
  app.birth = momentOf(person);
  app.subject = own ? '你' : nameOr(person);
  app.facts = computeFacts(app.catalog, person, app.birth, app.sky);
  app.hero = chooseHero(app.catalog, app.sky, app.facts, app.subject);
  app.tour = buildTour(app.catalog, app.facts, app.sky, app.hero, app.subject);
  app.tourI = 0;
  app.poemStep = 0;
  app.poemCount = null;
  const pr = poemForPerson(person);
  if (pr.regional) {
    app.tour.push({ key: 'poem', text: `${pr.poem.lines.join('')}\n${T.tour.poemPlace(app.subject, pr.place)}`, n: null, target: null });
  }
  app.metaText = own ? T.meta.own(person) : T.meta.guest(person);
  app.chrome.setTags(tagsFor(app.catalog, app.sky, app.facts));
  const s = shareFor(own ? 'own' : 'guest', { person });
  setShareTarget(s.url, s.title);
}
app.enterSky = enterSky;

function showHero({ enter = false, receiver = '' } = {}) {
  const hero = app.hero;
  const now = performance.now();
  const acts = hero.kind === 'day' ? [{ key: 'hide', label: T.hero.hideSun }, { key: 'night', label: T.hero.nightOf }] : null;
  const text = receiver ? `${T.gift.receiverCaption(receiver)}` : hero.caption;
  app.chrome.caption(text, { key: 'hero', acts, enter });
  if (receiver) {
    // the sender's words first, then the hero fact
    setTimeout(() => { if (app.tourI === 0 && app.mode === 'sky') app.chrome.caption(hero.caption, { key: 'hero', acts }); }, 5200);
  }
  app.marker = null;
  app.reticle = hero.reticle ? { n: hero.n, t0: now, kind: 'hero' } : null;
  app.heroTag = hero.label && hero.reticle ? { n: hero.n, text: hero.label } : null;
  if (app.culture !== 'none') {
    const focus = app.overlay.focusAsterisms(app.cam, app.sky.M, 3, 25, hero.n);
    app.lines = { mode: 'focus', focusIds: focus, selId: null, origin: hero.n, labels: true };
  }
}

function tourStep(d) {
  if (!app.tour.length) return;
  markHint('tour');
  closeStrip();
  app.tourI = (app.tourI + d + app.tour.length) % app.tour.length;
  const it = app.tour[app.tourI];
  track('caption_next', it.key);
  if (it.hero || app.tourI === 0) {
    showHero();
    lookAt(app.hero.n);
    return;
  }
  const now = performance.now();
  app.chrome.caption(it.text, { key: it.key });
  app.heroTag = null;
  app.marker = it.belowHorizon ? it.marker : null;
  app.reticle = it.n && !it.belowHorizon ? { n: it.n, t0: now, kind: 'hero' } : null;
  if (it.belowHorizon) {
    app.needRest = true;
    app.rig.setTarget(stand(it.az), LOOK);
  } else if (it.n) {
    lookAt(it.n);
    if (app.culture !== 'none') {
      const focus = app.overlay.focusAsterisms(app.cam, app.sky.M, 2, 25, it.n);
      app.lines = { mode: 'focus', focusIds: focus, selId: null, origin: it.n, labels: true };
    }
  }
}

// S11 name strip
function select(sel) {
  const d = describe(app.catalog, sel, app.sky, app.facts, { subject: app.subject, pair: app.pairView?.result || null });
  if (!d) return;
  app.sel = sel;
  app.chrome.strip(d);
  const now = performance.now();
  app.reticle = { n: d.n, t0: now, kind: 'sel' };
  app.heroTag = null;
  app.marker = null;
  app.lines = { ...app.lines, mode: app.culture === 'none' ? 'off' : 'focus', selId: app.overlay.asterismFor(sel, app.sky.M, app.sky) };
  const alt01 = Math.max(0, d.alt || 0) / 90;
  if (sel.type === 'star') app.audio.star(alt01, app.catalog.stars.mag[sel.index], 0.5, 0);
  else app.audio.body(sel.id, alt01);
  // the camera moves only when the object would sit under the words or at an edge
  const p = app.cam.project(d.n, {});
  if (!p || p.y > 0.62 * H() || p.x < 0.12 * W() || p.x > 0.88 * W()) lookAt(d.n);
}
app.select = select;

function closeStrip(fromUser = false) {
  if (!app.sel && !fromUser) return;
  app.sel = null;
  app.chrome.strip(null);
  app.reticle = null;
  app.lines = { ...app.lines, selId: null };
}
app.closeStrip = closeStrip;

// S10 那一夜
function poemInfo() {
  const pr = poemForPerson(app.viewing, app.poemStep, { pair: false });
  const count = app.poemStep === 0 && app.own && app.poemCount ? countLine(app.poemCount) : '';
  return { poem: pr.poem, lines: pr.poem.lines, attribution: attribution(pr.poem), place: pr.place, regional: pr.regional, count };
}
app.poemInfo = poemInfo;

function openNight() {
  if (!app.facts || app.chrome.plateOpen) return;
  track('plate_open');
  closeStrip();
  app.chrome.openNight({
    title: T.night.title, meta: app.metaText, rows: nightRows(app.facts, app.subject), note: nightNote(app.facts), poem: poemInfo(),
  });
}

function nextPoem() {
  app.poemStep++;
  app.chrome.nightPoem(poemInfo());
}

async function lookFromPlate(target, row) {
  app.chrome.closePlate();
  await wait(380);
  if (!target) return;
  const it = app.tour.find((x) => x.key === row?.key);
  if (it?.belowHorizon) { app.rig.setTarget(stand(it.az), LOOK); return; }
  select(target);
  const d = describe(app.catalog, target, app.sky, app.facts, { subject: app.subject });
  if (d) lookAt(d.n);
}

async function countPoem() {
  if (!statsEnabled() || !app.me) return;
  const pr = poemForPerson(app.me);
  const n = await recordPoem(pr.poem.id, poemSeed(app.me));
  if (Number.isFinite(n)) app.poemCount = n;
}

// S12 整夜
function openRuler({ play = false, night = false } = {}) {
  if (!app.viewing || app.ruler.isOpen) return;
  const p = app.viewing;
  track('ruler_open');
  closeStrip();
  app.listen.on && app.listen.stop({ now: true });
  let range = [-360, 360], at = app.moment;
  if (night) {
    // 看看那天夜里: find the first moment the Sun is below −18°
    for (let m = 10; m <= 24 * 60; m += 10) {
      const d = new Date(app.birth.getTime() + m * 60000);
      if (skyState(d, p.city.lat, p.city.lon).sun.alt < -18) { at = d; range = [-360, Math.max(360, m + 120)]; break; }
    }
  }
  app.mode = 'ruler';
  app.ruler.open({
    birth: app.birth, tz: p.city.tz, lat: p.city.lat, lon: p.city.lon, at, range,
    onTime: (d) => { app.moment = d; app.skyDirty = true; },
    onClose: (d) => {
      app.mode = 'sky';
      const z = zonedParts(d, p.city.tz);
      const meta = fmtWhen(p, { at: z, name: app.own ? undefined : nameOr(p) });
      app.chrome.meta(meta, `${String(z.hh).padStart(2, '0')}:${String(z.mm).padStart(2, '0')}`);
    },
  });
  if (at !== app.moment) { app.moment = at; app.skyDirty = true; }
  hint('ruler', T.hint.ruler);
  if (play) app.ruler.play(true);
}
app.openRuler = openRuler;

// S19 share
function share(kind) {
  track('share', kind);
  let s;
  if (kind === 'invite') s = shareFor('invite', { person: app.me || app.viewing });
  else if (kind === 'result') {
    const r = app.pairView?.result;
    if (!r) return;
    s = shareFor('result', { a: r.a, b: r.b, both: r.both, nameB: r.nameB });
  } else s = shareFor(kind, { person: app.viewing });
  shareLink(s);
}
app.share = share;

// ------------------------------------------------------------------ go
app.isWeChat = isWeChat;
app._glState = () => glState(performance.now() / 1000);

/** After the 送一张 viewfinder closes: the friend's sky, as a guest sky. */
app.afterGift = () => {
  setMode('sky');
  app.chrome.actions(app.own ? 'own' : 'guest');
  showHero();
  app.chrome.showChrome();
};
app.cjk = cjk;
app.clearHint = clearHint;
boot();
