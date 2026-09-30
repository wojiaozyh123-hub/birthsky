// Loads the star catalogue, names, constellations and Milky Way map produced by tools/build-data.mjs.
import { radec } from './astro.js';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function bvToRgb(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)) / 100;
  let r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  let g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  let b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  [r, g, b] = [r, g, b].map((c) => Math.max(0, Math.min(255, c)) / 255);
  const m = Math.max(r, g, b);
  // keep colour as a whisper, the way the eye sees it
  return [r, g, b].map((c) => 0.42 + 0.58 * (c / m));
}

// deterministic PRNG so the star dust (and therefore every poster) looks the same on every device
export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polylines(lines) {
  return lines.map(([id, polys]) => [id, polys.map((flat) => {
    const out = new Float32Array(flat.length / 2 * 3);
    for (let i = 0, j = 0; i < flat.length; i += 2, j += 3) out.set(radec(flat[i], flat[i + 1]), j);
    return out;
  })]);
}

function parseStars(bin) {
  const view = new DataView(bin);
  const n = bin.byteLength / 6;
  const stars = { count: n, pos: new Float32Array(n * 3), mag: new Float32Array(n), color: new Float32Array(n * 3) };
  for (let i = 0; i < n; i++) {
    const ra = view.getUint16(i * 6, true) / 65535 * 360;
    const dec = view.getInt16(i * 6 + 2, true) / 32767 * 90;
    stars.pos.set(radec(ra, dec), i * 3);
    stars.mag[i] = view.getInt8(i * 6 + 4) / 10;
    stars.color.set(bvToRgb(view.getInt8(i * 6 + 5) / 50), i * 3);
  }
  return stars;
}

export async function loadCatalog(base = 'data/', q = '', onProgress = () => {}) {
  let done = 0;
  const tick = (x) => { onProgress(++done / 3); return x; };
  const [bin, sky, mwImg] = await Promise.all([
    fetch(base + 'stars.bin' + q).then((r) => r.arrayBuffer()).then(tick),
    fetch(base + 'sky.json' + q).then((r) => r.json()).then(tick),
    loadImage(base + 'milkyway.png' + q).then(tick),
  ]);

  // `stars` is the naked-eye catalogue (V ≤ 6.5): names point into it and the facts count it.
  const stars = parseStars(bin);

  const conZh = Object.fromEntries(sky.iau.map(([id, zh]) => [id, zh]));
  const names = new Map();
  for (const [i, zh, alt, en, con, ly] of sky.named) {
    names.set(i, { i, zh, alt, en, con, conZh: conZh[con] || '', ly, mag: stars.mag[i] });
  }

  const iau = {
    lines: polylines(sky.iauLines),
    labels: sky.iau.map(([id, zh, en, rank, ra, dec]) => ({ id, zh, en, rank, v: radec(ra, dec) })),
  };
  const cn = {
    lines: polylines(sky.cnLines),
    labels: sky.cn.map(([id, zh, rank, ra, dec]) => ({ id, zh, rank, v: radec(ra, dec) })),
  };

  const mwLum = sampleImage(mwImg);
  const catalog = { stars, names, iau, cn, conZh, mwImg, mwLum, dust: makeDust(mwLum), deep: null };
  // The fainter stars (6.5 < V ≤ 8) only add depth to the picture; they arrive after first paint and
  // the renderer fades them in. Never counted, never named.
  catalog.deepReady = sky.deepCount
    ? fetch(base + 'deep.bin' + q)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => { if (b) catalog.deep = parseStars(b); return catalog.deep; })
      .catch(() => null)
    : Promise.resolve(null);
  return catalog;
}

// Unresolved "star dust": faint points scattered by Milky Way brightness. The band really is made of
// stars too faint to see one by one — these give it grain when you look closer.
function sampleImage(img) {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  return { W, H, px: ctx.getImageData(0, 0, W, H).data };
}

/** Milky Way brightness (0–1, sqrt-encoded, i.e. monotonic in luminance) in a J2000 direction. */
export function mwAt(mwLum, raDeg, decDeg) {
  const { W, H, px } = mwLum;
  const x = Math.min(W - 1, Math.floor((((raDeg % 360) + 360) % 360) / 360 * W));
  const y = Math.min(H - 1, Math.max(0, Math.floor((90 - decDeg) / 180 * H)));
  return px[(y * W + x) * 4] / 255;
}

function makeDust(mwLum) {
  const { W, H, px } = mwLum;
  const rnd = mulberry32(20260930);
  // Sample pixels of the map in proportion to their share of the sky (cos dec) and their brightness:
  // the dust follows the bright star clouds and avoids the dark lanes. Inverse-CDF sampling keeps
  // this a single pass over the map instead of millions of rejection trials.
  const cdf = new Float64Array(W * H);
  let total = 0;
  for (let y = 0; y < H; y++) {
    const area = Math.cos(((y + 0.5) / H - 0.5) * Math.PI);
    for (let x = 0; x < W; x++) {
      const t = px[(y * W + x) * 4] / 255;
      total += (0.004 + 0.996 * Math.pow(t * t, 0.9)) * area;
      cdf[y * W + x] = total;
    }
  }
  const N = 36000, pos = new Float32Array(N * 3), mag = new Float32Array(N), color = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const u = rnd() * total;
    let lo = 0, hi = W * H - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
    const x = lo % W, y = (lo - x) / W;
    const ra = (x + rnd()) / W * 2 * Math.PI;
    const z = Math.sin((0.5 - (y + rnd()) / H) * Math.PI), r = Math.sqrt(1 - z * z);
    pos[k * 3] = r * Math.cos(ra); pos[k * 3 + 1] = r * Math.sin(ra); pos[k * 3 + 2] = z;
    const t = px[lo * 4] / 255;
    mag[k] = 8.8 + rnd() * 1.4 - t * 0.7;
    const warm = rnd();
    color.set(warm < 0.5 ? [0.84, 0.88, 1] : warm < 0.85 ? [1, 0.95, 0.88] : [1, 0.84, 0.7], k * 3);
  }
  return { count: N, pos, mag, color };
}
