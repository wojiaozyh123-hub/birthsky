// S13 聆听: the viewer turns in place, a full circle in 48 s, and every bright star (≤ 3.4 等) and planet sounds
// as it crosses the screen's vertical centre line (never drawn). The sounding star flares in the shader
// (listenAz / listenOn), one ripple plays once, and stars brighter than 1.5 等 show their name for 2 s.
// A drag pauses the turn; whatever crosses the line under the finger still sounds (play the sky by hand);
// the turn resumes 1.5 s after release. 停, or the end of the circle: the turn eases out (2 s) and the view
// GLIDEs back to its prior alt / fov. Reduced motion: no turn, the stars in view play from left to right.
//
// Public API
//   new Listen(app)         app.rig, app.cam, app.sky, app.catalog, app.audio, app.overlay, app.chrome, app.gestures,
//                           app.vis (listenOn), app.tween, app.reduced(), app.closeStrip(), app.setMode(mode)
//   listen.on               listening (including the 2 s ease-out)
//   listen.start(), listen.stop({ done = false, now = false } = {}), listen.toggle()
//   listen.step(dt, now)    every frame after rig.step()
import { T } from './copy.js';
import { toast, hint } from './ui.js';
import { track } from './monetize.js';
import { GLIDE } from './motion.js';
import { angDiff } from './camera.js';
import { starName } from './facts.js';

const RATE = 360 / 48;         // deg/s
const GRID = 0.15;             // s, note quantisation
const RESUME_MS = 1500;
const COOLDOWN_MS = 600;
const MAG_MAX = 3.4, NAME_MAG = 1.5;
const PLANETS = new Set(['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']);
const DEG = Math.PI / 180;

export class Listen {
  constructor(app) {
    this.app = app;
    this.on = false;
    this.seq = 0;
    this.notes = [];
    this.p = { x: 0, y: 0, d: 0 };
  }

  toggle() { return this.on ? this.stop() : this.start(); }

  async start() {
    const app = this.app;
    if (this.on || !app.sky) return;
    if (app.muted) {
      toast(T.listen.muted);
      app.chrome.flashToggle('sound');
      return;
    }
    const seq = ++this.seq;
    this.on = true;
    this.ending = false;
    this.cruising = false;
    this.turned = 0;
    this.pausedAt = 0;
    app.closeStrip();
    app.setMode('listen');
    app.chrome.listen(true);
    hint('listen', T.hint.listen);
    app.audio.duck(true);
    track('listen');
    app.tween(app.vis, 'listenOn', 1, 700);
    const v = app.cam.snapshot();
    this.prior = { alt: v.alt, fov: v.fov };
    this.build();
    this.prevAz = app.cam.az;
    if (app.reduced()) { this.playInView(seq); return; }
    await app.rig.setTarget({ alt: 35, fov: 84 }, GLIDE);
    if (seq !== this.seq || !this.on || this.ending) return;
    if (app.gestures.dragging) { this.pausedAt = performance.now(); return; }
    this.cruise();
  }

  cruise() {
    this.cruising = true;
    this.pausedAt = 0;
    this.app.rig.cruise(RATE, { rampIn: 1.5 });
  }

  /** The notes: named stars ≤ 3.4 等 and planets, as NEU directions for this sky. */
  build() {
    const app = this.app, cat = app.catalog, M = app.sky.M;
    const pos = cat.stars.pos, mag = cat.stars.mag;
    const notes = [];
    for (const [i, info] of cat.names) {
      if (mag[i] > MAG_MAX) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const n = [M[0] * x + M[3] * y + M[6] * z, M[1] * x + M[4] * y + M[7] * z, M[2] * x + M[5] * y + M[8] * z];
      if (n[2] < 0.02) continue;
      notes.push({ kind: 'star', i, n, az: Math.atan2(n[1], n[0]) / DEG, alt01: Math.asin(n[2]) / (Math.PI / 2), mag: mag[i],
        name: mag[i] < NAME_MAG ? starName(info) : '', last: -1e9 });
    }
    for (const b of app.sky.bodies) {
      if (!PLANETS.has(b.id) || b.alt <= 1) continue;
      notes.push({ kind: 'body', id: b.id, n: b.n, az: b.az, alt01: b.alt / 90, mag: b.mag, name: b.mag < NAME_MAG ? b.zh : '', last: -1e9 });
    }
    this.notes = notes;
  }

  step(dt, now) {
    if (!this.on) return;
    const app = this.app, cam = app.cam;
    const az0 = this.prevAz, az1 = cam.az;
    this.prevAz = az1;
    if (this.cruising && app.rig.cruiseSt) this.turned += Math.abs(az1 - az0);
    if (Math.abs(az1 - az0) > 1e-6) this.crossings(az0, az1, now);
    if (this.ending) return;
    // a drag pauses the turn; it resumes 1.5 s after release, blended in by the rig
    if (this.cruising && !app.rig.cruiseSt) { this.cruising = false; this.pausedAt = now; }
    if (!this.cruising && this.pausedAt && !app.gestures.down
      && now - Math.max(this.pausedAt, app.gestures.releasedAt) >= RESUME_MS) this.cruise();
    if (this.turned >= 360) this.stop({ done: true });
  }

  crossings(az0, az1, now) {
    const app = this.app, cam = app.cam, p = this.p;
    for (const nt of this.notes) {
      const d0 = angDiff(az0, nt.az), d1 = angDiff(az1, nt.az);
      if ((d0 > 0) === (d1 > 0) || Math.abs(d0) > 45 || Math.abs(d1) > 45) continue;
      if (now - nt.last < COOLDOWN_MS) continue;
      if (!cam.project(nt.n, p) || p.y < 0 || p.y > cam.h) continue;
      nt.last = now;
      this.sound(nt, p.x, now);
    }
  }

  sound(nt, x, now) {
    const app = this.app, a = app.audio;
    const when = Math.ceil(a.now() / GRID) * GRID;
    const pan = Math.max(-0.8, Math.min(0.8, (x / app.cam.w) * 1.6 - 0.8));
    if (nt.kind === 'star') a.star(nt.alt01, nt.mag, 0.6, pan, when);
    else a.body(nt.id, nt.alt01, when);
    app.overlay.addRipple(nt.n, now, { label: nt.name });
  }

  /** Reduced motion: no turn; the stars in view sound from left to right. */
  playInView(seq) {
    const app = this.app, cam = app.cam, p = this.p;
    const inView = [];
    for (const nt of this.notes) {
      if (!cam.project(nt.n, p) || p.x < 0 || p.x > cam.w || p.y < 0 || p.y > cam.h) continue;
      inView.push({ nt, x: p.x });
    }
    inView.sort((a, b) => a.x - b.x);
    const gap = 360;
    inView.forEach(({ nt, x }, k) => {
      setTimeout(() => { if (seq === this.seq && this.on) this.sound(nt, x, performance.now()); }, 600 + k * gap);
    });
    this.rmT = setTimeout(() => { if (seq === this.seq && this.on) this.stop({ done: true }); }, 600 + inView.length * gap + 1600);
  }

  async stop({ done = false, now = false } = {}) {
    const app = this.app;
    if (!this.on || this.ending) return;
    this.ending = true;
    clearTimeout(this.rmT);
    const seq = this.seq;
    if (!now && !app.reduced()) {
      if (app.rig.cruiseSt) await app.rig.cruiseStop({ rampOut: 2 });
      if (seq !== this.seq) return;
      if (app.mode === 'listen') app.rig.setTarget({ alt: this.prior.alt, fov: this.prior.fov }, GLIDE);
    } else if (app.rig.cruiseSt) {
      app.rig.catch();
    }
    this.seq++;
    this.on = false;
    this.cruising = false;
    app.audio.duck(false);
    app.tween(app.vis, 'listenOn', 0, 900);
    if (app.mode === 'listen') {
      app.setMode('sky');
      app.chrome.listen(false);
      if (done) hint(null, T.hint.listenDone, { ms: 2000 });
    }
  }
}
