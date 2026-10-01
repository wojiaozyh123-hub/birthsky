// Camera motion (spec §3b): one view state {az, alt, lnFov} held by a ViewRig and moved only by
// critically damped springs, minimum-jerk scripted paths, the finger (grab the sky), flings and a
// constant-rate cruise. Nothing is tweened and nothing is assigned after the first frame except by a
// finger or a cut, so every move keeps its velocity when it is interrupted.
//
// Public API
//   GLIDE, LOOK, FOLLOW, SNAP                profile descriptors {name, omega, tau, cap}
//   new ViewRig(cam)                         drives a camera.js Camera
//     rig.step(dt)                           advance (dt clamped to [1/240, 1/20] s); writes cam + cam.update()
//     rig.set(view)                          hard assignment: first frame and cuts only; zero velocity
//     rig.setTarget(view, profile = GLIDE, {path}) → Promise<boolean>
//                                            springs to view (missing fields keep their channel as is);
//                                            GLIDE/LOOK moves with |Δaz| > 70° become a path unless
//                                            {path: false}; true on settle, false if superseded/caught
//     rig.path(view, {kind: 'arrival'|'move'}) → Promise<boolean>   minimum-jerk path with lift
//     rig.catch() → {az, alt, lnFov}         finger down: stop everything where it is; returns the
//                                            velocity it had (deg/s, 1/s) for a caller that wants to
//                                            hand it back (e.g. a tap that did not drag)
//     rig.drag(view, tMs?)                   finger move: direct placement with the rubber band limits
//     rig.release(vel?)                      finger up: fling with vel {az, alt} (deg/s) or settle, and
//                                            SNAP back inside the limits
//     rig.fling(vAz, vAlt)                   deg/s, clamped to 180°/s, decays with τ 0.5 s
//     rig.follow(view)                       FOLLOW target (gyro, wheel); cheap to call every frame
//     rig.cruise(rateDegPerSec, {rampIn})    constant azimuth turn (listen); rig.cruiseStop({rampOut})
//     rig.settled(), rig.speed(), rig.view, rig.velocity, rig.target, rig.limits, rig.altMin(fov)
//   new Spring(x, {omega, tau})              one exact critically damped channel (rulers, time values)
//   new FlingTracker()                       reset(), add(tMs, az, alt), velocity(nowMs) → {az, alt}
//   new OneEuro(minCutoff = 0.8, beta = 0.02, dCutoff = 1)   filter(x, tSec)
//   deadzone(out, x, dz = 0.35)              backlash deadzone: the new output
//   grabSolve(cam, s0, x, y, fov?) → {az, alt, fov, exact}   keep NEU direction s0 under screen point (x, y)
//                                            (exact closed form; also the pinch anchor with a new fov)
import { Camera, angDiff, autoP } from './camera.js';

const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const GLIDE = { name: 'glide', omega: (dAz, dAlt) => clamp(110 / (Math.abs(dAz) + Math.abs(dAlt) + 20), 0.9, 1.9), tau: 0.35, cap: true };
export const LOOK = { name: 'look', omega: 3.2, tau: 0.18, cap: true };
export const FOLLOW = { name: 'follow', omega: 6, tau: 0, cap: false };
export const SNAP = { name: 'snap', omega: 8, tau: 0, cap: true };

const DT_MIN = 1 / 240, DT_MAX = 1 / 20;
const SETTLE_V = 0.15, SETTLE_VLN = 0.002; // spec §3b "settled"
const SETTLE_X = 0.1, SETTLE_XLN = 0.002;  // and actually at the goal (a fresh target starts at v = 0)
const PAN_CAP = 36;      // deg/s of horizontal sky motion at the view centre
const PX_CAP = 540;      // CSS px/s for any star on screen
const FLING_MAX = 180, FLING_TAU = 0.5, FLING_STOP = 0.5;
const BAND = 0.35;       // rubber band: displacement beyond a limit × 0.35
const KNEE = 0.85;       // speed caps are soft above this fraction of the cap
const HANDOFF_T = 1.0;   // a path started while moving absorbs the old velocity over this long

// ------------------------------------------------------------------ one spring channel
/**
 * Exact critically damped spring toward a prefiltered goal (spec §3b):
 *   g_s += (g − g_s)(1 − e^(−dt/τ));  d = x − g_s;  e = e^(−ω dt);  k = (v + ω d) dt
 *   x ← g_s + (d + k) e;  v ← (v − ω k) e
 * Retargeting keeps x, v and g_s, so an interrupted move bends instead of restarting.
 */
export class Spring {
  constructor(x = 0, { omega = 3.2, tau = 0 } = {}) {
    this.x = x; this.v = 0; this.g = x; this.gs = x;
    this.omega = omega; this.tau = tau;
  }
  set(x) { this.x = this.g = this.gs = x; this.v = 0; return this; }
  hold() { this.g = this.gs = this.x; return this; }
  target(g, opts) {
    this.g = g;
    if (opts) {
      if (opts.omega !== undefined) this.omega = opts.omega;
      if (opts.tau !== undefined) this.tau = opts.tau;
    }
    return this;
  }
  step(dt) {
    this.gs = this.tau > 0 ? this.gs + (this.g - this.gs) * (1 - Math.exp(-dt / this.tau)) : this.g;
    const w = this.omega, d = this.x - this.gs, e = Math.exp(-w * dt), k = (this.v + w * d) * dt;
    this.x = this.gs + (d + k) * e;
    this.v = (this.v - w * k) * e;
    return this.x;
  }
  settled(vTol = SETTLE_V, xTol = SETTLE_X) {
    return Math.abs(this.v) < vTol && Math.abs(this.x - this.g) < xTol && Math.abs(this.gs - this.g) < xTol;
  }
}

// ------------------------------------------------------------------ minimum-jerk path
const mj = (u) => u * u * u * (10 + u * (-15 + 6 * u));
const mjd = (u) => 30 * u * u * (1 - u) * (1 - u);

function pathEval(p, u, out) {
  const s = mj(u), ds = mjd(u);
  const sp = Math.sin(Math.PI * s), cp = Math.cos(Math.PI * s);
  out.az = p.az0 + p.dAz * s;
  out.alt = p.alt0 + (p.alt1 - p.alt0) * s + p.L * sp;
  const fb = Math.exp(p.lf0 + (p.lf1 - p.lf0) * s);
  const fov = fb + p.F * sp;
  out.ln = Math.log(fov);
  // d/du
  out.daz = p.dAz * ds;
  out.dalt = (p.alt1 - p.alt0 + p.L * Math.PI * cp) * ds;
  out.dln = (fb * (p.lf1 - p.lf0) + p.F * Math.PI * cp) / fov * ds;
  return out;
}

// ------------------------------------------------------------------ the rig
export class ViewRig {
  constructor(cam) {
    this.cam = cam;
    this.az = new Spring(cam.az, { omega: SNAP.omega });
    this.alt = new Spring(cam.alt, { omega: SNAP.omega });
    this.lnFov = new Spring(Math.log(cam.fov), { omega: SNAP.omega });
    this.prof = { az: SNAP, alt: SNAP, lnFov: SNAP };
    this.pathSt = null;
    this.flingSt = null;
    this.cruiseSt = null;
    this.dragging = false;
    this.dragFov = false;
    this.dragT = 0;
    this.limits = { altMax: 90, fovMin: 20, fovMax: 100, horizonFrac: 0.55 };
    this.caps = true;
    this.waiters = [];
    this.target = { az: cam.az, alt: cam.alt, fov: cam.fov };
    this.scratch = new Camera();
    this.pe = {};
    this.acc = { az: 0, alt: 0, ln: 0 }; // last step's acceleration, for a path's handoff
    this.vPrev = { az: 0, alt: 0, ln: 0 };
    this.samples = new Float64Array(9 * 5); // screen probe points: x, y, n0, n1, n2
  }

  /** Current view. */
  get view() { return { az: this.az.x, alt: this.alt.x, fov: Math.exp(this.lnFov.x) }; }
  /** Current velocity: az and alt in deg/s, lnFov in 1/s. */
  get velocity() { return { az: this.az.v, alt: this.alt.v, lnFov: this.lnFov.v }; }

  /** Lowest altitude a drag may reach at this fov: the horizon never rises above limits.horizonFrac. */
  altMin(fov = Math.exp(this.lnFov.x)) {
    return Math.atan((2 * this.limits.horizonFrac - 1) * Math.tan(fov * DEG / 2)) / DEG;
  }

  // ---------------------------------------------------------------- commands
  set(view) {
    this.supersede();
    this.endCruise(false);
    this.pathSt = this.flingSt = null;
    this.dragging = false;
    if (view.az !== undefined) this.az.set(view.az);
    if (view.alt !== undefined) this.alt.set(view.alt);
    if (view.fov !== undefined) this.lnFov.set(Math.log(view.fov));
    this.az.v = this.alt.v = this.lnFov.v = 0;
    this.az.hold(); this.alt.hold(); this.lnFov.hold();
    this.target = this.view;
    this.resetAcc();
    this.write();
  }

  setTarget(view, profile = GLIDE, { path = true } = {}) {
    const dAz = view.az === undefined ? 0 : angDiff(this.az.x, view.az);
    if (path && profile !== FOLLOW && profile !== SNAP && Math.abs(dAz) > 70) return this.path(view, { kind: 'move' });
    this.supersede();
    // hand a running path / fling / cruise / drag over to the springs, but only where this move
    // takes over: a fov-only target (look-up widening) leaves a finger dragging az/alt alone
    const end = this.interrupt(view.az !== undefined, view.alt !== undefined, view.fov !== undefined);
    const dAlt = view.alt === undefined ? 0 : view.alt - this.alt.x;
    const omega = typeof profile.omega === 'function' ? profile.omega(dAz, dAlt) : profile.omega;
    const opts = { omega, tau: profile.tau };
    const aim = (name, spring, goal) => {
      if (goal === undefined) {
        if (end) spring.target(end[name], opts), (this.prof[name] = profile);
        return;
      }
      spring.target(goal, opts);
      this.prof[name] = profile;
    };
    aim('az', this.az, view.az === undefined ? undefined : this.az.x + dAz);
    aim('alt', this.alt, view.alt);
    aim('lnFov', this.lnFov, view.fov === undefined ? undefined : Math.log(view.fov));
    this.target = { az: this.az.g, alt: this.alt.g, fov: Math.exp(this.lnFov.g) };
    return this.wait();
  }

  path(view, { kind = 'move' } = {}) {
    this.supersede();
    const v0 = { az: this.az.v, alt: this.alt.v, ln: this.lnFov.v };
    if (this.pathSt) { v0.az = this.pathVel.az; v0.alt = this.pathVel.alt; v0.ln = this.pathVel.ln; }
    // the old acceleration too, bounded by the old speed's scale (it is a finite difference)
    const lim = (a, v) => clamp(a, -5 * Math.abs(v), 5 * Math.abs(v));
    const a0 = this.dragging ? { az: 0, alt: 0, ln: 0 } : { az: lim(this.acc.az, v0.az), alt: lim(this.acc.alt, v0.alt), ln: lim(this.acc.ln, v0.ln) };
    this.interrupt(true, true, true); // a new path starts where things are, at their speed (v0)
    const az0 = this.az.x, alt0 = this.alt.x, lf0 = this.lnFov.x;
    const dAz = view.az === undefined ? 0 : angDiff(az0, view.az);
    const alt1 = view.alt === undefined ? alt0 : view.alt;
    const lf1 = view.fov === undefined ? lf0 : Math.log(view.fov);
    const A = Math.abs(dAz);
    const T = kind === 'arrival' ? clamp(2.6 + A / 90, 2.6, 4.5) : clamp(1.8 + A / 90, 1.8, 4.0);
    const L = A > 70 ? Math.max(0, Math.min(30, 62 - Math.max(alt0, alt1))) : 6;
    const F = A > 70 ? 12 : 0;
    this.pathSt = { az0, dAz, alt0, alt1, lf0, lf1, L, F, T, t: 0, v0, a0, kind };
    this.pathVel = { az: v0.az, alt: v0.alt, ln: v0.ln };
    this.target = { az: az0 + dAz, alt: alt1, fov: Math.exp(lf1) };
    for (const k of ['az', 'alt', 'lnFov']) this.prof[k] = SNAP;
    return this.wait();
  }

  catch() {
    this.supersede();
    const v = { az: this.az.v, alt: this.alt.v, lnFov: this.lnFov.v };
    if (this.pathSt) { v.az = this.pathVel.az; v.alt = this.pathVel.alt; v.lnFov = this.pathVel.ln; }
    this.endCruise(false);
    this.pathSt = this.flingSt = null;
    this.dragging = false; this.dragFov = false;
    for (const s of [this.az, this.alt, this.lnFov]) { s.v = 0; s.hold(); }
    this.target = this.view;
    this.resetAcc();
    return v;
  }

  drag(view, tMs = now()) {
    if (!this.dragging) {
      this.catch();
      this.dragging = true;
      this.dragT = tMs;
    }
    const lim = this.limits;
    let lnF = this.lnFov.x;
    this.dragFov = view.fov !== undefined;
    if (this.dragFov) lnF = band(Math.log(view.fov), Math.log(lim.fovMin), Math.log(lim.fovMax));
    const fov = Math.exp(lnF);
    const az = view.az === undefined ? this.az.x : view.az;
    const alt = view.alt === undefined ? this.alt.x : band(view.alt, this.altMin(fov), lim.altMax);
    const dt = (tMs - this.dragT) / 1000;
    if (dt > 0.002) {
      const a = Math.min(1, dt / 0.05); // velocity estimate for speed(): light smoothing
      this.az.v += ((az - this.az.x) / dt - this.az.v) * a;
      this.alt.v += ((alt - this.alt.x) / dt - this.alt.v) * a;
      if (this.dragFov) this.lnFov.v += ((lnF - this.lnFov.x) / dt - this.lnFov.v) * a;
      this.dragT = tMs;
    }
    this.az.x = az; this.alt.x = alt;
    this.az.hold(); this.alt.hold();
    if (this.dragFov) { this.lnFov.x = lnF; this.lnFov.hold(); }
    this.write();
  }

  release(vel = null) {
    if (!this.dragging) return;
    this.dragging = false;
    this.dragFov = false;
    this.az.v = this.alt.v = this.lnFov.v = 0;
    this.az.hold(); this.alt.hold(); this.lnFov.hold();
    this.resetAcc();
    if (vel && Math.hypot(vel.az * Math.cos(this.alt.x * DEG), vel.alt) > FLING_STOP) this.fling(vel.az, vel.alt);
    else this.snapInside();
  }

  fling(vAz, vAlt) {
    this.supersede();
    this.interrupt(true, true, false);
    const ca = Math.max(0.2, Math.cos(this.alt.x * DEG));
    const sp = Math.hypot(vAz * ca, vAlt);
    if (sp > FLING_MAX) { vAz *= FLING_MAX / sp; vAlt *= FLING_MAX / sp; }
    this.flingSt = {};
    this.az.v = vAz; this.alt.v = vAlt;
    this.resetAcc();
  }

  follow(view) {
    if (this.waiters.length) this.supersede();
    this.interrupt(view.az !== undefined, view.alt !== undefined, view.fov !== undefined);
    const opts = { omega: FOLLOW.omega, tau: 0 };
    if (view.az !== undefined) { this.az.target(this.az.x + angDiff(this.az.x, view.az), opts); this.prof.az = FOLLOW; }
    if (view.alt !== undefined) { this.alt.target(view.alt, opts); this.prof.alt = FOLLOW; }
    if (view.fov !== undefined) { this.lnFov.target(Math.log(view.fov), opts); this.prof.lnFov = FOLLOW; }
    this.target = { az: this.az.g, alt: this.alt.g, fov: Math.exp(this.lnFov.g) };
  }

  cruise(rate, { rampIn = 1.5 } = {}) {
    this.supersede();
    this.interrupt(true, false, false);
    this.cruiseSt = { rate, t: 0, rampIn, v0: this.az.v, stopping: false };
  }

  cruiseStop({ rampOut = 2 } = {}) {
    const c = this.cruiseSt;
    if (!c) return Promise.resolve(true);
    if (!c.stopping) { c.stopping = true; c.t = 0; c.vStart = this.az.v; c.rampOut = rampOut; }
    return new Promise((res) => { c.done = res; });
  }

  // ---------------------------------------------------------------- state
  settled() {
    if (this.pathSt || this.flingSt || this.cruiseSt || this.dragging) return false;
    return this.az.settled() && this.alt.settled() && this.lnFov.settled(SETTLE_VLN, SETTLE_XLN);
  }

  /** Angular speed of the view (deg/s): the centre's motion on the sky, plus zoom as the angular rate at the half-height edge. */
  speed() {
    const v = this.pathSt ? this.pathVel : { az: this.az.v, alt: this.alt.v, ln: this.lnFov.v };
    return Math.hypot(v.az * Math.cos(this.alt.x * DEG), v.alt, v.ln * Math.exp(this.lnFov.x) / 2);
  }

  // ---------------------------------------------------------------- stepping
  step(dt) {
    dt = clamp(dt || 0, DT_MIN, DT_MAX);
    if (this.pathSt) this.stepPath(dt);
    else if (this.dragging) {
      // the finger places az/alt (and fov while pinching); if it rests, the velocity estimate falls away
      const k = Math.exp(-dt / 0.05);
      this.az.v *= k; this.alt.v *= k;
      if (this.dragFov) this.lnFov.v *= k;
      else this.stepSprings(dt, false, false, true);
    } else if (this.flingSt) {
      this.stepFling(dt);
      this.stepSprings(dt, false, false, true);
    } else {
      const cruising = !!this.cruiseSt;
      if (cruising) this.stepCruise(dt);
      this.stepSprings(dt, !cruising, true, true);
    }
    this.write();
    const vp = this.vPrev, ac = this.acc;
    ac.az = (this.az.v - vp.az) / dt; ac.alt = (this.alt.v - vp.alt) / dt; ac.ln = (this.lnFov.v - vp.ln) / dt;
    vp.az = this.az.v; vp.alt = this.alt.v; vp.ln = this.lnFov.v;
    if (this.waiters.length && this.settled()) {
      const w = this.waiters; this.waiters = [];
      for (const r of w) r(true);
    }
  }

  stepSprings(dt, doAz, doAlt, doFov) {
    const x0 = this.az.x, h0 = this.alt.x, l0 = this.lnFov.x;
    if (doAz) this.az.step(dt);
    if (doAlt) this.alt.step(dt);
    if (doFov) this.lnFov.step(dt);
    if (!this.caps) return;
    // speed caps: measured on the capped channels' average velocity over this step
    const ca = doAz && this.prof.az.cap, ch = doAlt && this.prof.alt.cap, cf = doFov && this.prof.lnFov.cap;
    if (!ca && !ch && !cf) return;
    // the cap must hold for both what moved this frame and the speed carried into the next
    const big = (avg, end) => (Math.abs(end) > Math.abs(avg) ? end : avg);
    const va = ca ? big((this.az.x - x0) / dt, this.az.v) : 0;
    const vh = ch ? big((this.alt.x - h0) / dt, this.alt.v) : 0;
    const vl = cf ? big((this.lnFov.x - l0) / dt, this.lnFov.v) : 0;
    const k = this.capScale(va, vh, vl);
    if (k < 1) {
      if (ca) { this.az.x = x0 + (this.az.x - x0) * k; this.az.v *= k; }
      if (ch) { this.alt.x = h0 + (this.alt.x - h0) * k; this.alt.v *= k; }
      if (cf) { this.lnFov.x = l0 + (this.lnFov.x - l0) * k; this.lnFov.v *= k; }
    }
  }

  stepPath(dt) {
    const p = this.pathSt, e = this.pe;
    // A path started while moving is the minimum-jerk path with that initial velocity and
    // acceleration: v0·Th·hv(t/Th) + a0·Th²·ha(t/Th) over Th = min(T, 1 s), where
    //   hv(u) = u − 6u³ + 8u⁴ − 3u⁵ and ha(u) = ½u² − 3⁄2u³ + 3⁄2u⁴ − ½u⁵
    // carry the old slope and curvature at 0 and vanish flat at 1, so the old motion is absorbed
    // with no jolt and the path still lands on its target at rest.
    const Th = Math.min(p.T, HANDOFF_T);
    const hv = (u) => u * (1 + u * u * (-6 + u * (8 - 3 * u)));
    const hvd = (u) => 1 + u * u * (-18 + u * (32 - 15 * u));
    const ha = (u) => u * u * (0.5 + u * (-1.5 + u * (1.5 - 0.5 * u)));
    const had = (u) => u * (1 + u * (-4.5 + u * (6 - 2.5 * u)));
    const V0 = p.v0, A0 = p.a0;
    const hand = (t, key) => { const u = Math.min(1, t / Th); return V0[key] * Th * hv(u) + A0[key] * Th * Th * ha(u); };
    const handD = (t, key) => { const u = Math.min(1, t / Th); return V0[key] * hvd(u) + A0[key] * Th * had(u); };
    const velAt = (t, out) => {
      pathEval(p, Math.min(1, t / p.T), e);
      out.az = e.daz / p.T + handD(t, 'az'); out.alt = e.dalt / p.T + handD(t, 'alt'); out.ln = e.dln / p.T + handD(t, 'ln');
      return out;
    };
    // speed caps slow the path's clock: judged at the start and the end of this step
    const vv = this.pathVel;
    let k = 1;
    if (this.caps) {
      velAt(p.t, vv);
      k = this.capScale(vv.az, vv.alt, vv.ln);
      velAt(p.t + dt * k, vv);
      k = Math.min(k, this.capScale(vv.az, vv.alt, vv.ln));
    }
    p.t += dt * k;
    const u = Math.min(1, p.t / p.T);
    pathEval(p, u, e);
    this.az.x = e.az + hand(p.t, 'az');
    this.alt.x = e.alt + hand(p.t, 'alt');
    this.lnFov.x = e.ln + hand(p.t, 'ln');
    velAt(p.t, vv);
    vv.az *= k; vv.alt *= k; vv.ln *= k;
    this.az.v = vv.az; this.alt.v = vv.alt; this.lnFov.v = vv.ln;
    if (u >= 1) {
      this.pathSt = null;
      this.az.x = p.az0 + p.dAz; this.alt.x = p.alt1; this.lnFov.x = p.lf1;
      for (const s of [this.az, this.alt, this.lnFov]) { s.v = 0; s.hold(); }
      vv.az = vv.alt = vv.ln = 0;
    }
  }

  stepFling(dt) {
    const k = Math.exp(-dt / FLING_TAU);
    this.az.x += this.az.v * FLING_TAU * (1 - k);
    this.alt.x += this.alt.v * FLING_TAU * (1 - k);
    this.az.v *= k; this.alt.v *= k;
    // past a limit the fling brakes hard (the rubber band), then SNAPs back
    const lo = this.altMin(), hi = this.limits.altMax;
    if ((this.alt.x < lo && this.alt.v < 0) || (this.alt.x > hi && this.alt.v > 0)) this.alt.v *= Math.exp(-dt / 0.06);
    this.az.hold(); this.alt.hold();
    if (Math.hypot(this.az.v * Math.cos(this.alt.x * DEG), this.alt.v) < FLING_STOP) {
      this.flingSt = null;
      this.az.v = this.alt.v = 0;
      this.snapInside();
    }
  }

  stepCruise(dt) {
    const c = this.cruiseSt;
    c.t += dt;
    let v;
    if (!c.stopping) v = c.v0 + (c.rate - c.v0) * smoothstep(0, c.rampIn, c.t);
    else v = c.vStart * (1 - smoothstep(0, c.rampOut, c.t));
    this.az.x += (this.az.v + v) * 0.5 * dt;
    this.az.v = v;
    this.az.hold();
    if (c.stopping && c.t >= c.rampOut) {
      this.az.v = 0;
      this.endCruise(true);
    }
  }

  // ---------------------------------------------------------------- internals
  write() {
    const cam = this.cam;
    cam.az = this.az.x; cam.alt = this.alt.x; cam.fov = Math.exp(this.lnFov.x);
    cam.update();
  }

  wait() {
    return new Promise((res) => this.waiters.push(res));
  }

  supersede() {
    if (!this.waiters.length) return;
    const w = this.waiters; this.waiters = [];
    for (const r of w) r(false);
  }

  /**
   * Stop whatever drives the channels a new command takes over (a path drives all three), leaving
   * its velocity in the springs and their goals where they are. Returns a stopped path's end view,
   * which the channels the new command does not name then keep as their goal.
   */
  interrupt(az, alt, fov) {
    let end = null;
    if (this.pathSt && (az || alt || fov)) {
      const p = this.pathSt;
      end = { az: p.az0 + p.dAz, alt: p.alt1, lnFov: p.lf1 };
      this.az.v = this.pathVel.az; this.alt.v = this.pathVel.alt; this.lnFov.v = this.pathVel.ln;
      this.pathSt = null;
      this.az.hold(); this.alt.hold(); this.lnFov.hold();
    }
    if (this.flingSt && (az || alt)) { this.flingSt = null; this.az.hold(); this.alt.hold(); }
    if (this.cruiseSt && az) { this.endCruise(false); this.az.hold(); }
    if (this.dragging && (az || alt)) { this.dragging = false; this.dragFov = false; this.az.hold(); this.alt.hold(); this.lnFov.hold(); }
    else if (this.dragging && fov && this.dragFov) { this.dragFov = false; this.lnFov.hold(); }
    return end;
  }

  /** After a velocity is assigned outright, the finite-difference acceleration starts afresh. */
  resetAcc() {
    this.vPrev.az = this.az.v; this.vPrev.alt = this.alt.v; this.vPrev.ln = this.lnFov.v;
    this.acc.az = this.acc.alt = this.acc.ln = 0;
  }

  endCruise(result) {
    const c = this.cruiseSt;
    if (!c) return;
    this.cruiseSt = null;
    c.done?.(result);
  }

  /** After a drag or fling: SNAP back inside the altitude and fov limits. */
  snapInside() {
    const lim = this.limits;
    const lnF = clamp(this.lnFov.x, Math.log(lim.fovMin), Math.log(lim.fovMax));
    const lo = this.altMin(Math.exp(lnF));
    const alt = clamp(this.alt.x, lo, lim.altMax);
    const opts = { omega: SNAP.omega, tau: SNAP.tau };
    if (alt !== this.alt.x) { this.alt.target(alt, opts); this.prof.alt = SNAP; }
    if (lnF !== this.lnFov.x) { this.lnFov.target(lnF, opts); this.prof.lnFov = SNAP; }
    this.target = { az: this.az.g, alt: this.alt.g, fov: Math.exp(this.lnFov.g) };
  }

  /**
   * Factor (≤ 1) that brings a view velocity inside the speed caps (spec §3b): 36°/s of horizontal
   * sky motion and 540 px/s for any star. The cap has a soft knee (full speed up to 85% of a cap, then
   * a smooth tanh approach that never passes it), so engaging it bends the motion without a jolt.
   */
  capScale(vAz, vAlt, vLn) {
    let r = Math.abs(vAz) * Math.cos(this.alt.x * DEG) / PAN_CAP;
    // cheap bound first: most frames are nowhere near 540 px/s
    const cam = this.cam;
    const ang = (Math.abs(vAz) + Math.abs(vAlt)) * DEG;
    const bound = ang * cam.S * 3 + Math.abs(vLn) * cam.h * 1.5;
    if (bound > PX_CAP * KNEE) r = Math.max(r, this.screenSpeed(vAz, vAlt, vLn) / PX_CAP);
    if (r <= KNEE) return 1;
    return (KNEE + (1 - KNEE) * Math.tanh((r - KNEE) / (1 - KNEE))) / r;
  }

  /** Fastest on-screen speed (CSS px/s) over a 3×3 grid of probe points for a view velocity. */
  screenSpeed(vAz, vAlt, vLn) {
    const cam = this.cam, sc = this.scratch, smp = this.samples;
    const h = 0.004;
    let i = 0;
    const n = [0, 0, 0];
    for (let gy = -1; gy <= 1; gy++) {
      for (let gx = -1; gx <= 1; gx++, i += 5) {
        const x = cam.cx + gx * cam.w * 0.45, y = cam.cy + gy * cam.h * 0.45;
        cam.unproject(x, y, n);
        smp[i] = x; smp[i + 1] = y; smp[i + 2] = n[0]; smp[i + 3] = n[1]; smp[i + 4] = n[2];
      }
    }
    sc.w = cam.w; sc.h = cam.h; sc.ox = cam.ox; sc.oy = cam.oy; sc.Pfixed = cam.Pfixed;
    sc.az = cam.az + vAz * h; sc.alt = cam.alt + vAlt * h; sc.fov = cam.fov * Math.exp(vLn * h);
    sc.update();
    let best = 0;
    const o = {};
    for (let j = 0; j < 45; j += 5) {
      n[0] = smp[j + 2]; n[1] = smp[j + 3]; n[2] = smp[j + 4];
      if (!sc.project(n, o)) continue;
      const s = Math.hypot(o.x - smp[j], o.y - smp[j + 1]) / h;
      if (s > best) best = s;
    }
    return best;
  }
}

function band(x, lo, hi) {
  if (x < lo) return lo - (lo - x) * BAND;
  if (x > hi) return hi + (x - hi) * BAND;
  return x;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------ fling velocity
/** Least-squares slope of (t, az, alt) over the last 80 ms; ≥3 samples; 0 if the last is > 60 ms old. */
export class FlingTracker {
  constructor(size = 32) {
    this.size = size;
    this.t = new Float64Array(size); this.a = new Float64Array(size); this.h = new Float64Array(size);
    this.n = 0; this.i = 0;
  }
  reset() { this.n = 0; this.i = 0; }
  add(tMs, az, alt) {
    this.t[this.i] = tMs; this.a[this.i] = az; this.h[this.i] = alt;
    this.i = (this.i + 1) % this.size;
    this.n = Math.min(this.n + 1, this.size);
  }
  velocity(nowMs) {
    const out = { az: 0, alt: 0 };
    if (!this.n) return out;
    const last = (this.i - 1 + this.size) % this.size;
    const tl = this.t[last];
    if (nowMs !== undefined && nowMs - tl > 60) return out;
    let m = 0, st = 0, sa = 0, sh = 0;
    for (let k = 0; k < this.n; k++) {
      const j = (last - k + this.size) % this.size;
      if (tl - this.t[j] > 80) break;
      m++; st += this.t[j]; sa += this.a[j]; sh += this.h[j];
    }
    if (m < 3) return out;
    const tm = st / m, am = sa / m, hm = sh / m;
    let stt = 0, sta = 0, sth = 0;
    for (let k = 0; k < m; k++) {
      const j = (last - k + this.size) % this.size;
      const dt = this.t[j] - tm;
      stt += dt * dt; sta += dt * (this.a[j] - am); sth += dt * (this.h[j] - hm);
    }
    if (stt < 1e-9) return out;
    out.az = (sta / stt) * 1000;
    out.alt = (sth / stt) * 1000;
    return out;
  }
}

// ------------------------------------------------------------------ gyro filtering
/** One-Euro filter (Casiez et al.): jitter-free at rest, low lag when moving. */
export class OneEuro {
  constructor(minCutoff = 0.8, beta = 0.02, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(x, tSec) {
    if (this.x === null) { this.x = x; this.dx = 0; this.t = tSec; return x; }
    const dt = tSec - this.t;
    if (!(dt > 0)) return this.x;
    this.t = tSec;
    const alpha = (fc) => { const tau = 1 / (2 * Math.PI * fc); return 1 / (1 + tau / dt); };
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * alpha(this.dCutoff);
    const fc = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (x - this.x) * alpha(fc);
    return this.x;
  }
}

/** Backlash deadzone: the output stays put until the input moves more than dz away, then follows at dz. */
export function deadzone(out, x, dz = 0.35) {
  if (x > out + dz) return x - dz;
  if (x < out - dz) return x + dz;
  return out;
}

// ------------------------------------------------------------------ grab the sky
/**
 * The view (az, alt) that puts sky direction s0 under the screen point (x, y) at this fov, so the
 * grabbed star stays under the finger at every altitude (spec §3b "grab the sky").
 *
 * Solved in closed form rather than by Newton steps: the finger's pixel gives s0's direction in the
 * camera frame, m = (m_r, m_u, m_f) (the inverse projection). With no roll, the zenith is (0, cos h,
 * sin h) in that frame, so s0's altitude fixes the camera altitude h through
 *     sin(alt_s0) = m_u·cos h + m_f·sin h,
 * and turning about the zenith then fixes az from s0's azimuth. Of the two roots the one nearer the
 * current alt is kept, so a drag is continuous, including straight through the zenith's screen
 * point (the special case the spec handles above 85°). P depends on alt, so the solve repeats with P
 * re-evaluated at the new alt until it stops changing (2–4 passes).
 * `exact` is false when no roll-free view can put s0 there (a star near the zenith dragged sideways
 * past it); the nearest view is returned. A solution past the zenith (alt > 90°) is exact but outside
 * the rig's limits: the rubber band takes it from there.
 */
export function grabSolve(cam, s0, x, y, fov = cam.fov) {
  const w = cam.w, h = cam.h, cx = w / 2 + (cam.ox || 0), cy = h / 2 + (cam.oy || 0);
  const half = fov * DEG / 2, cosH = Math.cos(half), sinH = Math.sin(half);
  const fixedP = typeof cam.Pfixed === 'number' ? cam.Pfixed : null;
  const sz = clamp(s0[2], -1, 1);
  const alpha = Math.atan2(s0[1], s0[0]);
  const atZenith = Math.hypot(s0[0], s0[1]) < 1e-6;
  const out = { az: cam.az, alt: cam.alt, fov, exact: true };
  // the exact solution on one branch of the altitude equation, for the P of view altitude altP
  const solve = (altP, branch) => {
    const P = fixedP ?? autoP(altP, fov, w, h);
    const k = (h / 2) * (P + cosH) / sinH; // S·(1 + P)
    const qx = (x - cx) / k, qy = -(y - cy) / k;
    const t2 = qx * qx + qy * qy;
    const c = (-t2 * P + Math.sqrt(1 + t2 * (1 - P * P))) / (1 + t2);
    const mr = (P + c) * qx, mu = (P + c) * qy, mf = c;
    // altitude: R·sin(h + φ) = sz
    const R = Math.hypot(mu, mf), phi = Math.atan2(mu, mf);
    const ratio = sz / Math.max(R, 1e-12);
    out.exact = Math.abs(ratio) <= 1;
    const as = Math.asin(clamp(ratio, -1, 1));
    const hNew = cam.alt + angDiff(cam.alt, (branch ? Math.PI - as - phi : as - phi) / DEG);
    // azimuth: s0's direction seen from the camera at az = 0, then turn about the zenith
    const hr = hNew * DEG;
    const n0x = -mu * Math.sin(hr) + mf * Math.cos(hr), n0y = mr;
    out.az = atZenith ? cam.az : cam.az + angDiff(cam.az, (alpha - Math.atan2(n0y, n0x)) / DEG);
    out.alt = hNew;
    return hNew;
  };
  // P depends on alt: on each branch find the fixed point alt = solve(alt) (secant on solve(a) − a)
  const fixed = (branch) => {
    let a0 = cam.alt, f0 = solve(a0, branch) - a0;
    if (fixedP !== null || Math.abs(f0) < 1e-10) return a0 + f0;
    let a1 = a0 + f0, f1 = solve(a1, branch) - a1;
    for (let it = 0; it < 10 && Math.abs(f1) > 1e-10; it++) {
      const den = f1 - f0;
      const a2 = Math.abs(den) > 1e-14 ? a1 - f1 * (a1 - a0) / den : a1 + f1;
      a0 = a1; f0 = f1; a1 = a2;
      f1 = solve(a1, branch) - a1;
    }
    return a1 + f1;
  };
  const r0 = fixed(0), r1 = fixed(1);
  const branch = Math.abs(r0 - cam.alt) <= Math.abs(r1 - cam.alt) ? 0 : 1;
  solve(branch ? r1 : r0, branch);
  return out;
}
