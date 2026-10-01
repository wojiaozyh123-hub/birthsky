// The stage's words (spec §2.3 slots, §2.4 motion, §4): intro text, the rewind odometer and the arrival
// hand-off, the subtitle slot, the meta line with its time window, the summary line, the action row, the top
// toggles, the name strip, the 那一夜 / 关于 plate, the two-person screens, the fade-through-black cut, the
// scrims — and the chrome idle manager (D-4) plus the look-to-reveal tag scheduler (S9).
//
// It never moves the camera and never touches WebGL. It talks back through events (chrome.on(name, fn)).
//
// Public API
//   new Chrome(app = {})                 binds the DOM of index.html; app is only read (app.audio optional)
//   chrome.on(name, fn) → off            events below;  chrome.onAction(fn) = on('action', fn)
//   chrome.H, chrome.W                   viewport CSS px; H is locked against keyboard drops > 120 px (§3b.5)
//   chrome.layout(force)                 re-measure (called on resize / orientationchange by itself)
//   chrome.scene(name)                   'intro' | 'form' | 'rewind' | 'sky' | 'listen' | 'ruler' | 'pair-invite'
//                                        | 'pair' | 'keep' | 'result' | 'fallback' → #app[data-scene]; decides which
//                                        stage slots may show and where the hint slot sits
//   ── S1 / S2 intro
//   chrome.intro({ lede, primary, secondary, immediate })   lede text ('\n' breaks); primary = ready label or
//                                        omitted while loading; secondary = 「换一个生日」 or null. Timed entrance:
//                                        title 1.2 s (1400 ms fade), lede 2.6 s, CTA + hint 3.4 s (stagger 90).
//                                        immediate: re-enter at once (after 返回 / closing 关于)
//   chrome.introProgress(p)              0..1: the underline fills, label 「载入星表 62%」
//   chrome.introReady(label)             label crossfades (320 out / 520 in) to 回到那一晚 / 去看看 / …
//   chrome.introFailed()                 「载入失败，轻触重试」; the button then emits 'retry'
//   chrome.introExit() → Promise         text leaves (420 ms)
//   ── S4 / S5 rewind and arrival
//   chrome.rewindStart({ from, to, tz, sub, place, skippable })   Dates; sub 「28 年，一夜一夜退回去」, place 「杭州 · 小明」
//                                        (shown from 72 %); 「跳过」 appears after 1.5 s when skippable
//   chrome.rewindFrame(moment, u)        every frame of the spin; u = time progress 0..1 (the counter reads
//                                        B(u) = cubic-bezier(.55,0,.12,1) for the year, month and day follow moment)
//   chrome.arrive({ sub, title, guest }) t = 0 of S5: day digit settles, sub-line → 「22:00 · 杭州」 at 300 ms,
//                                        title card at 1200 ms (guest: text 300)
//   chrome.land({ meta, time }) → Promise   on camera settle: title card out (1000 ms), the counter block flies
//                                        into the meta slot (700 ms) and crossfades into the meta line
//   chrome.skipArrival()                 a tap during the title card: straight to the rest state
//   chrome.titleCard(text | null, { guest }), chrome.counter(show), chrome.rewindEnd()
//   ── S6–S9 stage
//   chrome.meta(text, timeText)          the meta line; timeText (e.g. '22:00' / '夜里') becomes the time window
//   chrome.summary(text)
//   chrome.caption(text, { acts, key, transient, ms, dropOnDrag, sticky }) → Promise<boolean>
//                                        swap 360 / 120 / 620 (+6 px); transient: dwell by length then out 500.
//                                        sticky: stays when the chrome idles out (S18 invite); dropOnDrag: leaves
//                                        on the first drag. A caption set on purpose always shows (even with
//                                        the chrome hidden); clauses decide the line breaks (subtitle style).
//                                        acts: [{ key, label, strong }] → 'act' events. Resolves when shown (or,
//                                        transient, when gone); false if superseded
//   chrome.captionActs(acts), chrome.clearCaption()
//   chrome.guestInvite(name)             S18 invite line with 看看我的那晚 / 和小明一起看 (acts 'mine' / 'together')
//   chrome.actions(variant, { active })  'own' | 'guest' | 'listen' | 'pair-own' | 'pair-guest' | 'ruler' | 'none'
//   chrome.setActive(key | null)
//   chrome.toggles({ culture: 'cn'|'iau'|'none', sound: bool, gyro: bool | null }); chrome.flashToggle('sound')
//   Chrome.nextCulture(c) → the next culture in 星官 → 星座 → 无连线
//   ── chrome idle manager (D-4) — call these from the gesture code and the frame loop
//   chrome.pointerDown()                 any finger on the sky (resets idle, remembers chrome state for a tap)
//   chrome.dragStart()                   the finger moved past the tap slop / a pinch began: chrome out 240 ms,
//                                        caption dims to α.5, drop-on-drag captions leave
//   chrome.pointerUp()                   caption back 400 ms after release; chrome back 600 ms after settle
//   chrome.tapSky() → 'strip' | 'show' | 'hide'   a tap on empty sky
//   chrome.touched()                     first touch on the sky (persisted: birthsky:touchedSky)
//   chrome.frame({ dt, settled, cam })   every frame: idle timer (8 s → 1200 ms fade), return-after-settle,
//                                        strip idle (12 s), adaptive bottom scrim, tag scheduler
//   chrome.showChrome({ first }), chrome.hideChrome(reason), chrome.chromeOn, chrome.suspend(key, on)
//   chrome.restHints({ heroText })       one-time hints of S6 (look after 8 s untouched, tour after the dwell)
//   ── tags (S9)
//   chrome.setTags(list)                 candidates from facts.tagsFor(): [{ key, n, text, target }]
//   chrome.tags                          → [{ key, n, text, alpha, x, y, target }] for overlay.draw({ tags })
//   chrome.uiRects() → [{x, y, w, h}]    visible text slots, for overlay.setUIRects() (label collisions)
//   ── S11 name strip
//   chrome.strip(desc | null)            desc = facts.describe(); crossfades 500 / 700 when switching
//   ── S10 / S20 plate
//   chrome.openNight({ title, meta, rows, note, poem })   rows = facts.nightRows(); poem = { lines, attribution,
//                                        place, regional, count } | null. Emits 'look', 'poem-next', 'other'
//   chrome.nightPoem(poem), chrome.openAbout(), chrome.closePlate(), chrome.plateOpen
//   ── S13 listen, S16 / S17 two people
//   chrome.listen(on)
//   chrome.pairInvite(on)                emits 'invite' with 'send' | 'manual' | 'cancel'
//   chrome.pairText({ where, switchLabel, dates, headline, count, lines, definition, animate })  → Promise
//   chrome.pairSwitchLabel(text), chrome.pairClear()
//   ── S14 / S15 (structure only; keep.js wires them)
//   chrome.keepFrame(format, aspect) → {x, y, w, h}   sizes #kf-frame (vars on #app) per spec S14
//   chrome.layer(id, on) → Promise       generic show/hide of a .layer with its .fx children (keep, keep-result, …)
//   ── misc
//   chrome.cut(mid, { out, hold, in }) → Promise   fade through black 700 / 300 / 1400; mid() runs in the black
//   chrome.fallback(kind)                'webgl' | 'catalog' (S21)
//   chrome.hint(key, text, opts)         = ui.hint
//
// Events: 'start' 'start2' 'about' 'retry' 'skip' 'action'(key) 'act'(key) 'toggle'(key) 'caption'({dir, key})
//   'summary' 'time' 'listen-stop' 'strip-close'({reason}) 'plate'({kind, open}) 'look'({key, target, row})
//   'poem-next' 'other' 'invite'(key) 'pair-switch' 'exposure'({value, ms}) 'chrome'(visible) 'escape' 'layout'
//
// Caption gestures: tap or swipe left → dir 'next', swipe right → 'prev', swipe up → 'up' (open 那一夜); 40 px.
import { $, $$, press, hint, markHint, hintDwell } from './ui.js';
import { T, noWidow, fmtCount } from './copy.js';
import { zonedParts } from './astro.js';
import { ease } from './camera.js';
import { CONFIG } from './config.js';
import { slotHtml, activateSlots } from './monetize.js';
import { ICON, CULTURE_BADGE } from './icons.js';

const ACTION_ICON = { listen: 'listen', keep: 'keep', pair: 'pair', gift: 'gift', share: 'share', send: 'share', again: 'again' };
const LABELS_SEEN = 'birthsky:iconLabels';

const E = { enter: 'cubic-bezier(0.22,1,0.36,1)', exit: 'cubic-bezier(0.4,0,1,1)', fade: 'cubic-bezier(0.37,0,0.63,1)' };
const B_REWIND = ease.bezier(0.55, 0, 0.12, 1);
const TOUCHED = 'birthsky:touchedSky';
const CULTURES = ['cn', 'iau', 'none'];
const SKYLIKE = new Set(['sky', 'listen']);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
// spec §10.4 / §10.2 strings (the poem row of 那一夜, the analytics line of 隐私), now carried by copy.js
const C = {
  poemLabel: T.night.poemLabel,
  poemNext: T.night.poemNext,
  poemPlace: T.night.poemPlace,
  analytics: T.about.analytics,
};

// ------------------------------------------------------------------------------------------ odometer
/**
 * 「1998.07.14」 in tabular Cormorant Lining digits, each digit a clipping column whose strip moves by
 * translateY (spec S4). Year digits roll continuously with carries; month and day follow the moment, each on
 * a spring (critically damped while spinning, ζ 0.75 in the last 450 ms and at arrival: 2–3 % overshoot).
 */
class Odometer {
  constructor(el) {
    this.el = el;
    const col = () => `<span class="oc"><span class="os">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => `<i>${d}</i>`).join('')}</span></span>`;
    el.innerHTML = `${col()}${col()}${col()}${col()}<span class="od">.</span>${col()}${col()}<span class="od">.</span>${col()}${col()}`;
    this.strips = $$('.os', el);
    this.springs = [4, 5, 6, 7].map(() => ({ x: 0, v: 0, t: 0 }));
    this.cell = 0;
    this.slow = false;
    this.raf = 0;
  }
  measure() {
    this.cell = parseFloat(getComputedStyle(this.el).fontSize) * 1.2 || 52.8;
  }
  put(i, p) {
    const q = ((p % 10) + 10) % 10;
    this.strips[i].style.transform = `translate3d(0,${(-q * this.cell).toFixed(2)}px,0)`;
  }
  /** Hard set: year value V (may be fractional), month, day. */
  jump(V, m, d) {
    if (!this.cell) this.measure();
    this.year(V);
    const ds = [Math.floor(m / 10), m % 10, Math.floor(d / 10), d % 10];
    this.springs.forEach((s, k) => { s.x = s.t = ds[k]; s.v = 0; this.put(4 + k, s.x); });
    this.label(Math.round(V), m, d);
  }
  year(V) {
    // units roll continuously; a higher digit turns only while everything below it passes 9 → 0
    for (let k = 0; k < 4; k++) {
      const p = 10 ** k;
      const base = Math.floor(V / p) % 10;
      const frac = k === 0 ? V - Math.floor(V) : clamp((V % p) - (p - 1), 0, 1);
      this.put(3 - k, base + frac);
    }
  }
  target(m, d) {
    const ds = [Math.floor(m / 10), m % 10, Math.floor(d / 10), d % 10];
    this.springs.forEach((s, k) => {
      let diff = ((ds[k] - s.x) % 10 + 10) % 10; // shortest way round the wheel
      if (diff > 5) diff -= 10;
      s.t = s.x + diff;
    });
  }
  step(dt) {
    const w = this.slow ? 14 : 42, z = this.slow ? 0.75 : 1;
    let busy = false;
    const n = Math.max(1, Math.ceil(dt * w / 0.25));
    const h = dt / n;
    for (const [k, s] of this.springs.entries()) {
      for (let i = 0; i < n; i++) {
        const a = -w * w * (s.x - s.t) - 2 * z * w * s.v;
        s.v += a * h;
        s.x += s.v * h;
      }
      if (Math.abs(s.x - s.t) > 1e-3 || Math.abs(s.v) > 1e-2) busy = true;
      else { s.x = s.t; s.v = 0; }
      this.put(4 + k, s.x);
    }
    return busy;
  }
  /** Let the month/day springs finish on their own (after the spin stops). */
  settle(done) {
    cancelAnimationFrame(this.raf);
    this.slow = true;
    let last = now();
    const tick = () => {
      const t = now();
      const busy = this.step(Math.min(0.05, (t - last) / 1000));
      last = t;
      if (busy) this.raf = requestAnimationFrame(tick);
      else done?.();
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this.raf); }
  label(y, m, d) {
    this.el.setAttribute('aria-label', `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`);
  }
}

// -------------------------------------------------------------------------------------------- chrome
export class Chrome {
  static nextCulture(c) { return CULTURES[(CULTURES.indexOf(c) + 1) % CULTURES.length]; }

  constructor(app = {}) {
    this.app = app;
    this.handlers = new Map();
    const q = (id) => document.getElementById(id);
    this.el = {
      app: q('app'), root: document.documentElement, scrimB: q('scrim-b'), scrimT: q('scrim-t'),
      intro: q('intro'), title: q('intro-title'), lede: q('intro-lede'), cta: q('intro-cta'), start: q('btn-start'), start2: q('btn-start-2'),
      introHint: q('intro-hint'), about: q('btn-about'),
      rewind: q('rewind'), skip: q('rw-skip'), card: q('rw-card'), rwMain: q('rw-main'), odo: q('rw-date'), subA: q('rw-sub-a'), subB: q('rw-sub-b'),
      stage: q('stage'), capWrap: q('cap-wrap'), caption: q('caption'), capText: q('cap-text'), capActs: q('cap-acts'),
      strip: q('strip'), stripIn: q('strip-in'), sName: q('s-name'), sLatin: q('s-latin'), sMeta: q('s-meta'), sStory: q('s-story'),
      summarySlot: q('summary-slot'), summary: q('summary'), meta: q('meta'), actions: q('actions'), listen: q('listen-status'),
      listenStop: q('listen-stop'), toggles: q('toggles'), tCulture: q('t-culture'), tSound: q('t-sound'), tGyro: q('t-gyro'),
      pairInvite: q('pair-invite'), pair: q('pair'), pairWhere: q('pair-where'), pairSwitch: q('pair-switch'), pairBlock: q('pair-block'),
      pDates: q('p-dates'), pHead: q('p-head'), pLines: q('p-lines'), pDef: q('p-def'), pairSlot: q('pair-slot'),
      plate: q('night'), sheet: q('night-sheet'), plateHead: q('night-head'), plateTitle: q('night-title'), plateMeta: q('night-meta'),
      plateBody: q('night-body'), rows: q('night-rows'), note: q('night-note'), nightSlot: q('night-slot'), colophon: q('colophon'),
      cut: q('cut'), hintSlot: q('hint-slot'), fallback: q('fallback'), fallbackText: q('fallback-text'), tip: q('tip'),
    };
    this.st = {
      scene: this.el.app?.dataset.scene || 'intro', chrome: false, hiddenBy: null, capHidden: false, capActive: false, capDim: false,
      chromeAtDown: false, finger: false, idle: 0, stillT: 0, suspend: new Set(), touched: store.get(TOUCHED) === '1',
      firstIdle: false, strip: null, stripIdle: 0, chromeBeforeStrip: false, plate: null, adapt: -1, metaSet: false,
      summarySet: false, variant: 'own', listen: false, pairBlock: false, scrim: '',
    };
    this.tags = [];
    this._tagCands = [];
    this._tagState = new Map();
    this._tmp = {};
    this._capSeq = 0;
    this._capKey = null;
    this._capDrop = false;
    this._introT = [];
    this._arr = [];
    this.odo = this.el.odo ? new Odometer(this.el.odo) : null;
    this.W = innerWidth;
    this.H = innerHeight;
    this._probe = document.createElement('div');
    this._probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:var(--st,0px);padding-bottom:var(--sb,0px)';
    document.body.appendChild(this._probe);
    this.layout(true);
    addEventListener('resize', () => this.layout());
    addEventListener('orientationchange', () => setTimeout(() => this.layout(true), 250));
    this._bind();
    this._scrim();
  }

  // ------------------------------------------------------------------------------------ events
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
    return () => this.handlers.get(name)?.delete(fn);
  }
  onAction(fn) { return this.on('action', fn); }
  emit(name, detail) {
    for (const fn of this.handlers.get(name) || []) {
      try { fn(detail); } catch (e) { console.error(e); }
    }
  }
  hint(key, text, opts) { return hint(key, text, opts); }

  get chromeOn() { return this.st.chrome; }
  get plateOpen() { return !!this.st.plate; }
  get safe() {
    const cs = getComputedStyle(this._probe);
    return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  }

  // ------------------------------------------------------------------------------------ layout
  layout(force = false) {
    const w = innerWidth, h = innerHeight;
    // the keyboard must not move anything: ignore height drops > 120 px unless the width changed too
    const keyboard = !force && w === this.W && this.H - h > 120;
    if (!keyboard) { this.H = h; this.W = w; }
    this.el.root.style.setProperty('--H', `${this.H}px`);
    this.odo?.measure();
    if (this._keepFmt) this.keepFrame(this._keepFmt, this._keepAspect);
    this.emit('layout', { W: this.W, H: this.H });
  }

  scene(name) {
    this.st.scene = name;
    if (this.el.app) this.el.app.dataset.scene = name;
    if (!SKYLIKE.has(name) && name !== 'pair') this.st.adapt = -1;
    this._sync({ out: 420, outEase: E.exit });
    this._scrim();
  }

  // ------------------------------------------------------------------------------------ bindings
  _bind() {
    const el = this.el;
    press('.tbtn, .aw, .tg, .kf-opt, .kf-tab, .kf-res, .summary');
    el.start?.addEventListener('click', () => {
      if (el.start.classList.contains('is-loading')) return;
      this.emit(el.start.dataset.state === 'failed' ? 'retry' : 'start');
    });
    el.start2?.addEventListener('click', () => this.emit('start2'));
    el.about?.addEventListener('click', () => { this.emit('about'); this.openAbout(); });
    el.skip?.addEventListener('click', () => this.emit('skip'));
    el.summary?.addEventListener('click', () => { this.st.idle = 0; this.emit('summary'); });
    el.meta?.addEventListener('click', (e) => { if (e.target.closest('.tw')) { this.st.idle = 0; this.emit('time'); } });
    el.actions?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (b) { this.st.idle = 0; this.emit('action', b.dataset.a); }
    });
    el.listenStop?.addEventListener('click', () => this.emit('listen-stop'));
    for (const [b, key] of [[el.tCulture, 'culture'], [el.tSound, 'sound'], [el.tGyro, 'gyro']]) {
      b?.addEventListener('click', () => { this.st.idle = 0; this.emit('toggle', key); });
    }
    el.capActs?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) { this.st.idle = 0; this.emit('act', b.dataset.act); }
    });
    this._captionGestures();
    this._stripGestures();
    this._plateGestures();
    $('#night-close')?.addEventListener('click', () => this.closePlate());
    $('#night-close-2')?.addEventListener('click', () => this.closePlate());
    $('#night-other')?.addEventListener('click', () => { this.closePlate(); this.emit('other'); });
    el.rows?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-look], [data-poem]');
      if (!b) return;
      if (b.dataset.poem !== undefined) { this.emit('poem-next'); return; }
      const row = this._rows?.[+b.dataset.look];
      this.closePlate();
      this.emit('look', { key: row?.key, target: row?.target, row });
    });
    $('#pi-send')?.addEventListener('click', () => this.emit('invite', 'send'));
    $('#pi-manual')?.addEventListener('click', () => this.emit('invite', 'manual'));
    $('#pi-cancel')?.addEventListener('click', () => { this.pairInvite(false); this.emit('invite', 'cancel'); });
    el.pairInvite?.addEventListener('click', (e) => {
      if (e.target === el.pairInvite || e.target.classList.contains('pi-col')) { this.pairInvite(false); this.emit('invite', 'cancel'); }
    });
    el.pairSwitch?.addEventListener('click', () => this.emit('pair-switch'));
    el.pairBlock?.addEventListener('scroll', () => el.pairBlock.classList.toggle('is-scrolled', el.pairBlock.scrollTop > 2), { passive: true });
    el.plateBody?.addEventListener('scroll', () => el.plateBody.classList.toggle('is-scrolled', el.plateBody.scrollTop > 2), { passive: true });
    const fc = $('#form-col');
    fc?.addEventListener('scroll', () => fc.classList.toggle('is-scrolled', fc.scrollTop > 2), { passive: true });
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.st.plate) this.closePlate();
      else if (this.st.scene === 'pair-invite') { this.pairInvite(false); this.emit('invite', 'cancel'); }
      else if (this.st.strip) { this.strip(null); this.emit('strip-close', { reason: 'escape' }); }
      else this.emit('escape');
    });
  }

  _captionGestures() {
    const c = this.el.caption;
    if (!c) return;
    let d = null;
    c.addEventListener('pointerdown', (e) => { d = { x: e.clientX, y: e.clientY, id: e.pointerId }; this.st.idle = 0; });
    c.addEventListener('pointercancel', () => { d = null; });
    c.addEventListener('pointerup', (e) => {
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d = null;
      let dir = null;
      if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) dir = dx < 0 ? 'next' : 'prev';
      else if (dy <= -40 && Math.abs(dy) > Math.abs(dx)) dir = 'up';
      else if (Math.hypot(dx, dy) < 12) dir = 'next';
      if (!dir) return;
      markHint('tour');
      this.emit('caption', { dir, key: this._capKey, tap: Math.hypot(dx, dy) < 12 });
    });
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.emit('caption', { dir: 'next', key: this._capKey, tap: true }); }
    });
  }

  _stripGestures() {
    const s = this.el.strip;
    if (!s) return;
    let d = null;
    s.addEventListener('pointerdown', (e) => { d = { y: e.clientY, x: e.clientX }; this.st.stripIdle = 0; });
    s.addEventListener('pointerup', (e) => {
      if (!d) return;
      const dy = e.clientY - d.y, dx = e.clientX - d.x;
      d = null;
      if (dy > 40 && dy > Math.abs(dx)) { this.strip(null); this.emit('strip-close', { reason: 'swipe' }); }
    });
    s.addEventListener('pointercancel', () => { d = null; });
  }

  // downward swipe on the plate follows the finger 1:1; dismiss at > 30 % or > 700 px/s (S10)
  _plateGestures() {
    const plate = this.el.plate, sheet = this.el.sheet, body = this.el.plateBody;
    if (!plate || !sheet) return;
    let g = null;
    const begin = (y, fromHead) => { g = { y0: y, y, t: now(), v: 0, active: fromHead, head: fromHead }; };
    const move = (y, e) => {
      if (!g) return;
      const dy = y - g.y0;
      if (!g.active) {
        if (body.scrollTop <= 0 && dy > 6) { g.active = true; g.y0 = y; } else return;
      }
      if (e?.cancelable) e.preventDefault();
      const t = now();
      g.v = (y - g.y) / Math.max(1, t - g.t) * 1000;
      g.y = y; g.t = t;
      plate.classList.add('is-dragging');
      plate.style.setProperty('--drag', `${Math.max(0, y - g.y0)}px`);
    };
    const end = () => {
      if (!g) return;
      const moved = Math.max(0, g.y - g.y0);
      const active = g.active;
      const v = g.v;
      g = null;
      plate.classList.remove('is-dragging');
      if (!active) return;
      if (moved > sheet.offsetHeight * 0.3 || v > 700) this.closePlate();
      else plate.style.setProperty('--drag', '0px');
    };
    sheet.addEventListener('touchstart', (e) => begin(e.touches[0].clientY, !!e.target.closest('.plate-head')), { passive: true });
    sheet.addEventListener('touchmove', (e) => move(e.touches[0].clientY, e), { passive: false });
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', end);
    this.el.plateHead?.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.target.closest('button')) return;
      begin(e.clientY, true);
      const mm = (ev) => move(ev.clientY);
      const up = () => { removeEventListener('pointermove', mm); removeEventListener('pointerup', up); end(); };
      addEventListener('pointermove', mm);
      addEventListener('pointerup', up);
    });
    plate.addEventListener('pointerdown', (e) => { if (e.target === plate) this.closePlate(); });
  }

  // ------------------------------------------------------------------------------------ helpers
  _vars(el, v) {
    if (!el) return;
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined || val === null) el.style.removeProperty(`--${k}`);
      else el.style.setProperty(`--${k}`, typeof val === 'number' ? `${val}ms` : val);
    }
  }

  /** Show / hide a .sl or .fx element with its timing. */
  _fx(el, on, { inMs, out, outEase, delay = 0, rise } = {}) {
    if (!el) return;
    const was = el.classList.contains('on');
    if (on === was && !(on && delay)) return;
    this._vars(el, { in: inMs, out, 'out-ease': outEase, delay: on ? delay : 0, rise: rise === undefined ? undefined : `${rise}px` });
    if (on && !was) void el.offsetWidth;
    el.classList.toggle('on', on);
  }

  /** Generic .layer show/hide; its visible .fx children enter staggered by 90 ms (max 5). */
  layer(elOrId, on, { stagger = 90, out = 420 } = {}) {
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    if (!el) return Promise.resolve();
    clearTimeout(el._layerT);
    const kids = $$('.fx', el).filter((k) => !k.hidden && !k.closest('[hidden]'));
    if (on) {
      el.classList.add('on');
      el.setAttribute('aria-hidden', 'false');
      void el.offsetWidth;
      kids.forEach((k, i) => this._fx(k, true, { delay: Math.min(i, 5) * stagger }));
      return wait(560 + Math.min(kids.length, 5) * stagger);
    }
    kids.forEach((k) => this._fx(k, false, { out }));
    el.setAttribute('aria-hidden', 'true');
    return new Promise((r) => { el._layerT = setTimeout(() => { el.classList.remove('on'); r(); }, out); });
  }

  _swapLabel(btn, text) {
    const lbl = btn?.querySelector('.lbl');
    if (!lbl || lbl.textContent === text) return;
    clearTimeout(btn._swapT);
    const ul = btn.querySelector('.uline');
    const w0 = btn.offsetWidth;
    lbl.classList.remove('is-in');
    lbl.classList.add('is-out');
    btn._swapT = setTimeout(() => {
      lbl.textContent = text;
      const w1 = btn.offsetWidth;
      if (ul && w0 && w1 && Math.abs(w0 - w1) > 1) {
        ul.style.transition = 'none';
        ul.style.transform = `scaleX(${(w0 / w1).toFixed(4)})`;
        void ul.offsetWidth;
        ul.style.transition = `transform 520ms ${E.enter}`;
        ul.style.transform = 'none';
      }
      lbl.classList.remove('is-out');
      lbl.classList.add('is-in');
    }, 320);
  }

  // ------------------------------------------------------------------------------------ S1 / S2 intro
  intro({ lede = T.intro.lede, primary = null, secondary = null, immediate = false } = {}) {
    const el = this.el;
    this.scene('intro');
    this._introT.forEach(clearTimeout);
    this._introT = [];
    if (el.lede) el.lede.innerHTML = noWidow(lede);
    el.intro?.classList.toggle('has-2', !!secondary);
    if (el.start2) {
      el.start2.hidden = !secondary;
      if (secondary) el.start2.textContent = secondary;
    }
    if (primary) this._introLabel = primary;
    if (el.start && !el.start.classList.contains('is-loading') && primary) {
      el.start.querySelector('.lbl').textContent = primary;
    }
    el.intro?.classList.add('on');
    el.intro?.setAttribute('aria-hidden', 'false');
    const steps = immediate
      ? [[el.title, 0], [el.lede, 90], [el.cta, 180], [el.introHint, 270], [el.about, 360]]
      : [[el.title, 1200], [el.lede, 2600], [el.cta, 3400], [el.introHint, 3490], [el.about, 3580]];
    for (const [node, at] of steps) {
      this._introT.push(setTimeout(() => this._fx(node, true, { inMs: node === el.title && !immediate ? 1400 : 560 }), at));
    }
  }

  introProgress(p) {
    const b = this.el.start;
    if (!b || !b.classList.contains('is-loading')) return;
    const x = clamp(p, 0, 1);
    b.style.setProperty('--p', x.toFixed(3));
    b.querySelector('.lbl').textContent = T.intro.loading(x * 100);
  }

  introReady(label = this._introLabel || T.intro.start) {
    const b = this.el.start;
    if (!b) return;
    b.style.setProperty('--p', '1');
    b.dataset.state = 'ready';
    b.setAttribute('aria-disabled', 'false');
    // the fill reaches the end, then the button becomes a plain underlined word
    setTimeout(() => b.classList.remove('is-loading'), 400);
    this._swapLabel(b, label);
  }

  introFailed() {
    const b = this.el.start;
    if (!b) return;
    b.classList.remove('is-loading');
    b.dataset.state = 'failed';
    b.setAttribute('aria-disabled', 'false');
    this._swapLabel(b, T.intro.failed);
  }

  /** Back to loading (after 载入失败 → retry). */
  introLoading() {
    const b = this.el.start;
    if (!b) return;
    b.dataset.state = 'loading';
    b.classList.add('is-loading');
    b.setAttribute('aria-disabled', 'true');
    b.style.setProperty('--p', '0');
    this._swapLabel(b, T.intro.loading(0));
  }

  introExit() {
    this._introT.forEach(clearTimeout);
    this._introT = [];
    return this.layer(this.el.intro, false);
  }

  // ------------------------------------------------------------------------------------ S4 rewind
  rewindStart({ from = new Date(), to, tz = 'Asia/Shanghai', sub = '', place = '', skippable = false } = {}) {
    const el = this.el;
    this.scene('rewind');
    this._arr.forEach(clearTimeout);
    this._arr = [];
    this.odo?.stop();
    const a = zonedParts(from, tz);
    const b = to ? zonedParts(to, tz) : a;
    this.rw = { tz, y0: a.y, y1: b.y, place, placeOn: false, last: now(), to: b };
    el.rewind?.classList.add('on');
    el.rewind?.setAttribute('aria-hidden', 'false');
    el.rwMain.style.cssText = '';
    el.rwMain.style.opacity = '1';
    el.card.classList.remove('on', 'guest');
    el.card.textContent = '';
    if (this.odo) {
      this.odo.measure();
      this.odo.slow = false;
      this.odo.jump(a.y, a.m, a.d);
    }
    this._sub(sub, true);
    clearTimeout(this._skipT);
    if (el.skip) {
      el.skip.hidden = !skippable;
      el.skip.classList.remove('on');
      if (skippable) this._skipT = setTimeout(() => el.skip.classList.add('on'), 1500);
    }
  }

  _sub(text, instant = false) {
    const a = this.el.subA, b = this.el.subB;
    if (!a || !b) return;
    const [cur, nxt] = a.classList.contains('on') ? [a, b] : [b, a];
    if (instant) {
      cur.classList.remove('on');
      [a, b].forEach((x) => { x.style.transition = 'none'; });
      a.textContent = text; b.textContent = '';
      a.classList.add('on'); b.classList.remove('on');
      void a.offsetWidth;
      [a, b].forEach((x) => { x.style.transition = ''; });
      return;
    }
    if (cur.textContent === text) return;
    nxt.textContent = text;
    cur.classList.remove('on');
    nxt.classList.add('on');
  }

  rewindFrame(moment, u) {
    const r = this.rw;
    if (!r || !this.odo) return;
    const t = now();
    const dt = clamp((t - r.last) / 1000, 0, 0.05);
    r.last = t;
    const uu = clamp(u, 0, 1);
    const b = B_REWIND(uu);
    const p = zonedParts(moment, r.tz);
    this.odo.year(r.y1 + (r.y0 - r.y1) * (1 - b));
    this.odo.slow = uu > 1 - 450 / 6400;
    this.odo.target(p.m, p.d);
    this.odo.step(dt);
    if (!r.placeOn && uu >= 0.72 && r.place) { r.placeOn = true; this._sub(r.place); }
  }

  // ------------------------------------------------------------------------------------ S5 arrival
  arrive({ sub = '', title = T.arrive.titleOwn, guest = false } = {}) {
    const el = this.el, r = this.rw;
    clearTimeout(this._skipT);
    if (el.skip) el.skip.classList.remove('on');
    if (r && this.odo) {
      this.odo.year(r.y1);
      this.odo.target(r.to.m, r.to.d);
      this.odo.label(r.y1, r.to.m, r.to.d);
      this.odo.settle();
    }
    this._arr.push(setTimeout(() => this._sub(sub), 300));
    this._arr.push(setTimeout(() => this.titleCard(title, { guest }), 1200));
  }

  titleCard(text, { guest = false } = {}) {
    const c = this.el.card;
    if (!c) return;
    if (!text) { c.classList.remove('on'); return; }
    c.textContent = text;
    c.classList.toggle('guest', !!guest);
    void c.offsetWidth;
    c.classList.add('on');
  }

  counter(show) {
    const m = this.el.rwMain;
    if (!m) return;
    m.style.transition = `opacity ${show ? 560 : 420}ms ${show ? E.enter : E.exit}`;
    m.style.opacity = show ? '1' : '0';
  }

  land({ meta, time } = {}) {
    const el = this.el;
    this._arr.forEach(clearTimeout);
    this._arr = [];
    this._holdMeta = true; // the meta line appears only when the counter block arrives in its slot
    this.titleCard(null);
    if (meta) this.meta(meta, time);
    this.scene('sky');
    // the meta line is laid out (hidden) so the counter block can fly to it
    const mi = el.meta?.querySelector('.mi');
    const odo = el.odo, main = el.rwMain;
    if (!mi || !odo || !main || reduced()) {
      this._holdMeta = false;
      this._fx(el.meta, true, { inMs: 420 });
      this.layer(el.rewind, false);
      return wait(420);
    }
    const from = odo.getBoundingClientRect(), to = mi.getBoundingClientRect(), box = main.getBoundingClientRect();
    const s = clamp(to.height / Math.max(1, from.height), 0.2, 1);
    const ox = from.left + from.width / 2 - box.left, oy = from.top + from.height / 2 - box.top;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
    main.style.transformOrigin = `${ox}px ${oy}px`;
    main.style.transition = `transform 700ms ${E.enter}, opacity 400ms ${E.fade} 300ms`;
    void main.offsetWidth;
    main.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0) scale(${s.toFixed(4)})`;
    main.style.opacity = '0';
    return new Promise((resolve) => {
      this._landDone = resolve;
      this._arr.push(setTimeout(() => {
        this._holdMeta = false;
        el.meta.style.transition = `opacity 400ms ${E.fade}, visibility 0s`;
        this._fx(el.meta, true, { inMs: 400 });
      }, 300));
      this._arr.push(setTimeout(() => this._landEnd(), 700));
    });
  }

  _landEnd() {
    const el = this.el;
    el.rewind?.classList.remove('on');
    el.rewind?.setAttribute('aria-hidden', 'true');
    el.rwMain.style.cssText = '';
    if (el.meta) el.meta.style.transition = '';
    this.odo?.stop();
    const done = this._landDone;
    this._landDone = null;
    done?.();
  }

  /** A tap during the title card: card out, meta line in place, no flight. */
  skipArrival({ meta, time } = {}) {
    const el = this.el;
    this._arr.forEach(clearTimeout);
    this._arr = [];
    this._holdMeta = false;
    if (meta) this.meta(meta, time);
    this.scene('sky');
    el.card?.classList.remove('on');
    el.rwMain.style.transition = `opacity 420ms ${E.exit}`;
    el.rwMain.style.opacity = '0';
    this._fx(el.meta, true, { inMs: 420 });
    this._arr.push(setTimeout(() => this._landEnd(), 420));
  }

  rewindEnd() {
    this._arr.forEach(clearTimeout);
    this._arr = [];
    this._holdMeta = false;
    this._landEnd();
  }

  // ------------------------------------------------------------------------------------ S6 / S7 slots
  meta(text, timeText) {
    const m = this.el.meta;
    if (!m) return;
    const s = String(text ?? '');
    const i = timeText ? s.lastIndexOf(timeText) : -1;
    const body = i < 0 ? esc(s)
      : `${esc(s.slice(0, i))}<button class="tw" type="button">${esc(timeText)}</button>${esc(s.slice(i + timeText.length))}`;
    m.innerHTML = `<span class="mi">${body}</span>`;
    const tw = m.querySelector('.tw');
    if (tw) press(tw);
    const mi = m.querySelector('.mi');
    mi?.addEventListener('click', (e) => { if (!e.target.closest('.tw')) this.emit('summary'); });
    this.st.metaSet = !!s;
    this._sync();
  }

  summary(text) {
    if (this.el.summary) this.el.summary.textContent = text || '';
    this.st.summarySet = !!text;
    this._sync();
  }

  caption(text, { acts = null, key = null, transient = false, ms, dropOnDrag = false, sticky = false, enter = false } = {}) {
    const seq = ++this._capSeq;
    const el = this.el;
    const t = el.capText;
    if (!t) return Promise.resolve(false);
    const wasShown = this.st.capActive && t.textContent && !this.st.capHidden;
    this.st.capActive = true;
    this.st.capHidden = false; // a caption set on purpose is meant to be read
    this.st.capSticky = sticky;
    this._sync();
    const run = async () => {
      if (wasShown) {
        t.style.transition = `opacity 360ms ${E.exit}`;
        t.style.opacity = '0';
        el.capActs.style.transition = `opacity 360ms ${E.exit}`;
        el.capActs.style.opacity = '0';
        await wait(360 + 120);
        if (seq !== this._capSeq) return false;
      }
      this._capKey = key;
      this._capDrop = dropOnDrag;
      t.innerHTML = this._subtitle(text);
      this._acts(acts);
      const inMs = enter ? 560 : 620, rise = reduced() ? 0 : 6;
      for (const x of [t, el.capActs]) {
        x.style.transition = 'none';
        x.style.opacity = '0';
        x.style.transform = `translate3d(0,${rise}px,0)`;
        void x.offsetWidth;
        x.style.transition = `opacity ${inMs}ms ${E.enter}, transform ${inMs}ms ${E.enter}`;
        x.style.opacity = '1';
        x.style.transform = 'none';
      }
      if (!transient) return true;
      await wait(inMs + (ms ?? hintDwell(text)));
      if (seq !== this._capSeq) return false;
      await this._capOut(500);
      return seq === this._capSeq;
    };
    return run();
  }

  /**
   * Subtitle line breaks: when a caption needs more than one line, break it after a clause mark (，；：。！？、)
   * so that the longest line is as short as possible (two or three lines); otherwise the normal no-widow wrap.
   */
  _subtitle(text) {
    const t = this.el.capText;
    const s = String(text ?? '');
    if (!t || s.includes('\n')) return noWidow(s);
    const maxW = (t.clientWidth || t.parentElement?.clientWidth || 0) - 1;
    if (maxW <= 0) return noWidow(s);
    const cs = getComputedStyle(t);
    const ctx = this._mctx || (this._mctx = document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const ls = parseFloat(cs.letterSpacing) || 0;
    const width = (x) => ctx.measureText(x).width + ls * Array.from(x).length;
    if (width(s) <= maxW) return noWidow(s);
    const cuts = [];
    for (let i = 1; i < s.length - 1; i++) if ('，；：。！？、'.includes(s[i - 1]) && !'，；：。！？、”」）'.includes(s[i])) cuts.push(i);
    const seg = (a, b) => s.slice(a, b).trim();
    let best = null;
    for (const k of cuts) {
      const m = Math.max(width(seg(0, k)), width(seg(k)));
      if (m <= maxW && (!best || m < best.m)) best = { m, at: [k] };
    }
    if (!best) {
      for (let i = 0; i < cuts.length; i++) {
        for (let j = i + 1; j < cuts.length; j++) {
          const m = Math.max(width(seg(0, cuts[i])), width(seg(cuts[i], cuts[j])), width(seg(cuts[j])));
          if (m <= maxW && (!best || m < best.m)) best = { m, at: [cuts[i], cuts[j]] };
        }
      }
    }
    if (!best) return noWidow(s);
    const pts = [0, ...best.at, s.length];
    return noWidow(pts.slice(1).map((b, i) => seg(pts[i], b)).join('\n'));
  }

  captionActs(acts) {
    const a = this.el.capActs;
    if (!a) return;
    a.style.transition = `opacity 240ms ${E.exit}`;
    a.style.opacity = '0';
    setTimeout(() => {
      this._acts(acts);
      a.style.transition = `opacity 420ms ${E.enter}`;
      a.style.opacity = '1';
    }, 240);
  }

  _acts(acts) {
    const a = this.el.capActs;
    if (!a) return;
    a.innerHTML = (acts || []).map((x) => `<button class="tbtn${x.strong ? ' strong' : ''}" type="button" data-act="${esc(x.key)}">${esc(x.label)}</button>`).join('');
    press($$('.tbtn', a));
  }

  async _capOut(ms = 420) {
    const t = this.el.capText, a = this.el.capActs;
    for (const x of [t, a]) {
      if (!x) continue;
      x.style.transition = `opacity ${ms}ms ${E.exit}`;
      x.style.opacity = '0';
    }
    const seq = this._capSeq;
    await wait(ms);
    if (seq !== this._capSeq) return;
    this.st.capActive = false;
    this.st.capSticky = false;
    this._capKey = null;
    if (t) t.textContent = '';
    if (a) a.innerHTML = '';
    this._sync();
  }

  clearCaption(ms = 420) {
    ++this._capSeq;
    return this._capOut(ms);
  }

  get captionKey() { return this.st.capActive ? this._capKey : null; }

  guestInvite(name) {
    return this.caption(T.guest.invite, {
      key: 'guest-invite', dropOnDrag: true, sticky: true,
      acts: [{ key: 'mine', label: T.guest.mine, strong: true }, { key: 'together', label: T.guest.together(name) }],
    });
  }

  actions(variant = 'own', { active = null } = {}) {
    const nav = this.el.actions;
    if (!nav) return;
    this.st.variant = variant;
    const A = T.chrome.actions, PO = T.pair.actionsOwn, PG = T.pair.actionsGuest;
    const sets = {
      own: [['listen', A.listen], ['keep', A.keep], ['pair', A.pair], ['gift', T.gift.action], ['share', A.share]],
      guest: [['mine', A.mine, true], ['pair', A.pair], ['listen', A.listen], ['keep', A.keep], ['share', A.share]],
      'pair-own': [['keep', PO.keep], ['send', PO.send], ['again', PO.again], ['mine', PO.mine]],
      'pair-guest': [['keep', PG.keep], ['share', PG.share], ['try', PG.tryIt], ['mine', PG.mine]],
    };
    const list = sets[variant];
    if (list) {
      nav.dataset.variant = variant;
      nav.innerHTML = list.map(([k, label, strong]) => {
        const ic = ACTION_ICON[k];
        return ic
          ? `<button class="aw ic" id="a-${k}" data-a="${k}" type="button" aria-label="${esc(label)}">${ICON[ic]}<span class="aw-l" aria-hidden="true">${esc(label)}</span></button>`
          : `<button class="aw${strong ? ' strong' : ''}" id="a-${k}" data-a="${k}" type="button">${esc(label)}</button>`;
      }).join('');
      press($$('.aw', nav));
    }
    this.st.listen = variant === 'listen';
    this.setActive(active);
    this._sync();
  }

  /** The words under the icons, once (first landing), fading out after ~3 s. */
  iconLabels() {
    const nav = this.el.actions;
    if (!nav || store.get(LABELS_SEEN) === '1') return;
    store.set(LABELS_SEEN, '1');
    nav.classList.add('show-l');
    setTimeout(() => nav.classList.remove('show-l'), 3200);
  }

  /** The tip (收款码) on the ground: shown with the chrome on the still sky only. */
  tip(on) { this.st.tip = !!on; this._sync(); }

  setActive(key) {
    for (const b of $$('.aw', this.el.actions)) b.classList.toggle('is-active', !!key && b.dataset.a === key);
  }

  toggles({ culture, sound, gyro } = {}) {
    const { tCulture, tSound, tGyro } = this.el;
    if (culture !== undefined && tCulture) {
      tCulture.textContent = CULTURE_BADGE[culture] || CULTURE_BADGE.cn;
      tCulture.setAttribute('aria-label', T.chrome.culture[culture] || T.chrome.culture.cn);
      tCulture.classList.add('badge');
      tCulture.classList.toggle('off', culture === 'none');
      tCulture.dataset.value = culture;
    }
    if (sound !== undefined && tSound) {
      tSound.innerHTML = sound ? ICON.soundOn : ICON.soundOff;
      tSound.setAttribute('aria-label', sound ? T.chrome.sound.on : T.chrome.sound.off);
      tSound.classList.toggle('off', !sound);
    }
    if (gyro !== undefined && tGyro) {
      tGyro.hidden = gyro === null;
      tGyro.innerHTML = ICON.gyro;
      tGyro.setAttribute('aria-label', T.chrome.gyro);
      tGyro.classList.toggle('off', !gyro);
    }
  }

  /** 「静音」 brightens to α.9 once and settles back (S13 muted listen). */
  flashToggle(key = 'sound') {
    const b = { sound: this.el.tSound, culture: this.el.tCulture, gyro: this.el.tGyro }[key];
    if (!b) return;
    if (!this.st.chrome && SKYLIKE.has(this.st.scene)) this.showChrome();
    b.classList.add('flash');
    clearTimeout(b._flashT);
    b._flashT = setTimeout(() => { b.style.transition = `opacity 600ms ${E.fade}`; b.classList.remove('flash'); setTimeout(() => { b.style.transition = ''; }, 620); }, 400);
  }

  // ------------------------------------------------------------------------------------ chrome idle manager
  showChrome({ first = false } = {}) {
    const st = this.st;
    st.chrome = true;
    st.hiddenBy = null;
    st.capHidden = false;
    st.idle = 0;
    this._sync(first ? { inMs: 560, stagger: 90, rise: 8 } : { inMs: 320, stagger: 0, rise: 6 });
    this._scrim(first ? 560 : 320, E.enter);
    this.emit('chrome', true);
  }

  hideChrome(reason = 'idle') {
    const st = this.st;
    if (!st.chrome) { if (reason === 'idle' || reason === 'tap') st.capHidden = true; this._sync(); return; }
    st.chrome = false;
    st.hiddenBy = reason;
    if (reason === 'idle' || reason === 'tap') st.capHidden = true;
    const t = reason === 'idle' ? { out: 1200, outEase: E.fade } : reason === 'drag' ? { out: 240, outEase: E.exit } : { out: 420, outEase: E.exit };
    this._sync(t);
    this._scrim(t.out, t.outEase);
    this.emit('chrome', false);
    if (reason === 'idle' && !st.firstIdle) {
      st.firstIdle = true;
      setTimeout(() => { if (!this.st.chrome && SKYLIKE.has(this.st.scene)) hint('chromeBack', T.hint.chromeBack); }, 3000);
    }
  }

  suspend(key, on = true) {
    if (on) this.st.suspend.add(key); else this.st.suspend.delete(key);
    this.st.idle = 0;
  }

  touched() {
    if (this.st.touched) return;
    this.st.touched = true;
    store.set(TOUCHED, '1');
  }

  pointerDown() {
    const st = this.st;
    st.chromeAtDown = st.chrome;
    st.finger = true;
    st.idle = 0;
    st.stillT = 0;
    if (SKYLIKE.has(st.scene)) {
      this._touchedHere = true;
      this.touched();
      markHint('look');
    }
  }

  dragStart() {
    const st = this.st;
    if (!SKYLIKE.has(st.scene) && st.scene !== 'pair') return;
    if (st.chrome && st.scene !== 'pair') this.hideChrome('drag');
    st.capDim = true;
    if (this._capDrop && st.capActive) this.clearCaption(240);
    this._sync();
  }

  pointerUp() {
    const st = this.st;
    st.finger = false;
    st.stillT = 0;
    clearTimeout(this._dimT);
    this._dimT = setTimeout(() => { st.capDim = false; this._sync({ inMs: 420 }); }, 400);
  }

  tapSky() {
    const st = this.st;
    if (st.strip) { this.strip(null); this.emit('strip-close', { reason: 'tap' }); return 'strip'; }
    if (!SKYLIKE.has(st.scene)) return 'none';
    const wasOn = st.finger ? st.chromeAtDown : (st.hiddenBy === 'drag' ? true : st.chrome);
    st.capDim = false;
    if (wasOn) { this.hideChrome('tap'); return 'hide'; }
    this.showChrome();
    return 'show';
  }

  frame({ dt, settled = true, cam = null } = {}) {
    const st = this.st;
    const t = now();
    if (dt === undefined) dt = this._lastF ? Math.min(0.1, (t - this._lastF) / 1000) : 0.016;
    this._lastF = t;
    st.stillT = settled && !st.finger ? st.stillT + dt : 0;
    if (!st.chrome && st.hiddenBy === 'drag' && !st.finger && st.stillT >= 0.6 && SKYLIKE.has(st.scene)) this.showChrome();
    if (st.chrome && st.touched && !st.finger && !st.suspend.size && !st.plate && st.scene === 'sky') {
      st.idle += dt;
      if (st.idle >= 8) this.hideChrome('idle');
    }
    if (st.strip && !st.finger) {
      st.stripIdle += dt;
      if (st.stripIdle >= 12) { this.strip(null); this.emit('strip-close', { reason: 'idle' }); }
    }
    if (cam) {
      this._adapt(cam);
      this._tags(dt, cam);
    }
  }

  /** One-time hints of S6: the look hint after 8 s without a touch, the tour hint after the hero dwell. */
  restHints({ heroText = '' } = {}) {
    clearTimeout(this._lookT);
    clearTimeout(this._tourT);
    this._touchedHere = false;
    const capSeq = this._capSeq;
    this._lookT = setTimeout(() => { if (!this._touchedHere && this.st.scene === 'sky') hint('look', T.hint.look); }, 8000);
    const dwell = heroText ? hintDwell(heroText) : 6000;
    this._tourT = setTimeout(() => {
      if (this._capSeq === capSeq && this.st.capActive && this.st.scene === 'sky') hint('tour', T.hint.tour);
    }, dwell + 1200);
  }

  // which stage slot shows (spec §2.3 / S6–S8): one place decides
  _sync(t = {}) {
    const st = this.st, el = this.el, sc = st.scene;
    const sky = sc === 'sky', listen = sc === 'listen', pair = sc === 'pair';
    const chromeOn = st.chrome && (sky || listen);
    const capOn = sky && st.capActive && (!st.capHidden || st.capSticky) && !st.strip && !st.plate;
    const vis = [
      [el.capWrap, capOn, 0],
      [el.summarySlot, sky && chromeOn && st.summarySet, 0],
      [el.actions, (sky && chromeOn && !st.listen) || (pair && !st.strip), 1],
      [el.listen, listen || (sky && st.listen), 1],
      [el.toggles, chromeOn, 2],
      [el.scrimT, chromeOn, 2],
      [el.strip, (sky || pair || listen) && !!st.strip, 0],
      [el.meta, (sky || listen) && st.metaSet, 0],
      [el.tip, sky && chromeOn && !st.listen && !st.strip && !st.plate && !!st.tip && st.variant === 'own', 1],
    ];
    const hidden = st.variant === 'none' || st.variant === 'ruler';
    for (const [node, on0, i] of vis) {
      if (!node) continue;
      let on = on0;
      if (node === el.actions && hidden) on = false;
      if (node === el.meta) {
        if (!this._holdMeta) this._fx(node, on, { out: t.out ?? 420, outEase: t.outEase });
        node.classList.toggle('hi', chromeOn);
        continue;
      }
      this._fx(node, on, {
        inMs: t.inMs ?? (node === el.strip ? 700 : 560), out: t.out ?? (node === el.strip ? 420 : 420), outEase: t.outEase,
        delay: on ? (t.stagger || 0) * i : 0, rise: t.rise,
      });
    }
    el.capWrap?.classList.toggle('dim', st.capDim && capOn);
    el.app?.classList.toggle('strip-open', !!st.strip);
  }

  // bottom scrim: 18vh at .6 at rest, 30vh at 1.0 with chrome; opacity → 1 as the ridge leaves the screen
  _scrim(ms = 420, easing = E.exit) {
    const st = this.st, sc = st.scene, app = this.el.app;
    if (!app) return;
    const mode = ({ intro: 'rest', form: 'off', rewind: 'full', ruler: 'full', pair: 'full', 'pair-invite': 'off', keep: 'off', result: 'off', fallback: 'off' })[sc]
      || (st.chrome || st.strip ? 'full' : 'rest');
    if (mode === st.scrim && ms === this._scrimMs) return;
    st.scrim = mode;
    this._scrimMs = ms;
    this.el.scrimB?.style.setProperty('--sc-t', `${ms}ms`);
    this.el.scrimB?.style.setProperty('--sc-e', easing);
    if (mode !== 'rest') st.adapt = -1;
    app.dataset.scrim = mode;
    this._scrimAlpha();
  }

  // opacity = max(mode base, adaptive) — computed here rather than with CSS max() for older WebKit
  _scrimAlpha() {
    const st = this.st;
    const base = { rest: 0.6, full: 1, off: 0 }[st.scrim] ?? 0.6;
    const a = st.scrim === 'rest' ? Math.max(base, st.adapt) : base;
    this.el.scrimB?.style.setProperty('--sa', a.toFixed(3));
  }

  _adapt(cam) {
    const st = this.st;
    if (st.scrim !== 'rest' || !SKYLIKE.has(st.scene)) return;
    const a = (cam.az || 0) * Math.PI / 180;
    const p = cam.project([Math.cos(a), Math.sin(a), 0], this._tmp);
    const H = cam.h || this.H;
    const k = p ? smooth(H * 0.86, H * 1.0, p.y) : 1;
    if (Math.abs(k - st.adapt) < 0.02 && !(k === 1 && st.adapt !== 1) && !(k === 0 && st.adapt !== 0)) return;
    st.adapt = k;
    this._scrimAlpha();
  }

  // ------------------------------------------------------------------------------------ S9 tags
  setTags(list) {
    this._tagCands = Array.isArray(list) ? list : [];
    const keys = new Set(this._tagCands.map((c) => c.key));
    for (const k of this._tagState.keys()) if (!keys.has(k)) this._tagState.delete(k);
  }

  _tags(dt, cam) {
    const W = cam.w, H = cam.h, cx = cam.cx ?? W / 2, cy = cam.cy ?? H / 2;
    const allowed = this.st.scene === 'sky' && !this.st.plate;
    const out = [];
    for (const c of this._tagCands) {
      const p = cam.project(c.n, {});
      const dx = p ? Math.abs(p.x - cx) : Infinity, dy = p ? Math.abs(p.y - cy) : Infinity;
      const in30 = dx < 0.15 * W && dy < 0.15 * H;
      const in40 = dx < 0.2 * W && dy < 0.2 * H;
      let s = this._tagState.get(c.key);
      if (!s) { s = { a: 0, on: false, away: 0 }; this._tagState.set(c.key, s); }
      if (!allowed) s.on = false;
      else if (!s.on && in30 && this.st.stillT >= 0.8) { s.on = true; s.away = 0; }
      else if (s.on) {
        if (!in40) { s.away += dt; if (s.away >= 0.6) s.on = false; } else s.away = 0;
      }
      s.a = clamp(s.a + (s.on ? 1 : -1) * dt / 0.4, 0, 1);
      if (s.a > 0 && p) out.push({ key: c.key, n: c.n, text: c.text, target: c.target, alpha: s.a * s.a * (3 - 2 * s.a), x: p.x, y: p.y });
    }
    this.tags = out;
  }

  uiRects() {
    const list = [];
    const add = (node) => {
      if (!node) return;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) list.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    const on = (n) => n && n.classList.contains('on');
    if (on(this.el.capWrap)) add(this.el.capText);
    if (on(this.el.capWrap) && this.el.capActs?.childElementCount) add(this.el.capActs);
    if (on(this.el.summarySlot)) add(this.el.summary);
    if (on(this.el.meta)) add(this.el.meta.querySelector('.mi'));
    if (on(this.el.actions)) add(this.el.actions);
    if (on(this.el.listen)) add(this.el.listen);
    if (on(this.el.toggles)) add(this.el.toggles);
    if (on(this.el.strip)) add(this.el.stripIn);
    if (this.el.hintSlot?.textContent) add(this.el.hintSlot.firstElementChild || this.el.hintSlot);
    if (this.st.scene === 'pair') { add(this.el.pairBlock); add(this.el.pairWhere); add(this.el.pairSwitch); }
    return list;
  }

  // ------------------------------------------------------------------------------------ S11 name strip
  strip(d) {
    const st = this.st, el = this.el;
    if (!el.strip) return;
    clearTimeout(this._stripT);
    if (!d) {
      if (!st.strip) return;
      st.strip = null;
      this._sync({ out: 420 });
      this._scrim();
      if (st.chromeBeforeStrip && SKYLIKE.has(st.scene)) this.showChrome();
      st.chromeBeforeStrip = false;
      return;
    }
    st.stripIdle = 0;
    const fill = () => {
      el.sName.textContent = d.name || '';
      el.sLatin.textContent = d.latin || '';
      el.sMeta.textContent = d.meta || '';
      el.sStory.innerHTML = noWidow(d.story || '');
    };
    if (st.strip) {
      const inn = el.stripIn;
      inn.classList.remove('is-in');
      inn.classList.add('is-out');
      this._stripT = setTimeout(() => { fill(); inn.classList.remove('is-out'); inn.classList.add('is-in'); }, 500);
      st.strip = d;
      return;
    }
    fill();
    el.stripIn.classList.remove('is-out', 'is-in');
    st.chromeBeforeStrip = st.chrome;
    st.strip = d;
    if (st.chrome) {
      st.chrome = false;
      st.hiddenBy = 'strip';
      this.emit('chrome', false);
    }
    this._sync({ out: 420 });
    this._scrim(560, E.enter);
  }

  // ------------------------------------------------------------------------------------ S10 / S20 plate
  openNight({ title = T.night.title, meta = '', rows = [], note = '', poem = null } = {}) {
    this._rows = rows;
    this._poem = poem;
    const el = this.el;
    el.plate.dataset.kind = 'night';
    el.plateTitle.textContent = title;
    el.plateMeta.textContent = meta;
    el.rows.innerHTML = (poem ? this._poemRow(poem) : '') + rows.map((r, i) => `
      <div class="pr" data-key="${esc(r.key)}">
        <p class="pr-label">${esc(r.label)}</p>
        <div class="pr-val">
          <p class="pr-text">${noWidow(r.text)}</p>
          ${r.meta || r.action ? `<div class="pr-foot"><p class="pr-sub">${noWidow(r.meta || '')}</p>${r.action ? `<button class="pr-act" type="button" data-look="${i}">${esc(r.action)}</button>` : ''}</div>` : ''}
        </div>
      </div>`).join('');
    el.note.hidden = !note;
    el.note.textContent = note || '';
    el.nightSlot.innerHTML = slotHtml('night');
    activateSlots(el.nightSlot);
    this._colophon();
    press($$('.pr-act', el.rows));
    this._openPlate('night');
  }

  _poemRow(p) {
    const lines = (p.lines || []).map((l) => noWidow(l)).join('<br>');
    const subs = [p.attribution, p.regional && p.place ? C.poemPlace(p.place) : '', p.count || ''].filter(Boolean);
    return `
      <div class="pr pr-poemrow" data-key="poem">
        <p class="pr-label">${esc(C.poemLabel)}</p>
        <div class="pr-val">
          <p class="pr-text pr-poem">${lines}</p>
          <div class="pr-foot"><p class="pr-sub">${subs.map((x) => noWidow(x)).join('<br>')}</p><button class="pr-act" type="button" data-poem>${esc(C.poemNext)}</button></div>
        </div>
      </div>`;
  }

  /** Replace the 诗 row (after 换一首). */
  nightPoem(poem) {
    this._poem = poem;
    const row = this.el.rows?.querySelector('.pr-poemrow');
    if (!row || !poem) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this._poemRow(poem);
    const next = tmp.firstElementChild;
    next.style.opacity = '0';
    row.replaceWith(next);
    press($$('.pr-act', next));
    void next.offsetWidth;
    next.style.transition = `opacity 420ms ${E.enter}`;
    next.style.opacity = '1';
  }

  _colophon() {
    const A = T.about;
    const privacy = A.sections.map(([label, body]) => {
      const an = CONFIG.analytics || {};
      const line = an.provider === 'busuanzi' ? T.about.analyticsBusuanzi
        : (an.provider === 'baidu' && !!an.baidu?.id) || (an.provider === 'umami' && !!an.umami?.src && !!an.umami?.websiteId) ? C.analytics : '';
      const extra = label === '隐私' ? line : '';
      return `<div class="co-sec"><p class="co-label">${esc(label)}</p><p class="co-body">${noWidow(body + extra)}</p></div>`;
    }).join('');
    const data = `<div class="co-sec"><p class="co-label">${esc(A.dataLabel)}</p><div class="co-data">${A.data.map(([n, l]) => `<p class="dn">${esc(n)}</p><p class="dl">${esc(l)}</p>`).join('')}</div></div>`;
    this.el.colophon.innerHTML = `<p class="co-intro">${noWidow(A.intro)}</p>${privacy}${data}`;
  }

  openAbout() {
    const el = this.el;
    el.plate.dataset.kind = 'about';
    el.plateTitle.textContent = T.about.title;
    el.plateMeta.textContent = '';
    el.rows.innerHTML = '';
    el.note.hidden = true;
    el.nightSlot.innerHTML = '';
    this._colophon();
    this._openPlate('about');
  }

  _openPlate(kind) {
    const el = this.el;
    this.st.plate = kind;
    this.suspend('plate', true);
    el.app?.classList.add('plate-open');
    el.plate.style.setProperty('--drag', '0px');
    el.plateBody.scrollTop = 0;
    el.plateBody.classList.remove('is-scrolled');
    void el.plate.offsetWidth;
    el.plate.classList.add('on');
    el.plate.setAttribute('aria-hidden', 'false');
    this._sync({ out: 420 });
    this.emit('exposure', { value: 0.55, ms: 900 });
    this.emit('plate', { kind, open: true });
  }

  closePlate() {
    const el = this.el, kind = this.st.plate;
    if (!kind) return;
    this.st.plate = null;
    this.suspend('plate', false);
    el.app?.classList.remove('plate-open');
    el.plate.style.setProperty('--drag', '0px');
    el.plate.classList.remove('on');
    el.plate.setAttribute('aria-hidden', 'true');
    this._sync({ inMs: 420 });
    this.emit('exposure', { value: 1, ms: 900 });
    this.emit('plate', { kind, open: false });
  }

  // ------------------------------------------------------------------------------------ S13 listen
  listen(on) {
    if (on) {
      this._preListen = this.st.variant;
      this.scene('listen');
      this.actions('listen');
    } else {
      this.actions(this._preListen && this._preListen !== 'listen' ? this._preListen : 'own');
      this.scene('sky');
    }
  }

  // ------------------------------------------------------------------------------------ S16 / S17
  pairInvite(on) {
    const el = this.el;
    if (on) {
      const body = document.getElementById('pi-body');
      if (body) body.innerHTML = noWidow(T.pairInvite.body);
      for (const [id, k] of [['pi-title', 'title'], ['pi-manual', 'manual'], ['pi-cancel', 'cancel']]) {
        const e = document.getElementById(id); if (e && T.pairInvite[k]) e.textContent = T.pairInvite[k];
      }
      const send = document.querySelector('#pi-send .lbl'); if (send) send.textContent = T.pairInvite.send;
      if (this.st.chrome) this.hideChrome('mode');
      this.scene('pair-invite');
      this.layer(el.pairInvite, true);
      this.emit('exposure', { value: 0.5, ms: 900 });
      return;
    }
    if (this.st.scene !== 'pair-invite') return;
    this.layer(el.pairInvite, false);
    this.scene('sky');
    this.emit('exposure', { value: 1, ms: 900 });
    this.showChrome();
  }

  pairText({ where = '', switchLabel = '', dates = [], headline = '', count = null, lines = [], definition = '', animate = true } = {}) {
    const el = this.el;
    clearTimeout(this._pairT);
    cancelAnimationFrame(this._countRaf);
    this.scene('pair');
    this.actions(this.st.variant?.startsWith('pair') ? this.st.variant : 'pair-own');
    el.pairWhere.textContent = where;
    el.pairSwitch.textContent = switchLabel;
    el.pairSwitch.hidden = !switchLabel;
    el.pDates.innerHTML = dates.map((d) => `<p>${esc(d)}</p>`).join('');
    const num = count == null ? '' : fmtCount(count);
    const at = num ? headline.indexOf(num) : -1;
    el.pHead.innerHTML = at < 0 ? noWidow(headline)
      : `${esc(headline.slice(0, at))}<span class="p-count">${esc(num)}</span>${noWidow(headline.slice(at + num.length))}`;
    el.pLines.innerHTML = lines.map((l) => `<p>${noWidow(l)}</p>`).join('');
    el.pDef.innerHTML = noWidow(definition);
    el.pairSlot.innerHTML = slotHtml('pair');
    activateSlots(el.pairSlot);
    el.pairBlock.scrollTop = 0;
    const ps = $$('p', el.pLines);
    for (const x of [el.pDates, el.pHead, el.pDef, ...ps]) x.classList.remove('on');
    this.layer(el.pair, true);
    const quick = !animate || reduced();
    return new Promise((resolve) => {
      const show = (x) => { void x.offsetWidth; x.classList.add('on'); };
      show(el.pDates);
      show(el.pHead);
      const cnt = el.pHead.querySelector('.p-count');
      if (cnt && !quick) {
        const t0 = now();
        const tick = () => {
          const k = clamp((now() - t0) / 1600, 0, 1);
          cnt.textContent = fmtCount(count * (1 - (1 - k) ** 4));
          if (k < 1) this._countRaf = requestAnimationFrame(tick);
        };
        cnt.textContent = '0';
        tick();
      }
      const steps = [...ps, el.pDef];
      let i = 0;
      const next = () => {
        if (i >= steps.length) { resolve(); return; }
        show(steps[i++]);
        this._pairT = setTimeout(next, quick ? 0 : 500);
      };
      this._pairT = setTimeout(next, quick ? 0 : 1600);
    });
  }

  pairSwitchLabel(text) { if (this.el.pairSwitch) this.el.pairSwitch.textContent = text; }

  pairClear() {
    clearTimeout(this._pairT);
    cancelAnimationFrame(this._countRaf);
    return this.layer(this.el.pair, false);
  }

  // ------------------------------------------------------------------------------------ S14 frame sizing
  keepFrame(format = 'wallpaper', aspect) {
    const W = this.W, H = this.H, { top: st, bottom: sb } = this.safe;
    // the wallpaper frame has the export's aspect: the device's own on phones, 1290 × 2796 by default on desktop
    const a = aspect || (W >= 960 || W > H ? 1290 / 2796 : W / H);
    this._keepFmt = format;
    this._keepAspect = aspect;
    const top = st + 60;
    // below the frame: 12 px, the note line (18), then the controls plate (8 + 3 × 44 + sb)
    const zoneBottom = H - sb - (H < 700 ? 180 : 172);
    const hMax = Math.max(160, zoneBottom - top);
    let w, h;
    if (format === 'card') {
      w = Math.min(342, W - 48); h = w * 4 / 3;
      if (h > hMax) { h = hMax; w = h * 3 / 4; }
    } else {
      h = hMax; w = h * a;
      if (w > W - 48) { w = W - 48; h = w / a; }
    }
    const x = (W - w) / 2, y = top + (hMax - h) / 2;
    const app = this.el.app;
    for (const [k, v] of [['kf-x', x], ['kf-y', y], ['kf-w', w], ['kf-h', h]]) app?.style.setProperty(`--${k}`, `${v.toFixed(1)}px`);
    const keep = document.getElementById('keep');
    if (keep) keep.dataset.format = format;
    return { x, y, w, h };
  }

  // ------------------------------------------------------------------------------------ cut, fallback
  async cut(mid, { out = 700, hold = 300, in: inn = 1400 } = {}) {
    const c = this.el.cut;
    if (!c) { await mid?.(); return; }
    c.style.visibility = 'visible';
    c.style.transition = `opacity ${out}ms ${E.fade}`;
    void c.offsetWidth;
    c.style.opacity = '1';
    await wait(out);
    try { await mid?.(); } catch (e) { console.error(e); }
    await wait(hold);
    c.style.transition = `opacity ${inn}ms ${E.fade}`;
    c.style.opacity = '0';
    await wait(inn);
    c.style.visibility = 'hidden';
  }

  fallback(kind = 'webgl') {
    const el = this.el;
    if (!el.fallback) return;
    el.fallbackText.innerHTML = noWidow(kind === 'catalog' ? T.fallback.catalog : T.fallback.webgl);
    el.fallback.hidden = false;
    el.fallback.onclick = kind === 'catalog' ? () => this.emit('retry') : null;
    this.scene('fallback');
  }
}
