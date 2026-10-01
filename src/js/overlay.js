// The crisp vector layer over the WebGL sky (spec §3.4, S5, S9, S11, S13, S17): cool-silver
// constellation / 星官 lines, sky names, the Moon and planets, the ember reticle, look-to-reveal tags,
// compass letters on the ground, the below-horizon marker, B's horizon line and the listen ripples.
// Everything projects through camera.js and is occluded by the very skyline the shaders draw
// (terrainAtRad), so nothing ever floats over the ridge. There is no ring, tick, grid or disc.
//
// Public API
//   new Overlay(canvas, catalog)
//   overlay.resize(w, h, dpr)
//   overlay.setCulture('cn' | 'iau' | 'none')      (also overlay.culture = …)
//   overlay.setUIRects([{x, y, w, h} | DOMRect])     label collision seeds, CSS px (caption, meta, summary,
//                                                   action row, toggles …): no label ever sits under UI text
//   overlay.markDirty()                             force a redraw on the next draw()
//   overlay.draw(state) → boolean                   steps the fades every call; repaints only when the camera
//                                                   moved (> 0.02° or 0.25 px), an input changed, or a fade /
//                                                   growth / ripple / reticle is running. Returns true if painted.
//   overlay.clear()                                 wipe the canvas (the rewind skips draw() entirely)
//   overlay.addRipple(n, t0 = now, { label })       listen: one ripple at NEU n (+ the star's name for 2 s)
//   overlay.pick(state, x, y) → {type:'star', index} | {type:'body', id} | null     (24 px, brighter wins)
//   overlay.focusAsterisms(cam, M, count = 3, maxDeg = 30, dir | { dir, keep, keepDeg = 30, onScreen = true })
//        → ids[]  nearest asterisms to the view centre, or to a direction (the hero). `keep`: ids to retain
//                 while their centroid stays within keepDeg of the centre (the rest-mode 22° / 30° rule)
//   overlay.asterismFor(target | n, M, sky?) → id | null   the asterism of a star / body (S11 α.36 lines)
//   overlay.drawExport(ctx, state, opts)            static layer for exports: lines, bodies, B's horizon
//   drawMoon(ctx, x, y, r, illum, limbAngle, opts), limbAngle(cam, moonN, sunN), discRadiusPx(cam, body, unit)
//   FONT_TEXT, FONT_DISPLAY, FONT_NUM (deprecated aliases: FONT_SANS, FONT_SERIF, FONT_LATIN)
//
// draw(state) fields (all optional except cam):
//   cam, M, sky, terrainH                      camera.js Camera, EQJ→NEU matrix, astro.skyState(), ridge scale
//   now                                        ms clock for every fade (default performance.now()); t0 values
//                                              below (reticle, ripples) are on this clock
//   dragging                                   a finger is down (drag / pinch)
//   lines { mode: 'focus' | 'drag' | 'off',    'off' fades every line out (1.8 s); 'drag' adds every segment
//           focusIds: [], selId,               within 45° of the centre at α.16 × smoothstep(45°, 15°) (in 400 ms,
//           origin: n, labels: true | false | ids,  out 1.8 s). focusIds grow in by stroke over 2.8 s at α.20,
//           alpha: 1 }                         staggered 0.35 s, from `origin` (NEU, default the view centre),
//                                              and fade over 1.8 s once removed; selId is drawn at α.36 at once
//                                              (S11). labels: which focus ids carry their name (11 px, α.50/.60).
//   names                                      target 0..1 for star names (default: dragging || fov < 45°):
//                                              ≤ 5 stars ≤ 2.0 等 (3.0 when fov < 45°) within 25°, plus the one
//                                              asterism nearest the centre; in 300 ms, out 1200 ms
//   reticle { n, t0, kind: 'hero' | 'sel' }    ember ticks, converging once: hero 16→9 px / 420 ms, sel 13×1.15→13
//                                              px / 240 ms; null (or a new n) fades the old one out in 240 ms
//   tags [{ n, text }]                         look-to-reveal tags / the hero's name: 10 px to the right (flipped
//                                              near the edge), α.62, 400 ms. The chrome decides which are shown.
//   marker { n, label }                        below-horizon target: 1 px line α.50 rising 18 px off the ridge,
//                                              label above (α.62); where that would sit under the stage text
//                                              (the stand framing puts the ridge in the caption band) the marker
//                                              rises from just above that text instead, still over its azimuth
//   horizonLine { zB, label, progress }        B's horizon: dashed great circle n·zB = 0 (1 px, 2/6, α.32),
//                                              drawn left→right with progress 0..1; label fades in near 1
//   compass, bodies                            0..1 multipliers (compass letters 北东南西 10 px α.26, 18 px under
//                                              the horizon; Moon and planets)
//   sunAlpha, bodyDim { id: factor }, moonScale, hover { type, index | id }   (hover: pass after 300 ms)
//
// Colour and type follow spec §2: lines rgba(200,214,236) 0.75 px, text #EFE8DA, the one ember #E7D3AF
// (the reticle only). No gold, no glow blobs, nothing loops.
import { terrainAtRad, ease } from './camera.js';
import { starName } from './facts.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const AU_KM = 149597870.7;
const R_MOON_KM = 1737.4;
const R_SUN_KM = 695700;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp1 = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
const sm = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const smooth = (a, b, x) => sm((x - a) / (b - a));

export const FONT_TEXT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
export const FONT_DISPLAY = '"Nawan Serif", "Songti SC", "STSong", serif';
export const FONT_NUM = `"Cormorant Lining", ${FONT_TEXT}`;
/** @deprecated use FONT_TEXT */ export const FONT_SANS = FONT_TEXT;
/** @deprecated use FONT_DISPLAY (fixed display strings only) */ export const FONT_SERIF = FONT_DISPLAY;
/** @deprecated use FONT_NUM (digits only) */ export const FONT_LATIN = FONT_NUM;

const C_LINE = 'rgb(200,214,236)';
const C_TEXT = 'rgb(239,232,218)';
const C_EMBER = 'rgb(231,211,175)';
const FONT_11 = `400 11px ${FONT_TEXT}`;
const FONT_10 = `400 10px ${FONT_TEXT}`;

// levels (α) and timings (ms): spec §2.2, §2.4, §3.4, S5, S9, S11, S13, S17
const AL = {
  focus: 0.20, sel: 0.36, drag: 0.16, astName: 0.50, selName: 0.60, starName: 0.62, tag: 0.62, compass: 0.26,
  markerLine: 0.50, markerLabel: 0.62, hline: 0.32, hlineLabel: 0.50, listenName: 0.70, ripple: 0.50, reticle: 0.92,
};
const MS = {
  grow: 2800, stagger: 350, linesIn: 400, linesOut: 1800, level: 300, label: 400, namesIn: 300, namesOut: 1200,
  dragIn: 400, dragOut: 1800, ripple: 900, listenName: 2000, reticleHero: 420, reticleSel: 240, reticleOut: 240, layout: 100,
};
const COMPASS = ['北', '东', '南', '西'];
const NO_LINES = { mode: 'off' };
const EMPTY = [];
const NO_DASH = [];

/** Atmospheric extinction (mag) at true altitude (rad): the renderer's Kasten–Young law, capped at 3.5. */
function extinctionMag(alt) {
  const a = Math.max(alt, 0);
  const X = 1 / (Math.sin(a) + 0.50572 * Math.pow(6.07995 + a / DEG, -1.6364));
  return Math.min(0.28 * (X - 1), 3.5);
}

function dirInto(out, az, alt) {
  const c = Math.cos(alt);
  out[0] = c * Math.cos(az); out[1] = c * Math.sin(az); out[2] = Math.sin(alt);
  return out;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

// ---------------------------------------------------------------- the skyline, looked up
// Heights of the shaders' ridge (camera.js terrainAtRad, exact to 1e-8 rad) in 0.02° bins, each computed
// the first time it is needed and linearly interpolated: sub-pixel even at fov 20°, and cheap enough to
// test every line sample against it.
class Skyline {
  constructor() {
    this.N = 18000;
    this.tab = new Float32Array(this.N);
    this.H = -1;
    this.max = 0;
    this.sinMax = 0;
    this.q = new Float64Array(3); // the direction aboveQ() tests (no arguments: doubles passed in are boxed)
  }

  set(H) {
    H = H > 0 ? H : 0;
    if (H === this.H) return false;
    this.H = H;
    this.tab.fill(NaN);
    this.max = 2.3 * H; // ridgeFar ≤ 2.25 H, ridgeNear ≤ 1.71 H
    this.sinMax = Math.sin(this.max + 0.003);
    return true;
  }

  /** Is the unit NEU direction in this.q above the skyline? */
  aboveQ() {
    const q = this.q, z = q[2];
    if (z > this.sinMax) return true;
    const alt = Math.asin(z > 1 ? 1 : z < -1 ? -1 : z);
    if (!(this.H > 0)) return alt > 0;
    let u = Math.atan2(q[1], q[0]) / TAU;
    u -= Math.floor(u);
    const x = u * this.N;
    const i = Math.min(this.N - 1, Math.floor(x)), j = i + 1 >= this.N ? 0 : i + 1;
    // (fill misses first, then read the table: a phi of a table load and a call result would box)
    if (this.tab[i] !== this.tab[i]) this.bin(i);
    if (this.tab[j] !== this.tab[j]) this.bin(j);
    const a = this.tab[i], b = this.tab[j];
    return alt > a + (b - a) * (x - i);
  }

  bin(i) {
    let v = this.tab[i];
    if (v !== v) { v = terrainAtRad((i / this.N) * TAU, this.H); this.tab[i] = v; }
    return v;
  }

  /** Skyline altitude (rad) at an azimuth (rad, any range). */
  at(az) {
    if (!(this.H > 0)) return 0;
    let u = az / TAU;
    u -= Math.floor(u);
    const x = u * this.N;
    const i = Math.min(this.N - 1, Math.floor(x));
    const j = i + 1 >= this.N ? 0 : i + 1;
    if (this.tab[i] !== this.tab[i]) this.bin(i);
    if (this.tab[j] !== this.tab[j]) this.bin(j);
    const a = this.tab[i], b = this.tab[j];
    return a + (b - a) * (x - i);
  }
}

// ---------------------------------------------------------------- constellation geometry
// Per culture, built once: unique vertices per asterism (EQJ), deduplicated segments, centroids and
// extents, and a gap per vertex that grows with the star's brightness so lines stop short of bright
// stars instead of running into their glow. NEU copies are refreshed once per sky moment.
const starGrids = new WeakMap();

function starGrid(catalog) {
  let g = starGrids.get(catalog);
  if (g) return g;
  const G = 90, map = new Map(), { pos, count } = catalog.stars;
  const cell = (x) => Math.max(0, Math.min(G - 1, Math.floor((x + 1) * 0.5 * G)));
  for (let i = 0; i < count; i++) {
    const k = (cell(pos[i * 3]) * G + cell(pos[i * 3 + 1])) * G + cell(pos[i * 3 + 2]);
    const list = map.get(k);
    if (list) list.push(i); else map.set(k, [i]);
  }
  g = { G, map, cell };
  starGrids.set(catalog, g);
  return g;
}

/** Magnitude of the catalogue star at an EQJ direction (within 0.15°), or 6.5. */
function magAt(catalog, x, y, z) {
  const { G, map, cell } = starGrid(catalog);
  const cx = cell(x), cy = cell(y), cz = cell(z);
  const { pos, mag } = catalog.stars;
  const lim = Math.cos(0.15 * DEG);
  let best = 6.5;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    const list = map.get(((cx + i) * G + cy + j) * G + cz + k);
    if (!list) continue;
    for (const s of list) {
      if (pos[s * 3] * x + pos[s * 3 + 1] * y + pos[s * 3 + 2] * z > lim && mag[s] < best) best = mag[s];
    }
  }
  return best;
}

function buildGeo(catalog, culture) {
  const set = culture === 'cn' ? catalog.cn : catalog.iau;
  const labels = new Map(set.labels.map((l) => [String(l.id), l]));
  const eq = [], sa = [], sb = [], asts = [];
  for (const [rawId, polys] of set.lines) {
    const id = String(rawId);
    const v0 = eq.length / 3, s0 = sa.length;
    const vk = new Map(), ek = new Set();
    for (const poly of polys) {
      let prev = -1;
      for (let j = 0; j + 2 < poly.length; j += 3) {
        const key = `${poly[j]},${poly[j + 1]},${poly[j + 2]}`;
        let v = vk.get(key);
        if (v === undefined) { v = eq.length / 3; eq.push(poly[j], poly[j + 1], poly[j + 2]); vk.set(key, v); }
        if (prev >= 0 && prev !== v) {
          const e = prev < v ? prev * 65536 + v : v * 65536 + prev;
          if (!ek.has(e)) { ek.add(e); sa.push(prev); sb.push(v); }
        }
        prev = v;
      }
    }
    const lab = labels.get(id);
    // 「杵(箕宿)」 → 杵: the catalogue's disambiguation is not for display
    const zh = lab ? String(lab.zh).replace(/[（(][^）)]*[）)]/g, '').trim() : '';
    asts.push({ id, zh, rank: lab ? lab.rank : 3, v0, v1: eq.length / 3, s0, s1: sa.length });
  }
  const nv = eq.length / 3, ns = sa.length, nA = asts.length;
  const g = {
    culture, nv, ns, nA, asts, byId: new Map(),
    eq: Float64Array.from(eq), neu: new Float64Array(nv * 3), gap: new Float32Array(nv), dist: new Float32Array(nv),
    vAst: new Uint16Array(nv), sa: Uint16Array.from(sa), sb: Uint16Array.from(sb), sLen: new Float32Array(ns),
    s0: new Int32Array(nA), s1: new Int32Array(nA), cEq: new Float64Array(nA * 3), cNeu: new Float64Array(nA * 3),
    ext: new Float32Array(nA), rank: new Uint8Array(nA), bright: new Float32Array(nA), vmag: new Float32Array(nv),
    aT: new Float32Array(nA), aV: new Float32Array(nA), aL: new Float32Array(nA), aPrev: new Float32Array(nA),
    aG0: new Float64Array(nA).fill(NaN), aF: new Float32Array(nA), aNamed: new Uint8Array(nA), mv: -1,
  };
  const E = g.eq;
  for (let s = 0; s < ns; s++) {
    const a = g.sa[s] * 3, b = g.sb[s] * 3;
    g.sLen[s] = Math.acos(clamp1(E[a] * E[b] + E[a + 1] * E[b + 1] + E[a + 2] * E[b + 2]));
  }
  for (let a = 0; a < nA; a++) {
    const A = asts[a];
    g.byId.set(A.id, a);
    g.s0[a] = A.s0; g.s1[a] = A.s1; g.rank[a] = A.rank;
    let x = 0, y = 0, z = 0;
    for (let v = A.v0; v < A.v1; v++) { x += E[v * 3]; y += E[v * 3 + 1]; z += E[v * 3 + 2]; g.vAst[v] = a; }
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    g.cEq[a * 3] = x; g.cEq[a * 3 + 1] = y; g.cEq[a * 3 + 2] = z;
    let ext = 0;
    for (let v = A.v0; v < A.v1; v++) ext = Math.max(ext, Math.acos(clamp1(E[v * 3] * x + E[v * 3 + 1] * y + E[v * 3 + 2] * z)));
    g.ext[a] = ext;
  }
  for (let v = 0; v < nv; v++) {
    const m = magAt(catalog, E[v * 3], E[v * 3 + 1], E[v * 3 + 2]);
    g.vmag[v] = m;
    g.gap[v] = 2.4 + Math.min(4.4, Math.max(0, 3.2 - m)) * 0.75; // CSS px: 2.4 for faint stars, ~5 for Vega
  }
  // how conspicuous an asterism is: the mean magnitude of its three brightest stars
  for (let a = 0; a < nA; a++) {
    const m = Array.from(g.vmag.subarray(asts[a].v0, asts[a].v1)).sort((x, y) => x - y).slice(0, 3);
    g.bright[a] = m.reduce((x, y) => x + y, 0) / Math.max(1, m.length);
  }
  return g;
}

/** Does segment (x0, y0)–(x1, y1) cross the box [bx0, bx1] × [by0, by1]? (Liang–Barsky, unrolled) */
function segHitsBox(x0, y0, x1, y1, bx0, by0, bx1, by1) {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 - bx0) && clip(dx, bx1 - x0) && clip(-dy, y0 - by0) && clip(dy, by1 - y0) && t0 <= t1;
}

function sameIds(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

class Label {
  constructor() {
    this.key = 0; this.kind = 0; this.ref = 0; this.text = ''; this.w = 0;
    this.a = 0; this.t = 0; this.slot = 0; this.base = 0; this.group = 0; this.cand = false;
  }
}

class Tag {
  constructor() {
    this.kind = 0; this.text = ''; this.w = 0; this.n = [0, 0, 0];
    this.a = 0; this.t = 0; this.side = 1; this.ok = false; this.x = 0; this.y = 0; this.lx = 0; this.ly0 = 0; this.ly1 = 0;
  }
}

const newReticle = () => ({ on: false, n: [0, 0, 0], t0: 0, given: undefined, kind: 'hero', tOut: 0 });

// ================================================================ Overlay
export class Overlay {
  constructor(canvas, catalog) {
    this.canvas = canvas || null;
    this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    this.catalog = catalog;
    this.w = 1; this.h = 1; this.dpr = 1;
    this._culture = 'cn';
    this._geos = { cn: null, iau: null };
    this.skyline = new Skyline();
    this._M = new Float64Array(9); this._Mv = 0; this._hasM = false;

    // named stars, brightest first: sky names (≤ 3.0 等) and picking (≤ 5.2 等)
    const named = [...catalog.names.values()].filter((s) => s.mag <= 5.2).sort((a, b) => a.mag - b.mag);
    this._nIdx = Int32Array.from(named, (s) => s.i);
    this._nMag = Float32Array.from(named, (s) => s.mag);
    this._nName = named.map((s) => starName(s));
    this._nHan = Uint8Array.from(this._nName, (t) => (/\p{Script=Han}/u.test(t) ? 1 : 0));
    this._nameOf = new Map(named.map((s, k) => [s.i, this._nName[k]]));

    this._ui = new Float32Array(64); this._nui = 0;
    this._box = new Float32Array(4 * 128); this._nbox = 0;
    this._bodyBox = new Float32Array(4 * 8); this._nbody = 0;
    const cap = 2048;
    this._pc = { xy: new Float32Array(cap * 4), b: new Uint8Array(cap), order: new Uint32Array(cap), count: new Uint32Array(256), n: 0, cap };
    this._vis = new Float64Array(64); this._iv = new Float64Array(3 * 64); this._sf = new Float64Array(4);
    this._A = [0, 0, 0]; this._B = [0, 0, 0]; this._v = [0, 0, 0]; this._u = [0, 0, 0];
    this._p = { x: 0, y: 0, d: 0 }; this._q = { x: 0, y: 0, d: 0 };
    this._hx = new Float32Array(512); this._hy = new Float32Array(512); this._hr = new Int32Array(64);
    this._dash = [2, 6];
    this._dragF = { v: 0, t: 0 };
    this._namesF = { v: 0, t: 0 };
    this._labels = []; this._labelMap = new Map(); this._pool = [];
    this._tags = []; this._tagPool = [];
    this._ret = newReticle(); this._retOld = newReticle(); this._retR = 0; this._rg = { r: 0, a: 0, r1: 0 };
    this._ripples = [];
    this._tw = new Map(); this._mctx = null;
    this._sprites = new Map(); this._cores = new Map();
    this._moon = { on: false, x: 0, y: 0, r: 0, n: [0, 0, 0] };
    this._moonOpts = { warm: 0, halo: 1 };
    this._hlOk = false; this._hlBox = new Float32Array(4);
    this._lx = 0; this._ly = 0; this._bx0 = 0; this._by0 = 0; this._bx1 = 0; this._by1 = 0;
    this._P = { live: true, unit: 1, now: 0, lineAlpha: 1, allAlpha: 0, lineWidth: 0.75, lineColor: C_LINE, culture: 'cn',
      dpr: 1, W: 1, H: 1, bodyInk: null, moonStyle: null, sun: 1 };
    this._in = { geo: undefined, mode: '', focus: EMPTY, sel: null, labels: true, sky: null, hl: null, hlp: -1, hlx: 0, hly: 0, hlz: 0,
      hll: '', compass: -1, bodies: -1, sun: -1, moonScale: -1, bodyDim: null, hover: null, hoverRef: null, tagText: [], tagN: [], marker: '', mN: [0, 0, 0] };
    this._last = { f0: 0, f1: 0, f2: 0, r0: 0, r1: 0, r2: 0, fov: -1, P: -1, cx: 0, cy: 0, w: 0, h: 0 };
    this._lineAlpha = 1;
    this._dirty = true; this._layoutDirty = true; this._layoutStale = true; this._lastLayout = -1e9;
    this._lastNow = null; this._growing = false;
    this.stats = { draws: 0, paints: 0, layouts: 0, pieces: 0 };
  }

  // -------------------------------------------------------------- setup
  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    if (this.canvas) {
      const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    }
    this.markDirty();
  }

  get culture() { return this._culture; }
  set culture(c) { this.setCulture(c); }

  setCulture(c) {
    c = c === 'cn' || c === 'iau' ? c : 'none';
    if (c === this._culture) return;
    const old = this._geos[this._culture];
    if (old) { old.aT.fill(0); old.aV.fill(0); old.aL.fill(0); old.aG0.fill(NaN); }
    this._culture = c;
    for (let i = this._labels.length - 1; i >= 0; i--) if (this._labels[i].kind === 1) this._dropLabel(i);
    this._in.geo = undefined; // re-apply the focus ids to the new culture
    this.markDirty();
  }

  setUIRects(rects = []) {
    if (this._ui.length < rects.length * 4) this._ui = new Float32Array(rects.length * 4);
    let k = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) continue;
      const w = r.w ?? r.width, h = r.h ?? r.height;
      if (!(w > 0) || !(h > 0)) continue;
      this._ui[k * 4] = r.x - 4; this._ui[k * 4 + 1] = r.y - 4; this._ui[k * 4 + 2] = r.x + w + 4; this._ui[k * 4 + 3] = r.y + h + 4;
      k++;
    }
    this._nui = k;
    this.markDirty();
  }

  markDirty() { this._dirty = true; this._layoutDirty = true; }

  clear() {
    if (!this.ctx) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._dirty = true;
  }

  addRipple(n, t0, opts) {
    if (!n || typeof n === 'number') return; // (the old screen-space signature is gone)
    const R = this._ripples;
    let r = null;
    for (let i = 0; i < R.length; i++) if (!R[i].on) { r = R[i]; break; }
    if (!r) {
      if (R.length < 24) { r = { n: [0, 0, 0], t0: 0, on: false, label: '', w: 0 }; R.push(r); }
      else { r = R[0]; for (let i = 1; i < R.length; i++) if (R[i].t0 < r.t0) r = R[i]; }
    }
    r.n[0] = n[0]; r.n[1] = n[1]; r.n[2] = n[2];
    r.t0 = t0 ?? (typeof performance !== 'undefined' ? performance.now() : 0);
    r.label = (opts && opts.label) || '';
    r.w = r.label ? this._measure(r.label) : 0;
    r.on = true;
    this._dirty = true;
  }

  // -------------------------------------------------------------- the frame
  draw(s) {
    this.stats.draws++;
    if (!s || !s.cam || !this.ctx) return false;
    const now = s.now ?? performance.now();
    const dt = this._lastNow === null ? 16 : Math.min(250, Math.max(0, now - this._lastNow));
    this._lastNow = now;
    const cam = s.cam;
    this._sync(s, now);
    const anim = this._step(dt, now);
    const moved = this._camMoved(cam);
    if (moved) this._layoutStale = true;
    if (!this._dirty && !anim && !moved) return false;
    this._render(s, now, moved);
    this._dirty = false;
    this.stats.paints++;
    return true;
  }

  _render(s, now, moved) {
    const ctx = this.ctx, cam = s.cam, P = this._P;
    const thin = this.dpr >= 1.5;
    P.live = true; P.unit = 1; P.now = now; P.lineAlpha = this._lineAlpha * (thin ? 1 : 0.75); P.allAlpha = 0; P.lineWidth = thin ? 0.75 : 1;
    P.lineColor = C_LINE; P.culture = this._culture; P.dpr = this.dpr; P.W = this.w; P.H = this.h;
    P.bodyInk = null; P.moonStyle = null; P.sun = s.sunAlpha ?? 1;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalAlpha = 1;
    if (this._hasM) this._lines(ctx, cam, P);
    this._hlOk = false;
    if (s.horizonLine) this._horizonLine(ctx, cam, P, s.horizonLine);
    this._bodies(ctx, s, P);
    this._drawRipples(ctx, cam, now);
    this._drawReticle(ctx, cam, now);
    this._placeTags(cam);
    const needLayout = this._layoutDirty
      || (this._layoutStale && (!moved || now - this._lastLayout >= MS.layout))
      || (this._growing && now - this._lastLayout >= MS.layout);
    if (needLayout) this._layout(cam, s, now);
    this._drawLabels(ctx, cam, s);
    this._drawTags(ctx);
    ctx.globalAlpha = 1;
    const l = this._last, f = cam.f, r = cam.r;
    l.f0 = f[0]; l.f1 = f[1]; l.f2 = f[2]; l.r0 = r[0]; l.r1 = r[1]; l.r2 = r[2];
    l.fov = cam.fov; l.P = cam.P; l.cx = cam.cx; l.cy = cam.cy; l.w = cam.w; l.h = cam.h;
  }

  _camMoved(cam) {
    const l = this._last, f = cam.f, r = cam.r;
    const thr = Math.min(0.02 * DEG, 0.25 / Math.max(1, cam.pxPerRad()));
    const c = Math.cos(thr);
    return f[0] * l.f0 + f[1] * l.f1 + f[2] * l.f2 < c || r[0] * l.r0 + r[1] * l.r1 + r[2] * l.r2 < c
      || Math.abs(cam.fov - l.fov) > 0.01 || Math.abs(cam.P - l.P) > 1e-4
      || cam.cx !== l.cx || cam.cy !== l.cy || cam.w !== l.w || cam.h !== l.h;
  }

  // -------------------------------------------------------------- inputs → targets
  _sync(s, now) {
    const I = this._in;
    let d = false;
    if (this.skyline.set(s.terrainH)) d = true;
    if (s.M && this._setM(s.M)) d = true;
    if (s.sky !== I.sky) { I.sky = s.sky; d = true; }
    this._syncLines(s, now);
    const nt = clamp01(+(s.names ?? (s.dragging || s.cam.fov < 45 ? 1 : 0)) || 0);
    if (nt !== this._namesF.t) { this._namesF.t = nt; this._layoutDirty = true; }
    this._syncReticle(s, now);
    this._syncTags(s);
    const hl = s.horizonLine || null;
    if (hl !== I.hl || (hl && (hl.progress !== I.hlp || hl.label !== I.hll || hl.zB[0] !== I.hlx || hl.zB[1] !== I.hly || hl.zB[2] !== I.hlz))) {
      I.hl = hl;
      if (hl) { I.hlp = hl.progress; I.hll = hl.label; I.hlx = hl.zB[0]; I.hly = hl.zB[1]; I.hlz = hl.zB[2]; }
      d = true; this._layoutDirty = true;
    }
    const compass = s.compass ?? 0, bodies = s.bodies ?? 1, sun = s.sunAlpha ?? 1, ms = s.moonScale ?? 1;
    if (compass !== I.compass) { if ((compass > 0) !== (I.compass > 0)) this._layoutDirty = true; I.compass = compass; d = true; }
    if (bodies !== I.bodies || sun !== I.sun || ms !== I.moonScale || (s.bodyDim || null) !== I.bodyDim) {
      I.bodies = bodies; I.sun = sun; I.moonScale = ms; I.bodyDim = s.bodyDim || null; d = true;
    }
    const hv = s.hover || null;
    const hvType = hv ? hv.type : null, hvRef = hv ? (hv.type === 'star' ? hv.index : hv.id) : null;
    if (hvType !== I.hover || hvRef !== I.hoverRef) { I.hover = hvType; I.hoverRef = hvRef; this._layoutDirty = true; d = true; }
    if (d) this._dirty = true;
  }

  _setM(M) {
    const m = this._M;
    let same = this._hasM;
    if (same) for (let i = 0; i < 9; i++) if (m[i] !== M[i]) { same = false; break; }
    if (same) return false;
    for (let i = 0; i < 9; i++) m[i] = M[i];
    this._hasM = true;
    this._Mv++;
    this._layoutDirty = true;
    return true;
  }

  _geo(c = this._culture) {
    if (c !== 'cn' && c !== 'iau') return null;
    return this._geos[c] || (this._geos[c] = buildGeo(this.catalog, c));
  }

  _ensureNeu(g) {
    if (g.mv === this._Mv || !this._hasM) return;
    const M = this._M, E = g.eq, N = g.neu, C = g.cEq, CN = g.cNeu;
    for (let i = 0; i < g.nv * 3; i += 3) {
      const x = E[i], y = E[i + 1], z = E[i + 2];
      N[i] = M[0] * x + M[3] * y + M[6] * z; N[i + 1] = M[1] * x + M[4] * y + M[7] * z; N[i + 2] = M[2] * x + M[5] * y + M[8] * z;
    }
    for (let i = 0; i < g.nA * 3; i += 3) {
      const x = C[i], y = C[i + 1], z = C[i + 2];
      CN[i] = M[0] * x + M[3] * y + M[6] * z; CN[i + 1] = M[1] * x + M[4] * y + M[7] * z; CN[i + 2] = M[2] * x + M[5] * y + M[8] * z;
    }
    g.mv = this._Mv;
  }

  _starNeu(i, out) {
    const M = this._M, pos = this.catalog.stars.pos, x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    out[0] = M[0] * x + M[3] * y + M[6] * z; out[1] = M[1] * x + M[4] * y + M[7] * z; out[2] = M[2] * x + M[5] * y + M[8] * z;
    return out;
  }

  _syncLines(s, now) {
    const L = s.lines || NO_LINES;
    const mode = L.mode === 'focus' || L.mode === 'drag' ? L.mode : 'off';
    const g = this._geo();
    this._dragF.t = mode === 'drag' && g ? 1 : 0;
    const la = L.alpha ?? 1;
    if (la !== this._lineAlpha) { this._lineAlpha = la; this._dirty = true; }
    const ids = mode === 'off' ? EMPTY : (L.focusIds || EMPTY);
    const sel = mode === 'off' ? null : (L.selId ?? null);
    const labels = L.labels ?? true;
    const I = this._in;
    const sameLabels = labels === I.labels || (Array.isArray(labels) && Array.isArray(I.labels) && sameIds(labels, I.labels));
    if (g === I.geo && mode === I.mode && sel === I.sel && sameLabels && sameIds(ids, I.focus)) return;
    I.geo = g; I.mode = mode; I.sel = sel; I.labels = Array.isArray(labels) ? labels.slice() : labels; I.focus = ids.slice();
    this._dirty = true; this._layoutDirty = true;
    if (!g) return;
    for (let a = 0; a < g.nA; a++) { g.aPrev[a] = g.aT[a]; g.aT[a] = 0; g.aNamed[a] = 0; }
    const named = (id) => labels === true || (Array.isArray(labels) && labels.some((x) => String(x) === id));
    for (let i = 0; i < ids.length; i++) {
      const a = g.byId.get(String(ids[i]));
      if (a === undefined) continue;
      g.aT[a] = AL.focus;
      g.aNamed[a] = named(g.asts[a].id) ? 1 : 0;
    }
    const sa = sel === null ? undefined : g.byId.get(String(sel));
    if (sa !== undefined) { g.aT[sa] = AL.sel; g.aNamed[sa] = 1; }
    // asterisms that just appeared (and are not still fading out) grow in by stroke, staggered in the
    // order given, outward from the origin (the hero, or where the viewer is looking)
    const origin = L.origin || s.cam.f;
    let k = 0;
    for (let i = 0; i < ids.length; i++) {
      const a = g.byId.get(String(ids[i]));
      if (a === undefined || a === sa || g.aPrev[a] > 0) continue;
      if (g.aG0[a] === g.aG0[a] && g.aV[a] > 0) continue; // still on screen: fade back, no regrowth
      this._grow(g, a, origin);
      g.aG0[a] = now + MS.stagger * k++;
      g.aL[a] = g.aT[a];
    }
    if (sa !== undefined && !(g.aG0[sa] === g.aG0[sa])) { g.aG0[sa] = -Infinity; if (g.aV[sa] === 0) g.aL[sa] = AL.sel; }
  }

  /** Path distances from the origin along the asterism's own lines (the pen's route for the stroke growth). */
  _grow(g, a, o) {
    this._ensureNeu(g);
    const A = g.asts[a], v0 = A.v0, v1 = A.v1, dist = g.dist, N = g.neu;
    const done = new Uint8Array(v1 - v0);
    for (let v = v0; v < v1; v++) dist[v] = Infinity;
    let minSeed = Infinity;
    for (;;) {
      // each connected piece starts at its vertex nearest the origin
      let best = -1, bestAng = Infinity;
      for (let v = v0; v < v1; v++) {
        if (dist[v] !== Infinity) continue;
        const ang = Math.acos(clamp1(N[v * 3] * o[0] + N[v * 3 + 1] * o[1] + N[v * 3 + 2] * o[2]));
        if (ang < bestAng) { bestAng = ang; best = v; }
      }
      if (best < 0) break;
      dist[best] = bestAng;
      if (bestAng < minSeed) minSeed = bestAng;
      for (;;) {
        let u = -1, du = Infinity;
        for (let v = v0; v < v1; v++) if (!done[v - v0] && dist[v] < du) { du = dist[v]; u = v; }
        if (u < 0) break;
        done[u - v0] = 1;
        for (let s = A.s0; s < A.s1; s++) {
          const x = g.sa[s], y = g.sb[s];
          const w = x === u ? y : y === u ? x : -1;
          if (w < 0 || done[w - v0]) continue;
          const nd = du + g.sLen[s];
          if (nd < dist[w]) dist[w] = nd;
        }
      }
    }
    let fmax = 0;
    for (let v = v0; v < v1; v++) { dist[v] -= minSeed; if (dist[v] > fmax) fmax = dist[v]; }
    g.aF[a] = Math.max(fmax, 1e-4);
  }

  _syncReticle(s, now) {
    const r = s.reticle && s.reticle.n ? s.reticle : null;
    const R = this._ret, O = this._retOld;
    if (!r) {
      if (R.on) { this._retire(now); this._dirty = true; this._layoutDirty = true; }
      return;
    }
    const kind = r.kind === 'sel' ? 'sel' : 'hero';
    const same = R.on && R.n[0] === r.n[0] && R.n[1] === r.n[1] && R.n[2] === r.n[2];
    if (same && R.kind === kind && R.given === r.t0) return;
    if (R.on && !same) this._retire(now);
    else if (!R.on) O.on = O.on && now - O.tOut < MS.reticleOut;
    R.on = true; R.kind = kind; R.given = r.t0; R.t0 = r.t0 ?? now;
    R.n[0] = r.n[0]; R.n[1] = r.n[1]; R.n[2] = r.n[2];
    this._dirty = true; this._layoutDirty = true;
  }

  _retire(now) {
    const R = this._ret, O = this._retOld;
    O.on = true; O.kind = R.kind; O.t0 = R.t0; O.tOut = now; O.n[0] = R.n[0]; O.n[1] = R.n[1]; O.n[2] = R.n[2];
    R.on = false;
  }

  _syncTags(s) {
    const list = s.tags || EMPTY, mk = s.marker && s.marker.n ? s.marker : null;
    const I = this._in;
    let same = list.length === I.tagText.length && (mk ? mk.label : '') === I.marker;
    for (let i = 0; same && i < list.length; i++) {
      const t = list[i], n = t.n;
      if (t.text !== I.tagText[i] || n[0] !== I.tagN[i * 3] || n[1] !== I.tagN[i * 3 + 1] || n[2] !== I.tagN[i * 3 + 2]) same = false;
    }
    if (same && mk && (mk.n[0] !== I.mN[0] || mk.n[1] !== I.mN[1] || mk.n[2] !== I.mN[2])) same = false;
    if (same) return;
    I.tagText.length = list.length; I.tagN.length = list.length * 3;
    for (let i = 0; i < list.length; i++) {
      I.tagText[i] = list[i].text; I.tagN[i * 3] = list[i].n[0]; I.tagN[i * 3 + 1] = list[i].n[1]; I.tagN[i * 3 + 2] = list[i].n[2];
    }
    I.marker = mk ? mk.label : '';
    if (mk) { I.mN[0] = mk.n[0]; I.mN[1] = mk.n[1]; I.mN[2] = mk.n[2]; }
    const T = this._tags;
    for (let i = 0; i < T.length; i++) T[i].t = 0;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].n && list[i].text) this._tagOn(0, list[i].text, list[i].n);
    if (mk && mk.label) this._tagOn(1, mk.label, mk.n);
    this._dirty = true; this._layoutDirty = true;
  }

  _tagOn(kind, text, n) {
    let T = null;
    for (let i = 0; i < this._tags.length; i++) if (this._tags[i].kind === kind && this._tags[i].text === text) { T = this._tags[i]; break; }
    if (!T) {
      T = this._tagPool.pop() || new Tag();
      T.kind = kind; T.text = text; T.w = this._measure(text); T.a = 0; T.side = 1; T.ok = false;
      this._tags.push(T);
    }
    T.t = 1;
    T.n[0] = n[0]; T.n[1] = n[1]; T.n[2] = n[2];
  }

  // -------------------------------------------------------------- fades (every draw() call)
  _step(dt, now) {
    let anim = false;
    anim = stepFade(this._dragF, dt, MS.dragIn, MS.dragOut) || anim;
    anim = stepFade(this._namesF, dt, MS.namesIn, MS.namesOut) || anim;
    this._growing = false;
    const g = this._geo();
    if (g) {
      for (let a = 0; a < g.nA; a++) {
        const T = g.aT[a];
        const tv = T > 0 ? 1 : 0;
        let v = g.aV[a];
        if (v !== tv) {
          v = tv > v ? Math.min(1, v + dt / MS.linesIn) : Math.max(0, v - dt / MS.linesOut);
          g.aV[a] = v;
          anim = true;
          if (v === 0 && tv === 0) g.aG0[a] = NaN; // gone: the next focus grows it again
        }
        if (T > 0 && g.aL[a] !== T) {
          const L = g.aL[a], st = dt * (AL.sel - AL.focus) / MS.level;
          g.aL[a] = T > L ? Math.min(T, L + st) : Math.max(T, L - st);
          anim = true;
        }
        const g0 = g.aG0[a];
        if (v > 0 && g0 === g0 && g0 !== -Infinity && now < g0 + MS.grow + 32) { anim = true; this._growing = true; }
      }
    }
    const Ls = this._labels;
    for (let i = Ls.length - 1; i >= 0; i--) {
      const L = Ls[i];
      if (L.a !== L.t) { L.a = L.t > L.a ? Math.min(L.t, L.a + dt / MS.label) : Math.max(L.t, L.a - dt / MS.label); anim = true; }
      if (L.a === 0 && L.t === 0) this._dropLabel(i);
    }
    const T = this._tags;
    for (let i = T.length - 1; i >= 0; i--) {
      const t = T[i];
      if (t.a !== t.t) { t.a = t.t > t.a ? Math.min(t.t, t.a + dt / MS.label) : Math.max(t.t, t.a - dt / MS.label); anim = true; }
      if (t.a === 0 && t.t === 0) { T[i] = T[T.length - 1]; T.pop(); this._tagPool.push(t); anim = true; }
    }
    const R = this._ret, O = this._retOld;
    if (R.on && now - R.t0 < (R.kind === 'sel' ? MS.reticleSel : MS.reticleHero) + 32) anim = true;
    if (O.on) { anim = true; if (now - O.tOut >= MS.reticleOut) O.on = false; }
    const rp = this._ripples;
    for (let i = 0; i < rp.length; i++) {
      const r = rp[i];
      if (!r.on) continue;
      anim = true;
      if (now - r.t0 >= (r.label ? MS.listenName : MS.ripple)) r.on = false;
    }
    return anim;
  }

  _dropLabel(i) {
    const Ls = this._labels, L = Ls[i];
    Ls[i] = Ls[Ls.length - 1];
    Ls.pop();
    this._labelMap.delete(L.key);
    this._pool.push(L);
  }

  // -------------------------------------------------------------- lines
  _lines(ctx, cam, P) {
    const g = this._geo(P.culture);
    if (!g) return;
    const live = P.live;
    const dragV = live ? sm(this._dragF.v) : 0;
    let any = !live;
    if (live) for (let a = 0; a < g.nA && !any; a++) if (g.aV[a] > 0) any = true;
    if (!any && dragV <= 0.002) return;
    this._ensureNeu(g);
    const f = cam.f, pc = this._pc;
    pc.n = 0;
    const master = P.lineAlpha;
    const cullAng = live ? 0 : Math.min(89, cam.diagFov / 2 + 4) * DEG;
    for (let a = 0; a < g.nA; a++) {
      const fv = live ? g.aV[a] : 1;
      const focusA = live ? sm(fv) * g.aL[a] : P.allAlpha;
      if (focusA <= 0.002 && dragV <= 0.002) continue;
      const c3 = a * 3;
      const cAng = Math.acos(clamp1(g.cNeu[c3] * f[0] + g.cNeu[c3 + 1] * f[1] + g.cNeu[c3 + 2] * f[2]));
      if (live && focusA <= 0.002 && cAng - g.ext[a] > 46 * DEG) continue; // drag only: outside the mask
      if (!live && cAng - g.ext[a] > cullAng) continue;
      let F = Infinity;
      if (live && focusA > 0.002) {
        const g0 = g.aG0[a];
        if (g0 === g0 && g0 !== -Infinity) {
          const u = (P.now - g0) / MS.grow;
          F = u >= 1 ? Infinity : u <= 0 ? -1 : g.aF[a] * ease.fade(u);
        }
      }
      // per-asterism values go through a typed scratch (doubles passed as arguments are boxed)
      const sf = this._sf;
      sf[0] = focusA * (1 - dragV) * master; sf[1] = dragV * master; sf[2] = F; sf[3] = P.unit;
      for (let s = g.s0[a]; s < g.s1[a]; s++) this._seg(g, s, cam);
    }
    this.stats.pieces = pc.n;
    this._stroke(ctx, P);
  }

  /** One segment: the grown part at the focus alpha, the rest at the drag alpha, only where it is sky. */
  _seg(g, s, cam) {
    const sf = this._sf, fA = sf[0], dA0 = sf[1], F = sf[2], unit = sf[3];
    const ia = g.sa[s], ib = g.sb[s], N = g.neu, A = this._A, B = this._B;
    A[0] = N[ia * 3]; A[1] = N[ia * 3 + 1]; A[2] = N[ia * 3 + 2];
    B[0] = N[ib * 3]; B[1] = N[ib * 3 + 1]; B[2] = N[ib * 3 + 2];
    let dA = 0;
    if (dA0 > 0.002) {
      const mx = A[0] + B[0], my = A[1] + B[1], mz = A[2] + B[2], ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1, f = cam.f;
      const c = (mx * f[0] + my * f[1] + mz * f[2]) / ml;
      const th = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
      dA = AL.drag * dA0 * smooth(45 * DEG, 15 * DEG, th);
    }
    const gA = fA + dA; // the grown part: focus (yielding to the drag layer) plus the drag layer
    if (gA < 0.003) return;
    let pa = 1, pb = 0; // grown: [0, pa] ∪ [1 − pb, 1]
    if (F !== Infinity) {
      const len = g.sLen[s];
      pa = clamp01((F - g.dist[ia]) / len);
      pb = clamp01((F - g.dist[ib]) / len);
      if (pa + pb >= 1) { pa = 1; pb = 0; }
      if (pa === 0 && pb === 0 && dA < 0.003) return;
    }
    const nvis = this._visible(cam);
    if (!nvis) return;
    // stop short of the stars: the gap is in CSS px, turned into the segment's parameter
    let Lpx;
    const p = this._p, q = this._q;
    if (cam.project(A, p) && cam.project(B, q)) { const dx = q.x - p.x, dy = q.y - p.y; Lpx = Math.sqrt(dx * dx + dy * dy); }
    else Lpx = g.sLen[s] * cam.pxPerRad();
    const ga = g.gap[ia] * unit, gb = g.gap[ib] * unit;
    if (Lpx < ga + gb + 2 * unit) return;
    const t0 = ga / Lpx, t1 = 1 - gb / Lpx;
    const vis = this._vis, iv = this._iv;
    let n = 0;
    for (let k = 0; k < nvis && n < 60; k++) {
      const lo = Math.max(vis[k * 2], t0), hi = Math.min(vis[k * 2 + 1], t1);
      if (hi <= lo) continue;
      if (pa >= 1) { iv[n * 3] = lo; iv[n * 3 + 1] = hi; iv[n * 3 + 2] = gA; n++; continue; }
      if (pa > 0) { iv[n * 3] = lo; iv[n * 3 + 1] = Math.min(hi, pa); iv[n * 3 + 2] = gA; n++; }
      if (pb > 0) { iv[n * 3] = Math.max(lo, 1 - pb); iv[n * 3 + 1] = hi; iv[n * 3 + 2] = gA; n++; }
      if (dA >= 0.003) { iv[n * 3] = Math.max(lo, pa); iv[n * 3 + 1] = Math.min(hi, 1 - pb); iv[n * 3 + 2] = dA; n++; }
    }
    if (n) this._emit(cam, n, s, g);
  }

  /**
   * Visible parameter intervals of the arc A→B (in front of the camera and above the skyline), into
   * this._vis; returns their count. Sampled every 0.25° only where it can meet the ridge, then bisected.
   */
  _visible(cam) {
    const A = this._A, B = this._B, f = cam.f, vis = this._vis, sk = this.skyline, P = cam.P;
    const band = Math.sin(sk.max + 0.003);
    const da = P + A[0] * f[0] + A[1] * f[1] + A[2] * f[2], db = P + B[0] * f[0] + B[1] * f[1] + B[2] * f[2];
    // an arc this short cannot dip between two ends that clear both limits
    if (A[2] > band && B[2] > band && da > 0.08 && db > 0.08) { vis[0] = 0; vis[1] = 1; return 1; }
    const c = A[0] * B[0] + A[1] * B[1] + A[2] * B[2];
    const ang = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
    const K = Math.min(160, Math.max(4, Math.ceil(ang / (0.25 * DEG))));
    const ax = A[0], ay = A[1], az = A[2], bx = B[0] - ax, by = B[1] - ay, bz = B[2] - az, f0 = f[0], f1 = f[1], f2 = f[2], sq = sk.q;
    let n = 0, prevT = 0, prevOk = false, start = 0;
    for (let i = 0; i <= K; i++) {
      const t = i / K;
      // (the sky test, inline)
      let x = ax + bx * t, y = ay + by * t, z = az + bz * t;
      let l = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= l; y /= l; z /= l;
      sq[0] = x; sq[1] = y; sq[2] = z;
      const ok = P + x * f0 + y * f1 + z * f2 >= 0.08 && sk.aboveQ();
      if (i === 0) { prevOk = ok; continue; }
      if (ok !== prevOk) {
        let lo = prevT, hi = t;
        for (let j = 0; j < 12; j++) {
          const m = (lo + hi) / 2;
          x = ax + bx * m; y = ay + by * m; z = az + bz * m;
          l = Math.sqrt(x * x + y * y + z * z) || 1;
          x /= l; y /= l; z /= l;
          sq[0] = x; sq[1] = y; sq[2] = z;
          const om = P + x * f0 + y * f1 + z * f2 >= 0.08 && sk.aboveQ();
          if (om === prevOk) lo = m; else hi = m;
        }
        if (ok) start = hi;
        else if (n < 31) { vis[n * 2] = start; vis[n * 2 + 1] = lo; n++; }
      }
      prevOk = ok; prevT = t;
    }
    if (prevOk && n < 32) { vis[n * 2] = start; vis[n * 2 + 1] = 1; n++; }
    return n;
  }

  /** Queue the parameter intervals in this._iv of arc A→B (subdivided where the projection curves it). */
  _emit(cam, n, s, g) {
    const A = this._A, B = this._B, v = this._v, p = this._p, iv = this._iv, pc = this._pc, arc = g.sLen[s];
    const curved = cam.P > 0.02;
    for (let j = 0; j < n; j++) {
      const t0 = iv[j * 3], t1 = iv[j * 3 + 1], alpha = iv[j * 3 + 2];
      if (t1 - t0 < 1e-4 || alpha < 0.003) continue;
      const k = curved ? Math.max(1, Math.ceil((arc * (t1 - t0)) / (3 * DEG))) : 1;
      const bucket = Math.max(1, Math.min(255, Math.round(alpha * 255)));
      let px = 0, py = 0;
      for (let i = 0; i <= k; i++) {
        const t = t0 + ((t1 - t0) * i) / k;
        const x = A[0] + (B[0] - A[0]) * t, y = A[1] + (B[1] - A[1]) * t, z = A[2] + (B[2] - A[2]) * t;
        const l = Math.sqrt(x * x + y * y + z * z) || 1;
        v[0] = x / l; v[1] = y / l; v[2] = z / l;
        if (!cam.project(v, p)) break;
        if (i > 0) {
          if (pc.n === pc.cap) this._morePieces();
          const q = pc.n++, xy = pc.xy;
          xy[q * 4] = px; xy[q * 4 + 1] = py; xy[q * 4 + 2] = p.x; xy[q * 4 + 3] = p.y;
          pc.b[q] = bucket;
        }
        px = p.x; py = p.y;
      }
    }
  }

  _morePieces() {
    const pc = this._pc, cap = pc.cap * 2;
    const xy = new Float32Array(cap * 4); xy.set(pc.xy); pc.xy = xy;
    const b = new Uint8Array(cap); b.set(pc.b); pc.b = b;
    pc.order = new Uint32Array(cap);
    pc.cap = cap;
  }

  /** Is a NEU direction sky (in front of the camera and above the skyline)? */
  _okVec(cam, x, y, z) {
    const f = cam.f;
    if (cam.P + x * f[0] + y * f[1] + z * f[2] < 0.08) return false;
    const q = this.skyline.q;
    q[0] = x; q[1] = y; q[2] = z;
    return this.skyline.aboveQ();
  }

  /** One path per alpha bucket (1/255 steps: the 8-bit resolution of the canvas itself). */
  _stroke(ctx, P) {
    const pc = this._pc, n = pc.n;
    if (!n) return;
    const cnt = pc.count, xy = pc.xy, ord = pc.order;
    cnt.fill(0);
    for (let i = 0; i < n; i++) cnt[pc.b[i]]++;
    let acc = 0;
    for (let b = 0; b < 256; b++) { const c = cnt[b]; cnt[b] = acc; acc += c; }
    for (let i = 0; i < n; i++) ord[cnt[pc.b[i]]++] = i; // cnt[b] now marks the end of bucket b
    ctx.strokeStyle = P.lineColor;
    ctx.lineWidth = P.lineWidth;
    ctx.lineCap = 'round';
    let i = 0;
    while (i < n) {
      const b = pc.b[ord[i]], end = cnt[b];
      ctx.globalAlpha = b / 255;
      ctx.beginPath();
      for (; i < end; i++) {
        const k = ord[i] * 4;
        ctx.moveTo(xy[k], xy[k + 1]);
        ctx.lineTo(xy[k + 2], xy[k + 3]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- B's horizon (S17)
  _horizonLine(ctx, cam, P, hl) {
    const zB = hl.zB;
    if (!zB) return;
    let zx = zB[0], zy = zB[1], zz = zB[2];
    const zl = Math.hypot(zx, zy, zz);
    if (zl < 0.5) return;
    zx /= zl; zy /= zl; zz /= zl;
    // the great circle n·zB = 0 as cos θ·e1 + sin θ·e2
    let e1x = zy, e1y = -zx;
    let l = Math.hypot(e1x, e1y);
    if (l < 1e-4) { e1x = 1; e1y = 0; l = 1; }
    e1x /= l; e1y /= l;
    const e2x = -zz * e1y, e2y = zz * e1x, e2z = zx * e1y - zy * e1x;
    const th0 = e2z > 0 ? -Math.PI / 2 : Math.PI / 2; // start at its lowest point, always hidden
    const v = this._v, p = this._p, hx = this._hx, hy = this._hy, runs = this._hr, f = cam.f, Pc = cam.P, sk = this.skyline, sq = sk.q;
    const N = 180, step = TAU / N; // every 2°
    let np = 0, nr = 0, prevOk = false, prevTh = th0;
    for (let k = 0; k <= N && nr < 31; k++) {
      const th = th0 + k * step;
      let c = Math.cos(th), sn = Math.sin(th);
      const x = c * e1x + sn * e2x, y = c * e1y + sn * e2y, z = sn * e2z;
      sq[0] = x; sq[1] = y; sq[2] = z;
      const o = Pc + x * f[0] + y * f[1] + z * f[2] >= 0.08 && sk.aboveQ();
      if (k === 0) {
        prevOk = o;
        if (o) { runs[0] = 0; v[0] = x; v[1] = y; v[2] = z; if (cam.project(v, p)) { hx[0] = p.x; hy[0] = p.y; np = 1; } }
        continue;
      }
      if (o !== prevOk) {
        // bisect the crossing so a run ends exactly on the skyline (or the camera's edge)
        let lo = prevTh, hi = th;
        for (let j = 0; j < 12; j++) {
          const m = (lo + hi) / 2;
          c = Math.cos(m); sn = Math.sin(m);
          const mx = c * e1x + sn * e2x, my = c * e1y + sn * e2y, mz = sn * e2z;
          sq[0] = mx; sq[1] = my; sq[2] = mz;
          const om = Pc + mx * f[0] + my * f[1] + mz * f[2] >= 0.08 && sk.aboveQ();
          if (om === prevOk) lo = m; else hi = m;
        }
        const tc = o ? hi : lo;
        c = Math.cos(tc); sn = Math.sin(tc);
        v[0] = c * e1x + sn * e2x; v[1] = c * e1y + sn * e2y; v[2] = sn * e2z;
        if (o) runs[nr * 2] = np;
        if (np < 511 && cam.project(v, p)) { hx[np] = p.x; hy[np] = p.y; np++; }
        if (!o) { runs[nr * 2 + 1] = np; nr++; }
      }
      if (o) { v[0] = x; v[1] = y; v[2] = z; if (np < 511 && cam.project(v, p)) { hx[np] = p.x; hy[np] = p.y; np++; } }
      prevOk = o; prevTh = th;
    }
    if (prevOk && nr < 32) { runs[nr * 2 + 1] = np; nr++; }
    if (!nr) return;
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < np; i++) {
      if (hy[i] < -2 || hy[i] > P.H + 2) continue;
      const x = Math.max(0, Math.min(P.W, hx[i]));
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    if (!(x0 <= x1)) return;
    const prog = clamp01(hl.progress ?? 1), unit = P.unit;
    const xr = x0 + (x1 - x0) * prog;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-10 * unit, -10 * unit, xr + 10 * unit, P.H + 20 * unit);
    ctx.clip();
    ctx.strokeStyle = hl.color || C_TEXT;
    ctx.globalAlpha = hl.alpha ?? AL.hline;
    ctx.lineWidth = (hl.width ?? 1) * unit;
    const dash = hl.dash || null;
    this._dash[0] = (dash ? dash[0] : 2) * unit; this._dash[1] = (dash ? dash[1] : 6) * unit;
    ctx.setLineDash(this._dash);
    ctx.lineDashOffset = 0;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let r = 0; r < nr; r++) {
      const a = runs[r * 2], b = runs[r * 2 + 1];
      if (b - a < 2) continue;
      ctx.moveTo(hx[a], hy[a]);
      for (let i = a + 1; i < b; i++) ctx.lineTo(hx[i], hy[i]);
    }
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.restore();

    // the label: beside the line on the shared side (above it, for a near-level line), as near the
    // right edge as it fits, clear of the line itself and of the UI text, fading in as the line completes
    const la = (hl.labelAlpha ?? AL.hlineLabel) * (P.live ? clamp01((prog - 0.8) / 0.2) : 1);
    if (!hl.label || la < 0.004) return;
    const fs = (hl.fontPx ?? 11) * unit, w = this._measure(hl.label) * (fs / 11), hh = fs * 0.75, m = 16 * unit;
    const u = this._u;
    let lastX = Infinity, lastY = Infinity;
    for (let tries = 0; tries < 40; tries++) {
      // the next on-screen sample, rightmost first, at least 24 px from the last one tried
      let best = -1;
      for (let i = 0; i < np; i++) {
        const x = hx[i], y = hy[i];
        if (x < m || x > P.W - m || y < m || y > P.H - m) continue;
        if (x >= lastX && !(x === lastX && y !== lastY)) continue;
        if (Math.abs(x - lastX) + Math.abs(y - lastY) < 24 * unit) continue;
        if (best < 0 || x > hx[best]) best = i;
      }
      if (best < 0) break;
      lastX = hx[best]; lastY = hy[best];
      // the run's local direction there
      let r = 0;
      while (r < nr && !(best >= runs[r * 2] && best < runs[r * 2 + 1])) r++;
      if (r >= nr) continue;
      const i0 = Math.max(runs[r * 2], best - 1), i1 = Math.min(runs[r * 2 + 1] - 1, best + 1);
      let tx = hx[i1] - hx[i0], ty = hy[i1] - hy[i0];
      const tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) continue;
      tx /= tl; ty /= tl;
      let nx = -ty, ny = tx;
      cam.unproject(lastX + nx * 20 * unit, lastY + ny * 20 * unit, u);
      if (u[0] * zx + u[1] * zy + u[2] * zz < 0) { nx = -nx; ny = -ny; }
      const dist = (w / 2) * Math.abs(nx) + hh * Math.abs(ny) + 6 * unit;
      const cx = lastX + nx * dist, cy = lastY + ny * dist, lx = cx - w / 2;
      if (lx < m || lx + w > P.W - m || cy - hh < m || cy + hh > P.H - m) continue;
      cam.unproject(cx, cy + hh, u);
      if (!this._okVec(cam, u[0], u[1], u[2])) continue; // never on the ground
      if (P.live && this._hitsUI(lx - 3, cy - 8, lx + w + 3, cy + 8)) continue;
      ctx.font = `400 ${fs}px ${FONT_TEXT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hl.color || C_TEXT;
      ctx.globalAlpha = la;
      if (P.live) this._shadow(ctx, true);
      ctx.fillText(hl.label, lx, cy);
      if (P.live) this._shadow(ctx, false);
      ctx.globalAlpha = 1;
      this._hlOk = true;
      this._hlBox[0] = lx - 3; this._hlBox[1] = cy - 8; this._hlBox[2] = lx + w + 3; this._hlBox[3] = cy + 8;
      break;
    }
  }

  // -------------------------------------------------------------- Moon, Sun, planets
  _bodies(ctx, s, P) {
    this._nbody = 0;
    this._moon.on = false;
    const sky = s.sky;
    if (!sky || !sky.bodies) return;
    const bf = P.live ? (s.bodies ?? 1) : 1;
    if (!(bf > 0)) return;
    const cam = s.cam, unit = P.unit, dim = s.bodyDim || null, p = this._p, list = sky.bodies;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.alt < -2 || !cam.project(b.n, p)) continue;
      const x = p.x, y = p.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < -80 * unit || y < -80 * unit || x > P.W + 80 * unit || y > P.H + 80 * unit) continue;
      const altR = b.alt * DEG, ridge = this.skyline.at(Math.atan2(b.n[1], b.n[0]));
      const ext = extinctionMag(altR);
      const f = bf * (dim && dim[b.id] !== undefined ? dim[b.id] : 1);
      if (f <= 0) continue;
      if (b.id === 'Moon' || b.id === 'Sun') { this._disc(ctx, s, P, b, x, y, altR, ridge, ext, f); continue; }
      // a planet: a small coloured point with a 3r glow at α.35, sinking behind the ridge like a star
      const sink = clamp01((altR - ridge) * cam.pxPerRad(b.n) / 1.5 + 0.5);
      const a = f * sink * (1 - 0.55 * clamp01(ext / 3.5));
      if (a < 0.004) continue;
      const r = Math.min(3, Math.max(1.6, 1.6 + (1 - b.mag) * 0.3)) * unit;
      if (P.bodyInk) {
        ctx.globalAlpha = a;
        ctx.fillStyle = P.bodyInk;
        ctx.beginPath(); ctx.arc(x, y, r * 1.1, 0, TAU); ctx.fill();
      } else {
        const sp = this._glowSprite(b);
        if (sp) { ctx.globalAlpha = 0.35 * a; ctx.drawImage(sp, x - 3 * r, y - 3 * r, 6 * r, 6 * r); }
        ctx.globalAlpha = a;
        ctx.fillStyle = this._coreColor(b);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }
      this._pushBody(x - 3 * r - 2, y - 3 * r - 2, x + 3 * r + 2, y + 3 * r + 2);
    }
    ctx.globalAlpha = 1;
  }

  _disc(ctx, s, P, b, x, y, altR, ridge, ext, f) {
    const cam = s.cam, isMoon = b.id === 'Moon';
    const sa = isMoon ? 1 : P.sun;
    if (!(sa > 0)) return;
    const r = discRadiusPx(cam, b, P.unit) * (isMoon ? (P.live ? (s.moonScale ?? 1) : (P.moonScale ?? 1)) : 1);
    if (!Number.isFinite(r) || r <= 0) return;
    const rAng = r / cam.pxPerRad(b.n);
    if (altR + rAng < ridge - 0.0005) return; // wholly behind the ridge
    const warm = clamp01(ext / 3.5);
    const a = f * sa * (1 - 0.35 * warm);
    if (a < 0.004) return;
    ctx.save();
    if (altR - 3 * rAng < this.skyline.max + 0.003) this._ridgeClip(ctx, cam, b.n, 3 * r + 3 * P.unit);
    ctx.globalAlpha = a;
    if (isMoon) {
      const sky = s.sky;
      let o = P.moonStyle;
      if (!o) { o = this._moonOpts; o.warm = warm * 0.8; }
      drawMoon(ctx, x, y, r, sky.moonPhase ? sky.moonPhase.illum : 1, limbAngle(cam, b.n, sky.sun.n), o);
      this._moon.on = true; this._moon.x = x; this._moon.y = y; this._moon.r = r;
      this._moon.n[0] = b.n[0]; this._moon.n[1] = b.n[1]; this._moon.n[2] = b.n[2];
    } else {
      drawSun(ctx, x, y, r, warm);
    }
    ctx.restore();
    this._pushBody(x - r - 4, y - r - 4, x + r + 4, y + r + 4);
  }

  /** Clip to the sky above the skyline around a direction (discs that rise behind the ridge). */
  _ridgeClip(ctx, cam, n, halfPx) {
    const az = Math.atan2(n[1], n[0]), alt = Math.asin(clamp1(n[2]));
    const ppr = cam.pxPerRad(n);
    const span = halfPx / ppr / Math.max(0.2, Math.cos(alt)) + 0.3 * DEG;
    const steps = Math.min(160, Math.max(24, Math.ceil(2 * halfPx)));
    const v = this._v, p = this._p;
    let fx = 0, fy = 0, lx = 0, ly = 0, started = false;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const a = az - span + (2 * span * i) / steps;
      dirInto(v, a, this.skyline.at(a));
      if (!cam.project(v, p)) continue;
      if (!started) { ctx.moveTo(p.x, p.y); fx = p.x; fy = p.y; started = true; } else ctx.lineTo(p.x, p.y);
      lx = p.x; ly = p.y;
    }
    if (!started) { ctx.rect(0, 0, 0, 0); ctx.clip(); return; }
    // close on the sky side: toward higher altitude at the object
    let ux = 0, uy = -1;
    const q = this._q;
    dirInto(v, az, alt);
    if (cam.project(v, q)) {
      const qx = q.x, qy = q.y;
      dirInto(v, az, alt + 0.5 * DEG);
      if (cam.project(v, q)) { const dx = q.x - qx, dy = q.y - qy, dl = Math.hypot(dx, dy); if (dl > 1e-6) { ux = dx / dl; uy = dy / dl; } }
    }
    const L = 4 * halfPx + 40;
    ctx.lineTo(lx + ux * L, ly + uy * L);
    ctx.lineTo(fx + ux * L, fy + uy * L);
    ctx.closePath();
    ctx.clip();
  }

  _pushBody(x0, y0, x1, y1) {
    if (this._nbody >= 8) return;
    const k = this._nbody++ * 4, B = this._bodyBox;
    B[k] = x0; B[k + 1] = y0; B[k + 2] = x1; B[k + 3] = y1;
  }

  _glowSprite(b) {
    let sp = this._sprites.get(b.id);
    if (sp !== undefined) return sp;
    sp = makeCanvas(64, 64);
    if (sp) {
      const c = sp.getContext('2d'), col = b.color || [1, 1, 1];
      const rgb = `${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)}`;
      const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, `rgba(${rgb},1)`);
      gr.addColorStop(0.3, `rgba(${rgb},0.42)`);
      gr.addColorStop(0.65, `rgba(${rgb},0.1)`);
      gr.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = gr;
      c.fillRect(0, 0, 64, 64);
    }
    this._sprites.set(b.id, sp);
    return sp;
  }

  _coreColor(b) {
    let s = this._cores.get(b.id);
    if (!s) {
      const c = b.color || [1, 1, 1], m = (x) => Math.round((x * 0.6 + 0.4) * 255);
      s = `rgb(${m(c[0])},${m(c[1])},${m(c[2])})`;
      this._cores.set(b.id, s);
    }
    return s;
  }

  // -------------------------------------------------------------- ripples, reticle
  _drawRipples(ctx, cam, now) {
    const R = this._ripples, p = this._p;
    let font = false;
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      if (!r.on) continue;
      const age = now - r.t0;
      if (age < 0 || !cam.project(r.n, p)) continue;
      const alt = Math.asin(clamp1(r.n[2]));
      if (alt < this.skyline.at(Math.atan2(r.n[1], r.n[0]))) continue;
      if (age < MS.ripple) {
        const t = age / MS.ripple;
        ctx.globalAlpha = AL.ripple * Math.pow(1 - t, 1.6);
        ctx.strokeStyle = C_TEXT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + 14 * ease.out(t), 0, TAU);
        ctx.stroke();
      }
      if (r.label && age < MS.listenName) {
        const a = AL.listenName * Math.min(1, age / 120) * (1 - ease.fade(age / MS.listenName));
        const lx = p.x + 10, ly = p.y;
        if (a < 0.004 || this._hitsUI(lx - 3, ly - 8, lx + r.w + 3, ly + 8)) continue;
        if (!font) { ctx.font = FONT_11; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = C_TEXT; this._shadow(ctx, true); font = true; }
        ctx.globalAlpha = a;
        ctx.fillText(r.label, lx, ly);
      }
    }
    if (font) this._shadow(ctx, false);
    ctx.globalAlpha = 1;
  }

  _reticleGeom(R, now) {
    const sel = R.kind === 'sel';
    let r1 = sel ? 13 : 9;
    // the Moon's disc is larger than a star: keep the ticks clear of its edge
    const m = this._moon;
    if (m.on && R.n[0] * m.n[0] + R.n[1] * m.n[1] + R.n[2] * m.n[2] > Math.cos(0.3 * DEG)) r1 = Math.max(r1, m.r + 5);
    const r0 = r1 * (sel ? 1.15 : 16 / 9);
    const u = clamp01((now - R.t0) / (sel ? MS.reticleSel : MS.reticleHero));
    const G = this._rg;
    G.r = r0 + (r1 - r0) * ease.out(u); G.a = clamp01(u * 6); G.r1 = r1;
    return G;
  }

  _drawReticle(ctx, cam, now) {
    this._retR = 0;
    for (let k = 0; k < 2; k++) {
      const R = k === 0 ? this._retOld : this._ret;
      if (!R.on || !cam.project(R.n, this._p)) continue;
      const G = this._reticleGeom(R, now);
      let a = AL.reticle * G.a;
      if (k === 0) a *= 1 - clamp01((now - R.tOut) / MS.reticleOut);
      else this._retR = G.r1;
      if (a < 0.004) continue;
      const x = this._p.x, y = this._p.y, r = G.r;
      const dpr = this.dpr, snap = (v) => Math.round(v * dpr) / dpr;
      ctx.globalAlpha = a;
      ctx.fillStyle = C_EMBER;
      const cx = snap(x - 0.5), cy = snap(y - 0.5);
      ctx.fillRect(cx, snap(y - r - 5), 1, 5);
      ctx.fillRect(cx, snap(y + r), 1, 5);
      ctx.fillRect(snap(x - r - 5), cy, 5, 1);
      ctx.fillRect(snap(x + r), cy, 5, 1);
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- tags and the below-horizon marker
  _placeTags(cam) {
    const T = this._tags, p = this._p, v = this._v, m = this._moon, R = this._ret;
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      t.ok = false;
      if (t.kind === 1) {
        // marker: a 1 px line rising 18 px from the ridge top at the target's azimuth, label above
        const az = Math.atan2(t.n[1], t.n[0]);
        dirInto(v, az, this.skyline.at(az));
        if (!cam.project(v, p) || p.y < 40 || p.y > this.h + 18) continue;
        t.lx = p.x; t.ly0 = p.y; t.ly1 = p.y - 18;
        t.x = Math.max(8, Math.min(this.w - 8 - t.w, p.x - t.w / 2));
        t.y = t.ly1 - 9;
        // never under the UI's text: at the stand framing the ridge sits in the caption band, so the
        // marker rises from just above the text it would otherwise cross (still pointing straight down)
        for (let k = 0; k < 3; k++) {
          const top = this._uiTopHit(Math.min(t.x - 3, t.lx - 1), t.y - 8, Math.max(t.x + t.w + 3, t.lx + 1), t.ly0);
          if (top === null) break;
          t.ly0 = Math.min(t.ly0, top - 2); t.ly1 = t.ly0 - 18; t.y = t.ly1 - 9;
        }
        t.ok = t.y > 12;
        continue;
      }
      if (!cam.project(t.n, p)) continue;
      const n = t.n;
      let off = 10 + 3;
      if (m.on && n[0] * m.n[0] + n[1] * m.n[1] + n[2] * m.n[2] > Math.cos(0.3 * DEG)) off = 10 + m.r;
      if (R.on && n[0] * R.n[0] + n[1] * R.n[1] + n[2] * R.n[2] > Math.cos(0.1 * DEG) && this._retR) off = Math.max(off, this._retR + 5 + 10);
      if (t.side > 0 && p.x + off + t.w > this.w - 12) t.side = -1;
      else if (t.side < 0 && p.x + off + t.w < this.w - 20) t.side = 1;
      t.x = t.side > 0 ? p.x + off : p.x - off - t.w;
      t.y = p.y;
      t.ok = true;
    }
  }

  _drawTags(ctx) {
    const T = this._tags;
    if (!T.length) return;
    ctx.font = FONT_11; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      if (!t.ok || t.a <= 0) continue;
      const e = sm(t.a);
      if (t.kind === 1) {
        ctx.globalAlpha = AL.markerLine * e;
        ctx.fillStyle = C_TEXT;
        const x = Math.round((t.lx - 0.5) * this.dpr) / this.dpr;
        ctx.fillRect(x, t.ly1, 1, t.ly0 - t.ly1);
      }
      ctx.globalAlpha = (t.kind === 1 ? AL.markerLabel : AL.tag) * e;
      ctx.fillStyle = C_TEXT;
      this._shadow(ctx, true);
      ctx.fillText(t.text, t.x, t.y);
      this._shadow(ctx, false);
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------- sky names and their collision layout
  _layout(cam, s, now) {
    this._lastLayout = now; this._layoutDirty = false; this._layoutStale = false;
    this.stats.layouts++;
    const Ls = this._labels;
    for (let i = 0; i < Ls.length; i++) Ls[i].cand = false;
    // seeds: the UI's own text, the Moon / planets, the reticle, tags, marker, B's horizon label
    this._nbox = 0;
    for (let i = 0; i < this._nui; i++) { const k = i * 4, u = this._ui; this._pushBox(u[k], u[k + 1], u[k + 2], u[k + 3]); }
    for (let i = 0; i < this._nbody; i++) { const k = i * 4, b = this._bodyBox; this._pushBox(b[k], b[k + 1], b[k + 2], b[k + 3]); }
    if (this._ret.on && this._retR && cam.project(this._ret.n, this._p)) {
      const r = this._retR + 6, p = this._p;
      this._pushBox(p.x - r, p.y - r, p.x + r, p.y + r);
    }
    for (let i = 0; i < this._tags.length; i++) {
      const t = this._tags[i];
      if (!t.ok || t.t <= 0) continue;
      this._pushBox(t.x - 3, t.y - 8, t.x + t.w + 3, t.y + 8);
      if (t.kind === 1) this._pushBox(t.lx - 3, t.ly1, t.lx + 3, t.ly0);
    }
    if (this._hlOk) this._pushBox(this._hlBox[0], this._hlBox[1], this._hlBox[2], this._hlBox[3]);

    const hv = s.hover;
    if (hv && hv.type === 'star' && this._nameOf.has(hv.index)) this._cand(4, hv.index, this._nameOf.get(hv.index), AL.starName, 0, cam);
    else if (hv && hv.type === 'body' && s.sky) {
      const bi = s.sky.bodies.findIndex((b) => b.id === hv.id);
      if (bi >= 0) this._cand(5, bi, s.sky.bodies[bi].zh, AL.starName, 0, cam);
    }

    const g = this._geo();
    if (g) {
      for (let a = 0; a < g.nA; a++) {
        if (g.aT[a] <= 0 || !g.aNamed[a] || !g.asts[a].zh) continue;
        const g0 = g.aG0[a];
        if (g0 === g0 && g0 !== -Infinity && now - g0 < 0.6 * MS.grow) continue; // names follow their lines in
        this._cand(1, a, g.asts[a].zh, g.aT[a] >= AL.sel - 1e-6 ? AL.selName : AL.astName, 0, cam);
      }
    }

    const nf = this._namesF;
    if (nf.t > 0 || nf.v > 0) {
      const lim = cam.fov < 45 ? 3.0 : 2.0, f = cam.f, v = this._v;
      let placed = 0;
      for (let k = 0; k < this._nIdx.length && placed < 5; k++) {
        if (this._nMag[k] > lim) break;
        if (!this._nHan[k]) continue;
        const i = this._nIdx[k];
        this._starNeu(i, v);
        const L = this._labelMap.get(2e7 + i);
        const maxAng = (L && L.a > 0 ? 28 : 25) * DEG;
        if (v[0] * f[0] + v[1] * f[1] + v[2] * f[2] < Math.cos(maxAng)) continue;
        if (this._cand(2, i, this._nName[k], AL.starName, 1, cam)) placed++;
      }
      if (g) {
        this._ensureNeu(g);
        let best = -1, bestC = Math.cos(25 * DEG);
        for (let a = 0; a < g.nA; a++) {
          if (!g.asts[a].zh || g.cNeu[a * 3 + 2] < Math.sin(3 * DEG)) continue;
          const c = g.cNeu[a * 3] * f[0] + g.cNeu[a * 3 + 1] * f[1] + g.cNeu[a * 3 + 2] * f[2];
          if (c > bestC) { bestC = c; best = a; }
        }
        if (best >= 0) this._cand(1, best, g.asts[best].zh, AL.astName, 1, cam);
      }
    }

    if (this._in.compass > 0) for (let k = 0; k < 4; k++) this._cand(3, k, COMPASS[k], AL.compass, 2, cam);
    for (let i = 0; i < Ls.length; i++) if (!Ls[i].cand) Ls[i].t = 0;
  }

  /** Offer a label to the layout: first free slot wins (its current slot first, so nothing hops). */
  _cand(kind, ref, text, base, group, cam) {
    const key = kind * 1e7 + ref;
    let L = this._labelMap.get(key);
    if (L && L.cand) { if (base > L.base) L.base = base; return L.t > 0; }
    if (!L) {
      L = this._pool.pop() || new Label();
      L.key = key; L.kind = kind; L.ref = ref; L.text = text; L.a = 0; L.t = 0; L.slot = 0;
      L.w = kind === 3 ? this._measure(text) * (10 / 11) : this._measure(text);
      this._labels.push(L);
      this._labelMap.set(key, L);
    }
    L.cand = true; L.base = base; L.group = group;
    const ns = kind === 1 ? 5 : kind === 3 ? 1 : 4;
    const hh = kind === 3 ? 7 : 8;
    let fb = -1; // an asterism's name may overlap its own faint lines if nothing else fits
    for (let j = -1; j < ns; j++) {
      const slot = j < 0 ? (L.a > 0 ? L.slot : -1) : j;
      if (slot < 0 || (j >= 0 && L.a > 0 && slot === L.slot)) continue;
      if (!this._labelPos(L, cam, slot)) { L.t = 0; return false; }
      const x0 = this._lx - 3, y0 = this._ly - hh, x1 = this._lx + L.w + 3, y1 = this._ly + hh;
      if (x0 < 2 || x1 > this.w - 2 || y0 < 2 || y1 > this.h - 2) continue;
      if (this._hitsBox(x0, y0, x1, y1)) continue;
      if (kind === 1 && this._hitsOwnLines(ref, x0, y0, x1, y1, cam)) { if (fb < 0) fb = slot; continue; }
      L.slot = slot; L.t = 1;
      this._pushBox(x0, y0, x1, y1);
      return true;
    }
    if (fb >= 0 && this._labelPos(L, cam, fb)) {
      L.slot = fb; L.t = 1;
      this._pushBox(this._lx - 3, this._ly - hh, this._lx + L.w + 3, this._ly + hh);
      return true;
    }
    L.t = 0;
    return false;
  }

  /** Screen bounding box of an asterism's drawn vertices (sky side only) into this._bx0…_by1; returns their count. */
  _astBox(a, cam) {
    const g = this._geo(), N = g.neu, A = g.asts[a], q = this._q, u = this._u;
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = A.v0; k < A.v1; k++) {
      u[0] = N[k * 3]; u[1] = N[k * 3 + 1]; u[2] = N[k * 3 + 2];
      if (u[2] < -0.02 || !cam.project(u, q)) continue;
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      n++;
    }
    this._bx0 = x0; this._by0 = y0; this._bx1 = x1; this._by1 = y1;
    return n;
  }

  /** Does a box cross any segment of asterism a (as projected now)? */
  _hitsOwnLines(a, x0, y0, x1, y1, cam) {
    const g = this._geo();
    if (!g) return false;
    const N = g.neu, v = this._v, p = this._p, q = this._q;
    for (let s = g.s0[a]; s < g.s1[a]; s++) {
      const ia = g.sa[s] * 3, ib = g.sb[s] * 3;
      v[0] = N[ia]; v[1] = N[ia + 1]; v[2] = N[ia + 2];
      if (!cam.project(v, p)) continue;
      const px = p.x, py = p.y;
      v[0] = N[ib]; v[1] = N[ib + 1]; v[2] = N[ib + 2];
      if (!cam.project(v, q)) continue;
      if (segHitsBox(px, py, q.x, q.y, x0, y0, x1, y1)) return true;
    }
    return false;
  }

  /** Where a label sits for a slot: sets this._lx (left) and this._ly (middle). false if its anchor is hidden. */
  _labelPos(L, cam, slot) {
    const v = this._v, p = this._p, w = L.w;
    switch (L.kind) {
      case 1: {
        const g = this._geo();
        if (!g || L.ref >= g.nA) return false;
        const a = L.ref;
        v[0] = g.cNeu[a * 3]; v[1] = g.cNeu[a * 3 + 1]; v[2] = g.cNeu[a * 3 + 2];
        if (v[2] < Math.sin(2 * DEG) || !cam.project(v, p)) return false;
        if (Math.asin(clamp1(v[2])) < this.skyline.at(Math.atan2(v[1], v[0])) + 0.5 * DEG) return false;
        // a small figure takes its name under its drawn shape (else above, beside, inside); a large one
        // in its middle
        if (this._astBox(a, cam) >= 2 && Math.max(this._bx1 - this._bx0, this._by1 - this._by0) < 130) {
          const cx = (this._bx0 + this._bx1) / 2, cy = (this._by0 + this._by1) / 2;
          if (slot === 0) { this._lx = cx - w / 2; this._ly = this._by1 + 13; }
          else if (slot === 1) { this._lx = cx - w / 2; this._ly = this._by0 - 13; }
          else if (slot === 2) { this._lx = this._bx0 - 10 - w; this._ly = cy; }
          else if (slot === 3) { this._lx = this._bx1 + 10; this._ly = cy; }
          else { this._lx = cx - w / 2; this._ly = cy; }
          return true;
        }
        const dy = slot === 0 ? 0 : slot === 1 ? 16 : slot === 2 ? -16 : slot === 3 ? 32 : -32;
        this._lx = p.x - w / 2; this._ly = p.y + dy;
        return true;
      }
      case 2: case 4: case 5: {
        if (L.kind === 5) {
          const sky = this._in.sky, b = sky && sky.bodies[L.ref];
          if (!b) return false;
          v[0] = b.n[0]; v[1] = b.n[1]; v[2] = b.n[2];
        } else this._starNeu(L.ref, v);
        if (!cam.project(v, p)) return false;
        if (Math.asin(clamp1(v[2])) < this.skyline.at(Math.atan2(v[1], v[0])) + 0.3 * DEG) return false;
        const dx = L.kind === 5 && this._moon.on && L.text === '月亮' ? this._moon.r + 6 : 7;
        if (slot === 0) { this._lx = p.x + dx; this._ly = p.y; } else if (slot === 1) { this._lx = p.x - dx - w; this._ly = p.y; } else if (slot === 2) { this._lx = p.x - w / 2; this._ly = p.y - 13; } else { this._lx = p.x - w / 2; this._ly = p.y + 13; }
        return true;
      }
      case 3: {
        // compass letters: on the ground, 18 px under the horizon (and under the ridge where it dips below it)
        const az = L.ref * Math.PI / 2;
        dirInto(v, az, 0);
        if (!cam.project(v, p)) return false;
        const x = p.x, y0 = p.y;
        dirInto(v, az, this.skyline.at(az));
        const y1 = cam.project(v, p) ? p.y : y0;
        this._lx = x - w / 2; this._ly = Math.max(y0, y1) + 18;
        return true;
      }
      default: return false;
    }
  }

  _drawLabels(ctx, cam, s) {
    const Ls = this._labels;
    if (!Ls.length) return;
    const nf = sm(this._namesF.v), cf = clamp01(this._in.compass);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = C_TEXT;
    this._shadow(ctx, true);
    for (let pass = 0; pass < 2; pass++) {
      ctx.font = pass === 0 ? FONT_11 : FONT_10;
      for (let i = 0; i < Ls.length; i++) {
        const L = Ls[i];
        if ((L.kind === 3) !== (pass === 1) || L.a <= 0) continue;
        const a = L.base * sm(L.a) * (L.group === 1 ? nf : L.group === 2 ? cf : 1);
        if (a < 0.004 || !this._labelPos(L, cam, L.slot)) continue;
        const hh = L.kind === 3 ? 7 : 8;
        // the layout runs at ≤ 10 Hz while moving; between runs, never slide under the UI's text
        if (this._hitsUI(this._lx - 3, this._ly - hh, this._lx + L.w + 3, this._ly + hh)) { L.t = 0; continue; }
        ctx.globalAlpha = a;
        ctx.fillText(L.text, this._lx, this._ly);
      }
    }
    this._shadow(ctx, false);
    ctx.globalAlpha = 1;
  }

  _shadow(ctx, on) {
    if (on) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 3 * this.dpr;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = this.dpr;
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
  }

  _pushBox(x0, y0, x1, y1) {
    if (this._nbox * 4 + 4 > this._box.length) { const b = new Float32Array(this._box.length * 2); b.set(this._box); this._box = b; }
    const k = this._nbox++ * 4, B = this._box;
    B[k] = x0; B[k + 1] = y0; B[k + 2] = x1; B[k + 3] = y1;
  }

  _hitsBox(x0, y0, x1, y1) {
    const B = this._box;
    for (let i = 0; i < this._nbox; i++) {
      const k = i * 4;
      if (x0 < B[k + 2] && B[k] < x1 && y0 < B[k + 3] && B[k + 1] < y1) return true;
    }
    return false;
  }

  /** Top edge of the highest UI rect hitting a box, or null. */
  _uiTopHit(x0, y0, x1, y1) {
    const U = this._ui;
    let top = null;
    for (let i = 0; i < this._nui; i++) {
      const k = i * 4;
      if (x0 < U[k + 2] && U[k] < x1 && y0 < U[k + 3] && U[k + 1] < y1 && (top === null || U[k + 1] < top)) top = U[k + 1];
    }
    return top;
  }

  _hitsUI(x0, y0, x1, y1) {
    const U = this._ui;
    for (let i = 0; i < this._nui; i++) {
      const k = i * 4;
      if (x0 < U[k + 2] && U[k] < x1 && y0 < U[k + 3] && U[k + 1] < y1) return true;
    }
    return false;
  }

  _measure(text) {
    let w = this._tw.get(text);
    if (w !== undefined) return w;
    if (!this._mctx) { const c = makeCanvas(8, 8); this._mctx = c ? c.getContext('2d') : null; }
    const m = this._mctx;
    if (m) { m.font = FONT_11; w = m.measureText(text).width; } else w = text.length * 11;
    if (this._tw.size > 600) this._tw.clear();
    this._tw.set(text, w);
    return w;
  }

  // -------------------------------------------------------------- queries
  /** Nearest named star, planet, the Moon or the Sun within 24 px (brighter objects win). */
  pick(s, x, y) {
    const cam = s && s.cam;
    if (!cam) return null;
    if (s.M) this._setM(s.M);
    this.skyline.set(s.terrainH);
    const p = this._p, v = this._v, sky = s.sky;
    let best = null, bestScore = Infinity;
    if (sky && sky.bodies) {
      for (let i = 0; i < sky.bodies.length; i++) {
        const b = sky.bodies[i];
        if (b.id === 'Sun' && !((s.sunAlpha ?? 1) > 0)) continue;
        if (!((s.bodies ?? 1) > 0) || !cam.project(b.n, p)) continue;
        const disc = b.id === 'Moon' || b.id === 'Sun';
        const rr = disc ? discRadiusPx(cam, b) : 3;
        const rAng = rr / cam.pxPerRad(b.n);
        if (b.alt * DEG + rAng < this.skyline.at(Math.atan2(b.n[1], b.n[0]))) continue;
        const d = Math.max(0, Math.hypot(p.x - x, p.y - y) - rr);
        if (d > 24) continue;
        const score = d + 6 * Math.max(-10, Math.min(6, b.mag));
        if (score < bestScore) { bestScore = score; best = { type: 'body', id: b.id }; }
      }
    }
    if (this._hasM) {
      const lim = cam.fov < 45 ? 5.2 : 4.5, band = Math.sin(this.skyline.max + 0.005);
      for (let k = 0; k < this._nIdx.length; k++) {
        const mag = this._nMag[k];
        if (mag > lim) break;
        const i = this._nIdx[k];
        this._starNeu(i, v);
        if (v[2] < band && Math.asin(clamp1(v[2])) < this.skyline.at(Math.atan2(v[1], v[0])) + 0.2 * DEG) continue;
        if (!cam.project(v, p)) continue;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d > 24 - 3 * Math.max(0, mag - 2)) continue;
        const score = d + 6 * mag;
        if (score < bestScore) { bestScore = score; best = { type: 'star', index: i }; }
      }
    }
    return best;
  }

  /**
   * Asterisms to show (spec §3.4 a/b): the `count` nearest to the view centre (or to `dir`) within maxDeg,
   * above the horizon and on screen. One that contains `dir` (the hero star) comes first; the 28 宿 and
   * the major IAU figures are slightly preferred. `keep` retains ids still within keepDeg.
   */
  focusAsterisms(cam, M, count = 3, maxDeg = 30, opt) {
    const g = this._geo();
    if (!g || !M) return [];
    this._setM(M);
    this._ensureNeu(g);
    let dir = null, keep = null, keepDeg = 30, onScreen = true;
    if (opt && typeof opt[0] === 'number' && opt.length === 3) dir = opt;
    else if (opt) { dir = opt.dir || null; keep = opt.keep || null; keepDeg = opt.keepDeg ?? 30; onScreen = opt.onScreen ?? true; }
    const c = dir || cam.f, C = g.cNeu, N = g.neu, p = this._p, v = this._v;
    const ang = (a) => Math.acos(clamp1(C[a * 3] * c[0] + C[a * 3 + 1] * c[1] + C[a * 3 + 2] * c[2]));
    const out = [];
    if (keep) {
      for (const id of keep) {
        const a = g.byId.get(String(id));
        if (a === undefined || out.includes(g.asts[a].id) || C[a * 3 + 2] < Math.sin(2 * DEG)) continue;
        if (ang(a) <= keepDeg * DEG) out.push(g.asts[a].id);
      }
    }
    const cand = [];
    for (let a = 0; a < g.nA; a++) {
      const A = g.asts[a];
      if (out.includes(A.id) || C[a * 3 + 2] < Math.sin(4 * DEG)) continue;
      const th = ang(a);
      let contains = false;
      if (dir) for (let k = A.v0; k < A.v1 && !contains; k++) contains = N[k * 3] * dir[0] + N[k * 3 + 1] * dir[1] + N[k * 3 + 2] * dir[2] > Math.cos(0.4 * DEG);
      if (!contains && (th > maxDeg * DEG || g.ext[a] < 0.8 * DEG)) continue;
      let up = 0;
      for (let k = A.v0; k < A.v1; k++) {
        const z = N[k * 3 + 2];
        if (Math.asin(clamp1(z)) > this.skyline.at(Math.atan2(N[k * 3 + 1], N[k * 3])) + 0.5 * DEG) up++;
      }
      if (up < 0.6 * (A.v1 - A.v0)) continue;
      if (onScreen && cam && !contains) {
        v[0] = C[a * 3]; v[1] = C[a * 3 + 1]; v[2] = C[a * 3 + 2];
        if (!cam.project(v, p) || p.x < -0.05 * cam.w || p.x > 1.05 * cam.w || p.y < -0.05 * cam.h || p.y > 1.05 * cam.h) continue;
      }
      // nearest first, but a conspicuous figure (bright stars, the 28 宿, the major IAU figures) beats a
      // faint one a few degrees closer
      const bonus = (g.rank[a] === 1 ? 4 : g.rank[a] === 2 ? 2 : 0) + 2.5 * Math.min(4, Math.max(0, 4.5 - g.bright[a]));
      cand.push([th / DEG - bonus - (contains ? 1000 : 0), A.id]);
    }
    cand.sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < cand.length && out.length < count; i++) out.push(cand[i][1]);
    return out.slice(0, count);
  }

  /** The asterism a star belongs to (by its line vertices), else the nearest one within 10° (planets, Moon). */
  asterismFor(target, M, sky) {
    const g = this._geo();
    if (!g || !target) return null;
    let n = null;
    if (target.type === 'star') {
      const pos = this.catalog.stars.pos, i = target.index, E = g.eq;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], lim = Math.cos(0.15 * DEG);
      for (let v = 0; v < g.nv; v++) if (E[v * 3] * x + E[v * 3 + 1] * y + E[v * 3 + 2] * z > lim) return g.asts[g.vAst[v]].id;
      if (this._culture === 'iau') {
        const con = this.catalog.names.get(i)?.con;
        if (con && g.byId.has(con)) return con;
      }
      if (!M) return null;
      this._setM(M);
      n = this._starNeu(i, [0, 0, 0]);
    } else if (target.type === 'body') {
      const b = sky && sky.bodies ? sky.bodies.find((x) => x.id === target.id) : null;
      n = b ? b.n : null;
    } else if (typeof target[0] === 'number') n = target;
    if (!n || !M) return null;
    this._setM(M);
    this._ensureNeu(g);
    let best = null, bestC = Math.cos(10 * DEG);
    for (let a = 0; a < g.nA; a++) {
      const C = g.cNeu;
      const c = C[a * 3] * n[0] + C[a * 3 + 1] * n[1] + C[a * 3 + 2] * n[2];
      if (c > bestC) { bestC = c; best = g.asts[a].id; }
    }
    return best;
  }

  /**
   * The static vector layer of an export (spec §6): no labels, reticle or compass. `ctx` carries its own
   * transform; cam.w/h is the frame in the ctx's units (export px). opts.unit = export px per screen CSS px
   * (W / screenCSSW): it scales the on-screen sizes (planet points, Moon clamp, star gaps). Sizes given in
   * opts are export px.
   *   opts: { unit = 1, lines = false, culture, lineAlpha = .20, lineWidth = 0.75·unit, lineColor,
   *           bodies = true, bodyInk (planets as flat ink dots), moonStyle (drawMoon opts), moonScale, sun = 1,
   *           horizonLine: { zB, label, width = unit, dash: [on, off], alpha = .32, labelAlpha = .50,
   *                          fontPx = 11·unit, color } }
   */
  drawExport(ctx, s, opts = {}) {
    const cam = s && s.cam;
    if (!cam || !ctx) return;
    if (s.M) this._setM(s.M);
    this.skyline.set(s.terrainH);
    const unit = opts.unit ?? 1;
    const P = {
      live: false, unit, now: 0, lineAlpha: 1, allAlpha: opts.lineAlpha ?? AL.focus, lineWidth: opts.lineWidth ?? 0.75 * unit,
      lineColor: opts.lineColor || C_LINE, culture: opts.culture || this._culture, dpr: 1, W: cam.w, H: cam.h,
      bodyInk: opts.bodyInk || null, moonStyle: opts.moonStyle || null, moonScale: opts.moonScale ?? 1, sun: opts.sun ?? 1,
    };
    ctx.save();
    if (opts.lines && this._hasM) this._lines(ctx, cam, P);
    const hl = opts.horizonLine;
    if (hl) {
      // export sizes are given in export px (spec §6: 1.5 px, dash 12 / gap 10, label 20 px)
      this._horizonLine(ctx, cam, P, { ...hl, width: (hl.width ?? unit) / unit, fontPx: (hl.fontPx ?? 11 * unit) / unit,
        dash: hl.dash ? [hl.dash[0] / unit, hl.dash[1] / unit] : null });
    }
    if (opts.bodies !== false) this._bodies(ctx, s, P);
    ctx.restore();
  }
}

function stepFade(F, dt, tin, tout) {
  if (F.v === F.t) return false;
  F.v = F.t > F.v ? Math.min(F.t, F.v + dt / tin) : Math.max(F.t, F.v - dt / tout);
  return true;
}

// ================================================================ Moon and Sun
/** Drawn radius (px) of the Moon or Sun: clamp(2.2 × true radius, 5, 14) px (spec §3.4), × unit. */
export function discRadiusPx(cam, body, unit = 1) {
  const distKm = (body.dist || (body.id === 'Sun' ? 1 : 0.00257)) * AU_KM;
  const trueR = Math.asin(Math.min(1, (body.id === 'Sun' ? R_SUN_KM : R_MOON_KM) / distKm));
  return Math.min(14 * unit, Math.max(5 * unit, 2.2 * trueR * cam.pxPerRad(body.n)));
}

const _la = [0, 0, 0], _lp = { x: 0, y: 0, d: 0 }, _lq = { x: 0, y: 0, d: 0 };
/** Screen angle (rad) from the Moon toward the Sun along the sky: the direction of the bright limb. */
export function limbAngle(cam, moonN, sunN) {
  const d = moonN[0] * sunN[0] + moonN[1] * sunN[1] + moonN[2] * sunN[2];
  const tx = sunN[0] - d * moonN[0], ty = sunN[1] - d * moonN[1], tz = sunN[2] - d * moonN[2];
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1, eps = 0.01;
  const qx = moonN[0] + (tx / tl) * eps, qy = moonN[1] + (ty / tl) * eps, qz = moonN[2] + (tz / tl) * eps;
  const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
  _la[0] = qx / ql; _la[1] = qy / ql; _la[2] = qz / ql;
  const a = cam.project(moonN, _lp), b = cam.project(_la, _lq);
  if (!a || !b) return 0;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// The maria as the naked eye sees them from the northern hemisphere (lunar north up, x right, y down, in
// disc radii) — [cx, cy, rx, ry, darkness]: Procellarum, Imbrium, Frigoris, Serenitatis, Vaporum,
// Tranquillitatis, Crisium, Fecunditatis, Nectaris, Nubium, Humorum, Cognitum
const MARIA = [
  [-0.62, -0.02, 0.24, 0.42, 0.16], [-0.30, -0.42, 0.27, 0.22, 0.24], [-0.08, -0.74, 0.42, 0.07, 0.14],
  [0.15, -0.37, 0.16, 0.15, 0.24], [0.00, -0.16, 0.09, 0.07, 0.16], [0.33, -0.07, 0.20, 0.16, 0.24],
  [0.68, -0.28, 0.11, 0.09, 0.26], [0.56, 0.18, 0.11, 0.15, 0.18], [0.36, 0.34, 0.08, 0.08, 0.16],
  [-0.17, 0.40, 0.17, 0.12, 0.18], [-0.49, 0.43, 0.09, 0.08, 0.16], [-0.34, 0.17, 0.10, 0.08, 0.12],
];
const mixRgb = (a, b, t) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
const faces = new Map();

/** The Moon's face (albedo with soft maria), rendered once per colour set and reused every frame. */
function moonFace(light, light2, mariaRgb, strength) {
  const key = `${light}|${light2}|${mariaRgb}|${strength}`;
  let c = faces.get(key);
  if (c !== undefined) return c;
  c = makeCanvas(128, 128);
  if (c) {
    const x = c.getContext('2d'), R = 64;
    const g = x.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0, light); g.addColorStop(0.7, light); g.addColorStop(1, light2);
    x.fillStyle = g;
    x.beginPath(); x.arc(R, R, R, 0, TAU); x.fill();
    x.globalCompositeOperation = 'source-atop';
    // each mare is many small soft blobs scattered through its ellipse: irregular, soft-edged regions
    // that merge where they meet (fixed seed: every device draws the same Moon)
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const [cx, cy, rx, ry, dark] of MARIA) {
      const n = Math.max(4, Math.round((rx * ry) / 0.0055));
      for (let k = 0; k < n; k++) {
        const t = rnd() * TAU, u = Math.sqrt(rnd());
        const bx = R + (cx + Math.cos(t) * u * rx) * R, by = R + (cy + Math.sin(t) * u * ry) * R;
        const br = (0.09 + 0.07 * rnd()) * Math.min(1, 2.2 * Math.min(rx, ry) + 0.45) * R, a = 1.3 * dark * strength * (0.42 + 0.3 * rnd());
        const m = x.createRadialGradient(bx, by, 0, bx, by, br);
        m.addColorStop(0, `rgba(${mariaRgb},${a.toFixed(3)})`);
        m.addColorStop(1, `rgba(${mariaRgb},0)`);
        x.fillStyle = m;
        x.fillRect(bx - br, by - br, 2 * br, 2 * br);
      }
    }
  }
  faces.set(key, c);
  return c;
}

/**
 * The Moon: a crisp disc with the true phase, its bright limb turned toward the Sun (limbAngle, screen
 * radians), earthshine on the dark side (α.12) and a small halo of 3r (α.10). No glow blob.
 *   opts: { halo = 1 (× α.10; legacy `glow`), earthshine = 0.12, warm = 0 (0..1, the tint of a low Moon),
 *           light, light2 (face centre / limb colours), dark (earthshine fill), maria (strength, default 1;
 *           a CSS colour string also works: legacy), mariaColor ('r,g,b') }
 */
export function drawMoon(ctx, x, y, r, illum, limbAngle, opts = {}) {
  const halo = opts.halo ?? opts.glow ?? 1;
  const warm = clamp01(opts.warm ?? 0);
  illum = clamp01(illum);
  ctx.save();
  if (halo > 0) {
    const g = ctx.createRadialGradient(x, y, r, x, y, r * 3);
    g.addColorStop(0, `rgba(236,234,226,${(0.10 * halo).toFixed(3)})`);
    g.addColorStop(0.4, `rgba(236,234,226,${(0.035 * halo).toFixed(3)})`);
    g.addColorStop(1, 'rgba(236,234,226,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 3, 0, TAU); ctx.fill();
  }
  ctx.translate(x, y);
  ctx.rotate(limbAngle);
  // earthshine: the whole disc, faintly
  ctx.fillStyle = opts.dark || `rgba(206,214,230,${(opts.earthshine ?? 0.12).toFixed(3)})`;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  if (illum > 0.004) {
    // lit part: the half disc toward the Sun joined to a half ellipse for the terminator
    const e = r * (1 - 2 * illum);
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.abs(e), r, 0, Math.PI / 2, -Math.PI / 2, e > 0);
    ctx.closePath();
    ctx.clip();
    ctx.rotate(-limbAngle); // the face is fixed to the screen, not to the terminator
    let mariaRgb = opts.mariaColor || '70,72,82', strength = 1;
    if (typeof opts.maria === 'string') { const m = opts.maria.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); if (m) mariaRgb = `${m[1]},${m[2]},${m[3]}`; } else if (typeof opts.maria === 'number') strength = opts.maria;
    const face = moonFace(opts.light || '#F4F1E8', opts.light2 || '#D3CDBF', mariaRgb, strength);
    if (face) ctx.drawImage(face, -r, -r, 2 * r, 2 * r);
    else { ctx.fillStyle = opts.light || '#F4F1E8'; ctx.fillRect(-r, -r, 2 * r, 2 * r); }
    if (warm > 0.01) {
      // a low Moon reddens like the stars near the horizon
      ctx.fillStyle = `rgba(255,190,120,${(warm * 0.4).toFixed(3)})`;
      ctx.fillRect(-r, -r, 2 * r, 2 * r);
    }
  }
  ctx.restore();
}

/** The Sun, for daytime births: a small warm-white disc with a 3r halo; the sky shader carries the glare. */
function drawSun(ctx, x, y, r, warm) {
  ctx.save();
  const g = ctx.createRadialGradient(x, y, r, x, y, r * 3);
  g.addColorStop(0, 'rgba(255,240,214,0.28)');
  g.addColorStop(1, 'rgba(255,240,214,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 3, 0, TAU); ctx.fill();
  ctx.fillStyle = mixRgb([255, 248, 234], [255, 214, 160], warm);
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.restore();
}
