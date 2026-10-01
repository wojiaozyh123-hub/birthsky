// S12 整夜 — the time ruler (spec §4 S12). A transform-only strip of ticks for birth ±6 h at 64 px per hour
// slides under a fixed centre index. Drag 1:1, fling (τ 0.35 s), rubber band at the ends, snap to the birth
// moment within ±4 min (ω 12) with a 6 ms vibration and one soft bell when crossing it, 播放这一夜 at 1 h per
// 2 s, 回到那一刻 on an ω 3 spring (it never jumps), daylight tinted between the true sunrise and sunset.
// The sky turns; the camera never moves.
//
// Public API
//   new Ruler(app = {})                  app.audio (bell), app.chrome (scene), both optional
//   ruler.open({ birth, tz, lat, lon, at, range, onTime, onClose, onBirth })
//       birth   Date of the birth moment; tz IANA zone of the birthplace; lat/lon for sunrise and sunset
//       at      Date to start at (default birth; e.g. the time chosen last time)
//       range   [minMinutes, maxMinutes] relative to birth, default [−360, 360] (D-16 may widen it)
//       onTime(date, minutes)            every change of the time value
//       onClose(date, minutes, reason)   'done' | 'idle' | 'sky' | 'api'
//       onBirth()                        crossing the birth tick (default: app.audio.bell(79, 0.12, …))
//   ruler.step(dt)                       from the frame loop: fling, springs, play, 6 s idle close
//   ruler.close(reason = 'api')          (a tap on the sky → close('sky'))
//   ruler.play(on?)                      toggles 播放这一夜 / 暂停
//   ruler.toBirth()                      回到那一刻
//   ruler.isOpen, ruler.minutes, ruler.date, ruler.sun → [{ kind: 'rise'|'set', t }]
//   rulerEvents(birth, lat, lon, min, max) → sunrise / sunset within the range (exported for tests)
import * as A from 'astronomy-engine';
import { $$, press, hint } from './ui.js';
import { T } from './copy.js';
import { ICON } from './icons.js';
import { zonedParts } from './astro.js';
import { FlingTracker, Spring } from './motion.js';

export const PX_PER_MIN = 64 / 60;
const FLING_TAU = 0.35, FLING_STOP = 2;   // min/s
const SNAP_WINDOW = 4;                     // ±4 min
const PLAY_RATE = 30;                      // 1 h per 2 s
const IDLE_CLOSE = 6;
const BAND = 0.35;
const pad = (n) => String(n).padStart(2, '0');
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Sunrise / sunset (upper limb, refraction) between birth + min and birth + max minutes; plus whether the Sun is up at the start. */
export function rulerEvents(birth, lat, lon, min = -360, max = 360) {
  const out = [];
  let upAtStart = false;
  try {
    const obs = new A.Observer(lat, lon, 0);
    const start = new Date(birth.getTime() + min * 60000);
    const end = new Date(birth.getTime() + max * 60000);
    const t0 = A.MakeTime(start);
    const eq = A.Equator(A.Body.Sun, t0, obs, true, true);
    upAtStart = A.Horizon(t0, obs, eq.ra, eq.dec, 'normal').altitude > -0.8333;
    for (const dir of [+1, -1]) {
      let from = start;
      for (let k = 0; k < 4; k++) {
        const days = (end.getTime() - from.getTime()) / 86400000;
        if (days <= 0) break;
        const r = A.SearchRiseSet(A.Body.Sun, obs, dir, from, days);
        if (!r || r.date > end) break;
        out.push({ kind: dir > 0 ? 'rise' : 'set', t: (r.date.getTime() - birth.getTime()) / 60000, date: r.date });
        from = new Date(r.date.getTime() + 60000);
      }
    }
  } catch { /* no sun data: no tint */ }
  out.sort((a, b) => a.t - b.t);
  return { events: out, upAtStart };
}

export class Ruler {
  constructor(app = {}) {
    this.app = app;
    const q = (id) => document.getElementById(id);
    this.el = { root: q('ruler'), time: q('r-time'), rel: q('r-rel'), band: q('r-band'), strip: q('r-strip'), play: q('r-play'), back: q('r-back'), done: q('r-done') };
    this.isOpen = false;
    this.t = 0;
    this.mode = 'idle';
    this.v = 0;
    this.spring = new Spring(0, { omega: 12 });
    this.tracker = new FlingTracker();
    this.idle = 0;
    this.lastTick = -1e9;
    this.sun = [];
    this._bind();
  }

  get minutes() { return this.t; }
  get date() { return this.birth ? new Date(this.birth.getTime() + this.t * 60000) : null; }

  open({ birth, tz, lat = 0, lon = 0, at = null, range = [-360, 360], onTime = null, onClose = null, onBirth = null } = {}) {
    this.birth = birth instanceof Date ? birth : new Date(birth);
    this.tz = tz || 'UTC';
    this.min = Math.min(range[0], 0);
    this.max = Math.max(range[1], 0);
    this.onTime = onTime;
    this.onClose = onClose;
    this.onBirth = onBirth;
    this.t = at ? clamp((new Date(at).getTime() - this.birth.getTime()) / 60000, this.min, this.max) : 0;
    this.mode = 'idle';
    this.v = 0;
    this.idle = 0;
    this._build(lat, lon);
    this._label = '';
    this._paint(true);
    this._playLabel(false);
    this.isOpen = true;
    this.app.chrome?.scene?.('ruler');
    this._show(true);
    hint('ruler', T.hint.ruler);
  }

  close(reason = 'api') {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.mode = 'idle';
    this._show(false);
    this.app.chrome?.scene?.('sky');
    this.onClose?.(this.date, this.t, reason);
  }

  _show(on) {
    const root = this.el.root;
    if (!root) return;
    clearTimeout(root._t);
    const kids = $$('.fx', root);
    if (on) {
      root.classList.add('on');
      root.setAttribute('aria-hidden', 'false');
      void root.offsetWidth;
      kids.forEach((k, i) => { k.style.setProperty('--delay', `${i * 90}ms`); k.classList.add('on'); });
    } else {
      kids.forEach((k) => { k.style.setProperty('--delay', '0ms'); k.classList.remove('on'); });
      root.setAttribute('aria-hidden', 'true');
      root._t = setTimeout(() => root.classList.remove('on'), 420);
    }
  }

  // ------------------------------------------------------------------------------------ the strip
  _build(lat, lon) {
    const { strip } = this.el;
    if (!strip) return;
    const bp = zonedParts(this.birth, this.tz);
    const bm = bp.hh * 60 + bp.mm + bp.s / 60;          // birth, local minutes of the day
    const x = (t) => ((t - this.min) * PX_PER_MIN).toFixed(2);
    const parts = [];
    // daylight between sunrise and sunset, with micro labels
    const { events, upAtStart } = rulerEvents(this.birth, lat, lon, this.min, this.max);
    this.sun = events;
    let up = upAtStart, from = this.min;
    for (const e of [...events, { kind: 'end', t: this.max }]) {
      if (up && e.t > from) parts.push(`<i class="day" style="left:${x(from)}px;width:${((e.t - from) * PX_PER_MIN).toFixed(2)}px"></i>`);
      if (e.kind === 'rise') { up = true; from = e.t; } else if (e.kind === 'set') { up = false; from = e.t; }
      if (e.kind !== 'end') {
        const z = zonedParts(e.date, this.tz);
        const label = (e.kind === 'rise' ? T.ruler.sunrise : T.ruler.sunset)(`${pad(z.hh)}:${pad(z.mm)}`);
        parts.push(`<span class="ml" style="left:${x(e.t)}px">${label}</span>`);
      }
    }
    // ticks at wall-clock multiples of 10 minutes; labels every 3 h counted from the birth hour
    const first = Math.ceil((bm + this.min) / 10) * 10 - bm;
    for (let t = first; t <= this.max + 1e-6; t += 10) {
      const clock = Math.round(bm + t);
      const mod = ((clock % 60) + 60) % 60;
      const cls = mod === 0 ? 'tk h60' : mod === 30 ? 'tk h30' : 'tk';
      parts.push(`<i class="${cls}" style="left:${x(t)}px"></i>`);
      if (mod === 0) {
        const h = ((Math.floor(clock / 60) % 24) + 24) % 24;
        if ((((h - bp.hh) % 3) + 3) % 3 === 0) parts.push(`<span class="lb" style="left:${x(t)}px">${pad(h)}:00</span>`);
      }
    }
    parts.push(`<i class="tk birth" style="left:${x(0)}px"></i><i class="dot" style="left:${x(0)}px"></i>`);
    strip.innerHTML = parts.join('');
    strip.style.width = `${((this.max - this.min) * PX_PER_MIN).toFixed(0)}px`;
  }

  _paint(force = false) {
    const { strip, band, time, rel, back } = this.el;
    if (!strip || !band) return;
    const W = band.clientWidth || innerWidth;
    strip.style.transform = `translate3d(${(W / 2 - (this.t - this.min) * PX_PER_MIN).toFixed(2)}px,0,0)`;
    const d = this.date;
    const z = zonedParts(d, this.tz);
    const hhmm = `${pad(z.hh)}:${pad(z.mm)}`;
    const r = Math.round(this.t);
    const label = `${hhmm}|${r}`;
    if (force || label !== this._label) {
      this._label = label;
      time.textContent = hhmm;
      rel.textContent = T.ruler.rel(r);
      band.setAttribute('aria-valuetext', `${hhmm} ${T.ruler.rel(r)}`);
    }
    back?.classList.toggle('away', Math.abs(this.t) >= 0.5);
  }

  _set(t) {
    const prev = this.t;
    this.t = t;
    if ((prev < 0 && t >= 0) || (prev > 0 && t <= 0)) this._birthTick();
    this._paint();
    this.onTime?.(this.date, this.t);
  }

  _birthTick() {
    const n = performance.now();
    if (n - this.lastTick < 250) return;
    this.lastTick = n;
    try { navigator.vibrate?.(6); } catch { /* not allowed */ }
    if (this.onBirth) this.onBirth();
    else this.app.audio?.bell?.(79, 0.12, 0, { bright: 0.2, decay: 3.2 });
  }

  // rubber band beyond the ends: displacement × 0.35
  _band(raw) {
    if (raw > this.max) return this.max + (raw - this.max) * BAND;
    if (raw < this.min) return this.min - (this.min - raw) * BAND;
    return raw;
  }

  // ------------------------------------------------------------------------------------ input
  _bind() {
    const { band, play, back, done } = this.el;
    press([play, back, done].filter(Boolean));
    play?.addEventListener('click', () => { this.idle = 0; this.play(); });
    back?.addEventListener('click', () => { this.idle = 0; this.toBirth(); });
    done?.addEventListener('click', () => this.close('done'));
    if (!band) return;
    let g = null;
    band.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      this.idle = 0;
      if (this.mode === 'play') this._playLabel(false);
      this.mode = 'drag';
      g = { id: e.pointerId, x0: e.clientX, t0: this.t, raw: this.t };
      try { band.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.tracker.reset();
      this.tracker.add(e.timeStamp || performance.now(), this.t, 0);
    });
    band.addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.id) return;
      g.raw = g.t0 - (e.clientX - g.x0) / PX_PER_MIN;
      const t = this._band(g.raw);
      this.tracker.add(e.timeStamp || performance.now(), t, 0);
      this._set(t);
    });
    const up = (e) => {
      if (!g || e.pointerId !== g.id) return;
      g = null;
      this.idle = 0;
      const v = this.tracker.velocity(e.timeStamp || performance.now()).az;
      this._release(v);
    };
    band.addEventListener('pointerup', up);
    band.addEventListener('pointercancel', up);
    band.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 60 : 10;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        this.idle = 0;
        this._springTo(clamp(this.t + (e.key === 'ArrowRight' ? step : -step), this.min, this.max), 12);
      }
    });
  }

  _release(v) {
    if (this.t > this.max || this.t < this.min) { this._springTo(clamp(this.t, this.min, this.max), 8, v); return; }
    if (Math.abs(v) > FLING_STOP * 2) { this.mode = 'fling'; this.v = v; return; }
    this._settle(v);
  }

  _settle(v = 0) {
    if (Math.abs(this.t) <= SNAP_WINDOW && this.t !== 0) this._springTo(0, 12, v);
    else { this.mode = 'idle'; this.v = 0; }
  }

  _springTo(g, omega, v = 0) {
    this.spring.x = this.t;
    this.spring.v = v;
    this.spring.gs = g;
    this.spring.target(g, { omega, tau: 0 });
    this.mode = 'spring';
  }

  play(on = this.mode !== 'play') {
    if (!this.isOpen) return;
    if (on) {
      if (this.t >= this.max - 0.5) { this._springTo(this.min, 3); this._afterSpring = 'play'; this._playLabel(true); return; }
      this.mode = 'play';
      this._playLabel(true);
    } else {
      this._afterSpring = null;
      if (this.mode === 'play' || this.mode === 'spring') this.mode = 'idle';
      this._playLabel(false);
    }
  }

  _playLabel(playing) {
    if (this.el.play) {
      this.el.play.innerHTML = playing ? ICON.pause : ICON.play;
      this.el.play.setAttribute('aria-label', playing ? T.ruler.pause : T.ruler.play);
    }
    if (!playing) this._afterSpring = null;
  }

  toBirth() {
    this._playLabel(false);
    this._springTo(0, 3);
  }

  step(dt) {
    if (!this.isOpen) return;
    dt = clamp(dt, 0, 0.05);
    switch (this.mode) {
      case 'play': {
        const t = Math.min(this.max, this.t + PLAY_RATE * dt);
        this._set(t);
        if (t >= this.max) { this.mode = 'idle'; this._playLabel(false); }
        this.idle = 0;
        break;
      }
      case 'fling': {
        this.v *= Math.exp(-dt / FLING_TAU);
        const t = this.t + this.v * dt;
        if (t > this.max || t < this.min) { this._set(this._band(t)); this._springTo(clamp(t, this.min, this.max), 8, this.v * BAND); break; }
        this._set(t);
        if (Math.abs(this.v) < FLING_STOP) this._settle(this.v);
        this.idle = 0;
        break;
      }
      case 'spring': {
        const x = this.spring.step(dt);
        if (Math.abs(x - this.spring.g) < 0.05 && Math.abs(this.spring.v) < 0.2) {
          this._set(this.spring.g);
          this.mode = 'idle';
          if (this._afterSpring === 'play') { this._afterSpring = null; this.mode = 'play'; }
        } else this._set(x);
        this.idle = 0;
        break;
      }
      case 'drag':
        this.idle = 0;
        break;
      default:
        this.idle += dt;
        if (this.idle >= IDLE_CLOSE) this.close('idle');
    }
  }
}
