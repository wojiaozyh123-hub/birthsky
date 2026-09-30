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

export async function loadCatalog(base = 'data/', q = '', onProgress = () => {}) {
  let done = 0;
  const tick = (x) => { onProgress(++done / 3); return x; };
  const [bin, sky, mwImg] = await Promise.all([
    fetch(base + 'stars.bin' + q).then((r) => r.arrayBuffer()).then(tick),
    fetch(base + 'sky.json' + q).then((r) => r.json()).then(tick),
    loadImage(base + 'milkyway.png' + q).then(tick),
  ]);

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
  return { stars, names, iau, cn, conZh, mwImg, mwLum, dust: makeDust(mwLum) };
}

// Unresolved "star dust": faint points scattered by Milky Way brightness. The band really is made of
// stars too faint to see one by one — these give it grain when you zoom in.
function sampleImage(img) {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  return { W, H, px: ctx.getImageData(0, 0, W, H).data };
}

/** Milky Way brightness (0–1) in a J2000 direction. */
export function mwAt(mwLum, raDeg, decDeg) {
  const { W, H, px } = mwLum;
  const x = Math.min(W - 1, Math.floor((((raDeg % 360) + 360) % 360) / 360 * W));
  const y = Math.min(H - 1, Math.max(0, Math.floor((90 - decDeg) / 180 * H)));
  return px[(y * W + x) * 4] / 255;
}

function makeDust(mwLum) {
  const { W, H, px } = mwLum;
  const rnd = mulberry32(20260930);
  const N = 26000, pos = new Float32Array(N * 3), mag = new Float32Array(N), color = new Float32Array(N * 3);
  let k = 0, guard = 0;
  while (k < N && guard++ < N * 40) {
    const z = rnd() * 2 - 1, phi = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const ra = ((phi / (Math.PI * 2)) * 360 + 360) % 360, dec = Math.asin(z) * 180 / Math.PI;
    const L = px[(Math.min(H - 1, Math.floor((90 - dec) / 180 * H)) * W + Math.min(W - 1, Math.floor(ra / 360 * W))) * 4] / 255;
    const p = 0.05 + 0.95 * Math.pow(L, 1.3);
    if (rnd() > p) continue;
    pos[k * 3] = r * Math.cos(phi); pos[k * 3 + 1] = r * Math.sin(phi); pos[k * 3 + 2] = z;
    mag[k] = 7 + rnd() * 1.6 - L * 0.8;
    const warm = rnd();
    color.set(warm < 0.5 ? [0.82, 0.86, 1] : warm < 0.85 ? [1, 0.95, 0.88] : [1, 0.82, 0.66], k * 3);
    k++;
  }
  return { count: k, pos: pos.subarray(0, k * 3), mag: mag.subarray(0, k), color: color.subarray(0, k * 3) };
}
