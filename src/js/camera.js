// The one projection used everywhere (screen, overlay, picking, exports): a first-person camera at the
// observer with a generalized perspective (spec §3.1)
//
//     r = S·(1 + P)·sin θ / (P + cos θ)          θ = angle from the view centre
//
// P = 0 is a true rectilinear lens: the horizon is a straight line and constellations keep their
// shapes. It blends toward P = 0.8 (close to stereographic) only when looking up or zooming out wide,
// which turns the view overhead into a borderless vault. The inverse is closed-form, so the sky shader,
// unproject and picking all agree with project to well under a hundredth of a pixel.
//
// Public API (contracts.md → camera.js):
//   new Camera()                    az, alt, fov (deg), P (auto unless Pfixed is a number), w, h, ox, oy
//   cam.setSize(w, h), cam.update() derived: cx, cy, S, k = S·(1+P), f, u, r, diagFov
//   cam.project(n, out) → {x, y, d} | null        cam.unproject(x, y, out) → NEU unit vector
//   cam.pxPerRad(n?), cam.pxPerDeg(n?)            cam.terrainAtRad(azRad, H) → rad
//   cam.snapshot() → {az, alt, fov}               cam.copyFrom(other)
//   altForHorizonAt(frac, fov), horizonFracAt(alt, fov), autoP(alt, fov, w, h), diagonalFov(fov, w, h)
//   standView(az, w, h, heroAlt?), rewindView(lat, w, h) → {az, alt, fov}   (spec §3.2, §3.6)
//   terrainAtRad(azRad, H), ridgeNearRad(azRad, H), ridgeFarRad(azRad, H)   (exact ports of the GLSL)
//   ease.{inOut, out, outQuart, outExpo, inOutSine, fade, enter, exit, bezier(x1, y1, x2, y2)}, angDiff(a, b)

const DEG = Math.PI / 180;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Projection family for a view: 0 in every standing framing, → 0.8 looking up or zoomed out wide. */
export function autoP(altDeg, fovDeg, w, h) {
  return 0.8 * Math.max(smoothstep(90, 120, diagonalFov(fovDeg, w, h)), smoothstep(72, 90, altDeg));
}

/** Diagonal field of view (deg) of the rectilinear lens with this vertical fov and aspect. */
export function diagonalFov(fovDeg, w, h) {
  return 2 * Math.atan(Math.tan(fovDeg * DEG / 2) * Math.hypot(w, h) / Math.max(1, h)) / DEG;
}

/** View-centre altitude (deg) that puts the horizon at `frac` of the screen height (P = 0). */
export function altForHorizonAt(frac, fovDeg) {
  return Math.atan((2 * frac - 1) * Math.tan(fovDeg * DEG / 2)) / DEG;
}

/** Where the horizon sits (fraction of the height from the top) for a view-centre altitude (P = 0). */
export function horizonFracAt(altDeg, fovDeg) {
  return 0.5 + 0.5 * Math.tan(altDeg * DEG) / Math.tan(fovDeg * DEG / 2);
}

/**
 * 「站着，抬头」 (spec §3.2): portrait fov 72° with the horizon at 0.82H (0.80H when H < 700); desktop
 * and landscape fov 60° at 0.84H. With a hero altitude, alt_c = clamp(heroAlt − 12°, default, 30°).
 */
export function standView(az, w, h, heroAlt) {
  const wide = w >= 960 || w > h;
  const fov = wide ? 60 : 72;
  const alt0 = altForHorizonAt(wide ? 0.84 : h < 700 ? 0.80 : 0.82, fov);
  const alt = heroAlt === undefined ? alt0 : Math.min(30, Math.max(alt0, heroAlt - 12));
  return { az, alt, fov };
}

/** Rewind (spec §3.6): face the visible celestial pole, alt_c = clamp(|lat| − 2°, 16°, 34°), fov 84° (66° landscape). */
export function rewindView(lat, w, h) {
  return { az: lat >= 0 ? 0 : 180, alt: Math.min(34, Math.max(16, Math.abs(lat) - 2)), fov: w > h ? 66 : 84 };
}

export class Camera {
  constructor() {
    this.az = 180;      // direction faced, degrees from north through east (unwrapped)
    this.alt = 25;      // altitude of the view centre, degrees
    this.fov = 72;      // vertical field of view, degrees
    this.P = 0;
    this.Pfixed = null; // a number pins P (exports, standing framings)
    this.w = 390; this.h = 844;
    this.ox = 0; this.oy = 0;
    this.cx = 0; this.cy = 0;
    this.S = 1; this.k = 1;
    this.diagFov = 0;
    this.f = [0, 0, 1]; this.u = [1, 0, 0]; this.r = [0, -1, 0];
    this.update();
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    return this.update();
  }

  update() {
    const a = this.az * DEG, h = this.alt * DEG;
    const ca = Math.cos(a), sa = Math.sin(a), ch = Math.cos(h), sh = Math.sin(h);
    const f = this.f, u = this.u, r = this.r;
    f[0] = ch * ca; f[1] = ch * sa; f[2] = sh;
    u[0] = -sh * ca; u[1] = -sh * sa; u[2] = ch;
    r[0] = -sa; r[1] = ca; r[2] = 0; // = u × f; no roll, so right is always horizontal
    this.cx = this.w / 2 + this.ox;
    this.cy = this.h / 2 + this.oy;
    this.diagFov = diagonalFov(this.fov, this.w, this.h);
    const P = typeof this.Pfixed === 'number' ? this.Pfixed : autoP(this.alt, this.fov, this.w, this.h);
    this.P = P;
    const half = this.fov * DEG / 2;
    this.S = (this.h / 2) * (P + Math.cos(half)) / ((1 + P) * Math.sin(half));
    this.k = this.S * (1 + P);
    return this;
  }

  /** NEU unit vector → CSS px. null when P + d < 0.05 (behind or too far off-axis). */
  project(n, out = {}) {
    const f = this.f;
    const d = n[0] * f[0] + n[1] * f[1] + n[2] * f[2];
    const den = this.P + d;
    if (den < 0.05) return null;
    const u = this.u, r = this.r, k = this.k / den;
    out.x = this.cx + k * (n[0] * r[0] + n[1] * r[1] + n[2] * r[2]);
    out.y = this.cy - k * (n[0] * u[0] + n[1] * u[1] + n[2] * u[2]);
    out.d = d;
    return out;
  }

  /** CSS px → NEU unit vector (closed-form inverse). */
  unproject(x, y, out = [0, 0, 0]) {
    const P = this.P;
    const qx = (x - this.cx) / this.k, qy = -(y - this.cy) / this.k;
    const t2 = qx * qx + qy * qy;
    const c = (-t2 * P + Math.sqrt(1 + t2 * (1 - P * P))) / (1 + t2);
    const m = P + c;
    const f = this.f, u = this.u, r = this.r;
    const nx = c * f[0] + m * (qx * r[0] + qy * u[0]);
    const ny = c * f[1] + m * (qx * r[1] + qy * u[1]);
    const nz = c * f[2] + m * (qx * r[2] + qy * u[2]);
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  /** CSS px per radian of sky (radial) at direction n, or at the view centre. */
  pxPerRad(n) {
    const P = this.P;
    const d = n ? n[0] * this.f[0] + n[1] * this.f[1] + n[2] * this.f[2] : 1;
    const den = Math.max(0.05, P + d);
    return this.k * (1 + P * d) / (den * den);
  }

  pxPerDeg(n) { return this.pxPerRad(n) * DEG; }

  /** Height (radians) of the skyline at an azimuth: the same numbers the shaders draw. */
  terrainAtRad(azRad, terrainH) { return terrainAtRad(azRad, terrainH); }

  snapshot() {
    return { az: this.az, alt: this.alt, fov: this.fov };
  }

  copyFrom(c) {
    this.az = c.az; this.alt = c.alt; this.fov = c.fov; this.Pfixed = c.Pfixed;
    this.w = c.w; this.h = c.h; this.ox = c.ox; this.oy = c.oy;
    return this.update();
  }
}

// ---------------------------------------------------------------- the skyline (port of renderer.js TERRAIN)
// Every operation is rounded to float32 the way the GPU evaluates it, and the GLSL was written so the
// result does not depend on transcendental precision (no sin-hash, no inexact mod), so the ridge the
// overlay clips against is the ridge on screen.
const f32 = Math.fround;
const F_01031 = f32(0.1031), F_3333 = f32(33.33), F_INV2PI = f32(0.15915494), F_022 = f32(0.22);
const fract = (x) => f32(x - Math.floor(x));
const wrap = (i, P) => (i >= P - 0.5 ? i - P : i); // i ∈ [0, P] → [0, P)

function th1(n) {
  let p = fract(f32(f32(n + 7) * F_01031));
  p = f32(p * f32(p + F_3333));
  p = f32(p * f32(p + p));
  return fract(p);
}
function tpn(x, P) {
  const i = Math.floor(x);
  let f = fract(x);
  f = f32(f32(f * f) * f32(3 - f32(2 * f)));
  const a = th1(wrap(i, P)), b = th1(wrap(i + 1, P));
  return f32(a + f32(f32(b - a) * f));
}
function crown(x, P, s) {
  const c = Math.floor(x);
  const u = f32(f32(fract(x) * 2) - 1);
  const r = th1(f32(wrap(c, P) + s));
  if (r < F_022) return 0; // step(0.22, r)
  return f32(f32(Math.sqrt(Math.max(0, f32(1 - f32(u * u))))) * f32(0.3 + f32(f32(0.7) * r)));
}
const S31 = f32(3.1), S77 = f32(7.7), O37 = f32(0.37), O61 = f32(0.61), O7 = f32(0.7), O11 = f32(0.11);
function trees(t) {
  let k = Math.max(crown(f32(t * 540), 540, 0), f32(f32(0.8) * crown(f32(f32(t * 870) + O37), 870, S31)));
  k = Math.max(k, f32(f32(0.6) * crown(f32(f32(t * 1390) + O61), 1390, S77)));
  const stand = smoothstep(0.55, 0.78, tpn(f32(f32(t * 31) + O7), 31));
  return f32(k * stand);
}
function azT(azRad) {
  // the shaders see atan(y, x) ∈ [−π, π]; the ridge is periodic, so normalise first
  let a = azRad % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a < -Math.PI) a += 2 * Math.PI;
  return f32(f32(f32(a) * F_INV2PI) + 0.5);
}

export function ridgeNearRad(azRad, H) {
  if (!(H > 0)) return 0;
  const t = azT(azRad);
  const h = f32(f32(f32(f32(0.55) * tpn(f32(t * 9), 9)) + f32(f32(0.3) * tpn(f32(t * 23), 23))) + f32(f32(0.15) * tpn(f32(t * 61), 61)));
  return f32(H * f32(f32(f32(f32(h * h) * f32(1.7)) - f32(0.12)) + f32(f32(0.13) * trees(t))));
}

export function ridgeFarRad(azRad, H) {
  if (!(H > 0)) return 0;
  const t = azT(azRad);
  const h = f32(f32(f32(0.6) * tpn(f32(f32(t * 5) + O37), 5)) + f32(f32(0.4) * tpn(f32(f32(t * 17) + O11), 17)));
  return f32(H * f32(f32(f32(h * h) * f32(2.3)) - f32(0.05)));
}

/** Skyline height in radians at an azimuth (radians, any range): max of the near and far ridges. */
export function terrainAtRad(azRad, H) {
  return Math.max(ridgeNearRad(azRad, H), ridgeFarRad(azRad, H));
}

// ---------------------------------------------------------------- easing
/** CSS cubic-bezier(x1, y1, x2, y2) as a function of t ∈ [0, 1]. */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-7) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

export const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  fade: bezier(0.37, 0, 0.63, 1),
  enter: bezier(0.22, 1, 0.36, 1),
  exit: bezier(0.4, 0, 1, 1),
  bezier,
};

/** Shortest signed angular difference b − a in degrees. */
export function angDiff(a, b) {
  return ((((b - a) % 360) + 540) % 360) - 180;
}
