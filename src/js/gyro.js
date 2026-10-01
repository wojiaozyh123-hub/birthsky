// 体感 (spec §3b "Gyro", S7): the phone's heading and pitch steer the view.
//   heading / pitch → One-Euro filter (0.8 Hz, β 0.02, 1 Hz) → 0.35° backlash deadzone → the rig's FOLLOW
//   spring. On enable the follow weight ramps 0 → 1 over 800 ms. A drag adds an az/alt offset instead of
//   turning the gyro off; double-tap resets the offset. No event within 1 s → off, silently.
//
// Public API
//   new Gyro(app)                   app.rig, app.cam, app.onGyroOff?() (called when it turns itself off)
//   gyro.available                  a phone with DeviceOrientationEvent
//   gyro.enable() → Promise<bool>   asks iOS for permission (must run inside the tap), starts listening
//   gyro.disable()
//   gyro.on
//   gyro.step(now)                  every frame, before rig.step(): feeds rig.follow()
//   gyro.dragStart(), gyro.dragTo(dx, dy), gyro.dragEnd()   finger offset while the gyro steers
//   gyro.resetOffset()
import { OneEuro, deadzone } from './motion.js';
import { angDiff } from './camera.js';
import { isMobile } from './share.js';

const RAMP_MS = 800, WATCH_MS = 1000, DZ = 0.35;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

export class Gyro {
  constructor(app) {
    this.app = app;
    this.on = false;
    this.fH = new OneEuro(0.8, 0.02, 1);
    this.fP = new OneEuro(0.8, 0.02, 1);
    this.offset = { az: 0, alt: 0 };
    this.off0 = null;
    this.target = null;
    this.raw = null;
    this.out = { az: 0, alt: 0 };
    this.relative = 0;
    this._onEvt = (e) => this._event(e, false);
    this._onAbs = (e) => this._event(e, true);
  }

  get available() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && isMobile;
  }

  async enable() {
    if (this.on) return true;
    const D = window.DeviceOrientationEvent;
    if (!D) return false;
    try {
      if (typeof D.requestPermission === 'function') {
        const r = await D.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch { return false; }
    if (!this.bound) {
      addEventListener('deviceorientationabsolute', this._onAbs, true);
      addEventListener('deviceorientation', this._onEvt, true);
      this.bound = true;
    }
    this.on = true;
    this.t0 = performance.now();
    this.lastEvt = 0;
    this.absSeen = false;
    this.target = null;
    this.raw = null;
    this.relative = null;
    this.from = this.app.cam.snapshot();
    this.offset.az = this.offset.alt = 0;
    this.fH.reset(); this.fP.reset();
    clearTimeout(this.watch);
    this.watch = setTimeout(() => { if (this.on && !this.lastEvt) this.disable(true); }, WATCH_MS);
    return true;
  }

  disable(silent = false) {
    if (!this.on) return;
    this.on = false;
    this.target = null;
    clearTimeout(this.watch);
    if (silent) this.app.onGyroOff?.();
  }

  resetOffset() {
    this.offset.az = this.offset.alt = 0;
  }

  _event(e, absolute) {
    if (!this.on || e.beta == null) return;
    if (absolute) this.absSeen = true;
    else if (this.absSeen) return; // prefer the absolute stream when the browser has one
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) heading = e.webkitCompassHeading;
    else if (e.alpha != null) heading = 360 - e.alpha;
    if (heading == null) return;
    const orient = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
    heading += orient;
    // a compass heading is the real sky's direction; a relative alpha is anchored to where the view faces now
    const real = absolute || typeof e.webkitCompassHeading === 'number';
    if (!real && this.relative === null) this.relative = angDiff(heading, this.from.az);
    if (real) this.relative = 0;
    heading += this.relative || 0;
    const pitch = e.beta - 90; // upright phone looks at the horizon; tilting back looks up
    const t = (e.timeStamp || performance.now()) / 1000;
    // unwrap the heading before filtering
    const prev = this.raw ? this.raw.az : heading;
    const h = prev + angDiff(prev, heading);
    this.raw = { az: h, alt: pitch };
    const fh = this.fH.filter(h, t), fp = this.fP.filter(pitch, t);
    if (!this.target) { this.out.az = fh; this.out.alt = fp; this.target = this.out; }
    this.out.az = deadzone(this.out.az, fh, DZ);
    this.out.alt = deadzone(this.out.alt, fp, DZ);
    this.lastEvt = performance.now();
  }

  step(now) {
    if (!this.on || !this.target) return;
    const rig = this.app.rig;
    const w = smooth((now - this.t0) / RAMP_MS);
    const lim = rig.limits;
    const goalAz = this.out.az + this.offset.az;
    const goalAlt = clamp(this.out.alt + this.offset.alt, rig.altMin(this.app.cam.fov), lim.altMax);
    const az = this.from.az + angDiff(this.from.az, goalAz) * w;
    const alt = this.from.alt + (goalAlt - this.from.alt) * w;
    rig.follow({ az, alt });
  }

  // a finger while the gyro steers: it adds an offset (the sky still follows the phone)
  dragStart() { this.off0 = { az: this.offset.az, alt: this.offset.alt }; }
  dragTo(dx, dy) {
    if (!this.off0) this.dragStart();
    const deg = this.app.cam.pxPerDeg();
    const c = Math.max(0.2, Math.cos(this.app.cam.alt * Math.PI / 180));
    this.offset.az = this.off0.az - dx / deg / c;
    this.offset.alt = this.off0.alt + dy / deg;
  }
  dragEnd() { this.off0 = null; }
}
