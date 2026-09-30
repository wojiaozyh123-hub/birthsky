// Stereographic sky camera. The "dome" (a whole-sky star chart, north up, east on the left) is just
// the view straight up; tilting down continuously turns it into a first-person view of the horizon.
import { DEG } from './astro.js';

export class Camera {
  constructor() {
    this.az = 180;      // direction faced, degrees from north through east
    this.alt = 90;      // 90 = looking straight up
    this.zoom = 1;
    this.domeR = 180;   // CSS px radius of the horizon circle at zoom 1 when looking straight up
    this.cx = 0;        // CSS px centre of the projection
    this.cy = 0;
    this.f = [0, 0, 1]; this.u = [1, 0, 0]; this.r = [0, -1, 0];
    this.update();
  }

  update() {
    const a = this.az * DEG, h = Math.min(89.999, this.alt) * DEG;
    const ca = Math.cos(a), sa = Math.sin(a), ch = Math.cos(h), sh = Math.sin(h);
    this.f = [ch * ca, ch * sa, sh];
    this.u = [-sh * ca, -sh * sa, ch];
    const u = this.u, f = this.f;
    this.r = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]];
    this.scale = (this.domeR / 2) * this.zoom;
    return this;
  }

  /** NEU unit vector → CSS px. Returns null when the point is (almost) directly behind the viewer. */
  project(n, out = {}) {
    const f = this.f, u = this.u, r = this.r;
    const d = n[0] * f[0] + n[1] * f[1] + n[2] * f[2];
    if (d < -0.9) return null;
    const k = (2 / (1 + d)) * this.scale;
    out.x = this.cx + k * (n[0] * r[0] + n[1] * r[1] + n[2] * r[2]);
    out.y = this.cy - k * (n[0] * u[0] + n[1] * u[1] + n[2] * u[2]);
    out.d = d;
    return out;
  }

  /** CSS px → NEU unit vector (inverse stereographic). */
  unproject(x, y) {
    const px = (x - this.cx) / this.scale, py = -(y - this.cy) / this.scale;
    const rho2 = px * px + py * py, s = 1 / (4 + rho2);
    const f = this.f, u = this.u, r = this.r;
    return [0, 1, 2].map((i) => (4 * px * r[i] + 4 * py * u[i] + (4 - rho2) * f[i]) * s);
  }

  /** Screen position and radius of the horizon circle (valid while looking above the horizon). */
  horizonCircle() {
    const pts = [0, 120, 240].map((az) => this.project([Math.cos(az * DEG), Math.sin(az * DEG), 0]));
    if (pts.some((p) => !p)) return null;
    const [a, b, c] = pts;
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x, y, r: Math.hypot(a.x - x, a.y - y) };
  }

  snapshot() {
    return { az: this.az, alt: this.alt, zoom: this.zoom };
  }
}

// ---------------------------------------------------------------- tweening
export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

/** Shortest signed angular difference b − a in degrees. */
export function angDiff(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}
