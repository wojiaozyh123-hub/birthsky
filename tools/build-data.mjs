// Builds the sky data shipped with the site into src/data/.
//
// Sources
// - HYG Database v4.1 (CC BY-SA 4.0, astronexus): positions, magnitudes, colour, distance, names
//   → .cache/hyg/hygdata_v41.csv (download: see README)
// - d3-celestial data (BSD-3, Olaf Frohn): constellation lines/labels, Chinese star names,
//   traditional Chinese asterisms (from Stellarium skycultures), Milky Way outlines (J.R. Vieira)
//
// Outputs
// - stars.bin     naked-eye stars (V ≤ 6.5), 6 bytes/star: u16 ra, i16 dec, i8 mag*10, i8 (b-v)*50 —
//                 sorted by magnitude. Its indices are what sky.json's named stars point at, and its
//                 count is the "stars above your head" fact, so it stays strictly naked-eye.
// - deep.bin      the fainter stars behind them (6.5 < V ≤ 8.0), same format, loaded after first paint;
//                 rendered only (depth for full-screen / zoomed views), never counted or named
// - sky.json      named stars, constellations (IAU + Chinese asterisms), label positions
// - milkyway.png  2048×1024 equirectangular luminance map (RA 0→360 left→right, Dec +90 top), stored
//                 as sqrt(luminance) so the faint outer band keeps its 8-bit precision

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/data');
const d3 = path.join(root, 'node_modules/d3-celestial/data');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
fs.mkdirSync(out, { recursive: true });

const MAG_LIMIT = 6.5;       // naked eye: stars.bin, names, counts
const DEEP_LIMIT = 8.0;      // rendered depth: deep.bin

// d3-celestial's Chinese names are Traditional; convert to Simplified with macOS ICU (Hant-Hans).
function toSimplified(strings) {
  if (process.platform !== 'darwin') return strings;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birthsky-t2s-'));
  const inF = path.join(dir, 'in.txt'), outF = path.join(dir, 'out.txt'), jsF = path.join(dir, 't.js');
  fs.writeFileSync(inF, strings.join('\n'), 'utf8');
  fs.writeFileSync(jsF, `ObjC.import('Foundation');
function run(argv) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  s.stringByApplyingTransformReverse('Hant-Hans', false).writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null);
  return 'ok';
}`);
  execFileSync('osascript', ['-l', 'JavaScript', jsF, inF, outF], { stdio: ['ignore', 'pipe', 'inherit'] });
  const out = fs.readFileSync(outF, 'utf8').split('\n');
  fs.rmSync(dir, { recursive: true, force: true });
  if (out.length !== strings.length) throw new Error('ICU conversion changed the line count');
  return out;
}


// ---------------------------------------------------------------- stars
function parseCSVLine(line) {
  const cells = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

const csv = fs.readFileSync(path.join(root, '.cache/hyg/hygdata_v41.csv'), 'utf8').split('\n');
const head = parseCSVLine(csv[0]);
const col = Object.fromEntries(head.map((h, i) => [h, i]));
let stars = [];
for (let i = 1; i < csv.length; i++) {
  if (!csv[i]) continue;
  const c = parseCSVLine(csv[i]);
  const id = +c[col.id];
  if (id === 0) continue; // the Sun
  const mag = +c[col.mag];
  if (!(mag <= DEEP_LIMIT)) continue;
  const dist = +c[col.dist];
  stars.push({
    hip: c[col.hip] ? +c[col.hip] : 0,
    ra: +c[col.ra] * 15, dec: +c[col.dec], mag,
    bv: c[col.ci] === '' ? 0.6 : +c[col.ci],
    ly: dist > 0 && dist < 100000 ? dist * 3.26156 : 0,
    proper: c[col.proper], con: c[col.con], bayer: c[col.bayer], flam: c[col.flam],
  });
}
stars.sort((a, b) => a.mag - b.mag);
// Stable sort, so the naked-eye stars keep exactly the order (and named-star indices) they had before
// the deeper stars were added.
const nakedCount = stars.findIndex((s) => s.mag > MAG_LIMIT);

function packStars(list) {
  const buf = Buffer.alloc(list.length * 6);
  list.forEach((s, i) => {
    const o = i * 6;
    buf.writeUInt16LE(Math.round(((s.ra % 360 + 360) % 360) / 360 * 65535), o);
    buf.writeInt16LE(Math.round(s.dec / 90 * 32767), o + 2);
    buf.writeInt8(Math.max(-128, Math.min(127, Math.round(s.mag * 10))), o + 4);
    buf.writeInt8(Math.max(-128, Math.min(127, Math.round(s.bv * 50))), o + 5);
  });
  return buf;
}
fs.writeFileSync(path.join(out, 'stars.bin'), packStars(stars.slice(0, nakedCount)));
fs.writeFileSync(path.join(out, 'deep.bin'), packStars(stars.slice(nakedCount)));

// ---------------------------------------------------------------- names
const starnames = readJSON(path.join(d3, 'starnames.json'));
const starnamesCn = readJSON(path.join(d3, 'starnames.cn.json'));
const consts = readJSON(path.join(d3, 'constellations.json'));
const conZh = Object.fromEntries(consts.features.map((f) => [f.id, f.properties.zh]));

// Names people actually say out loud. Everything else falls back to the formal Chinese name.
const POPULAR = {
  Sirius: '天狼星', Canopus: '老人星', 'Rigil Kentaurus': '南门二', Arcturus: '大角星', Vega: '织女星',
  Capella: '五车二', Rigel: '参宿七', Procyon: '南河三', Achernar: '水委一', Betelgeuse: '参宿四',
  Hadar: '马腹一', Altair: '牛郎星', Acrux: '十字架二', Aldebaran: '毕宿五', Antares: '心宿二',
  Spica: '角宿一', Pollux: '北河三', Fomalhaut: '北落师门', Deneb: '天津四', Mimosa: '十字架三',
  Regulus: '轩辕十四', Adhara: '弧矢七', Castor: '北河二', Polaris: '北极星', Dubhe: '天枢',
  Merak: '天璇', Phecda: '天玑', Megrez: '天权', Alioth: '玉衡', Mizar: '开阳', Alkaid: '摇光',
  Bellatrix: '参宿五', Alnilam: '参宿二', Alnitak: '参宿一', Mintaka: '参宿三', Saiph: '参宿六',
  Alcyone: '昴宿六', Algol: '大陵五', Shaula: '尾宿八', Elnath: '五车五', Mirfak: '天船三', Toliman: '南门二乙',
};

const named = [];
stars.slice(0, nakedCount).forEach((s, i) => {
  const sn = s.hip ? starnames[s.hip] : null;
  const formal = sn?.zh || '';
  const trad = s.hip ? starnamesCn[s.hip]?.name || '' : '';
  const popular = POPULAR[s.proper] || '';
  const zh = popular || formal || trad;
  if (!zh && !s.proper) return;
  if (s.mag > 5.2 && !s.proper) return; // keep the payload lean
  const alt = [formal, trad].filter((n) => n && n !== zh && !zh.startsWith(n))[0] || '';
  named.push([i, zh, alt, s.proper || sn?.name || '', s.con || sn?.c || '', s.ly ? Math.round(s.ly * 10) / 10 : 0]);
});

// ---------------------------------------------------------------- constellations
const r2 = (x) => Math.round(x * 100) / 100;
const toRa = (lon) => r2((lon + 360) % 360);
function lines(file) {
  return readJSON(path.join(d3, file)).features.map((f) => [
    f.id,
    f.geometry.coordinates.map((line) => line.map(([lon, lat]) => [toRa(lon), r2(lat)]).flat()),
  ]);
}
const iauLines = lines('constellations.lines.json');
const iau = consts.features.map((f) => {
  const [lon, lat] = f.geometry.coordinates;
  return [f.id, f.properties.zh, f.properties.name, +f.properties.rank, toRa(lon), r2(lat)];
});
const cnConsts = readJSON(path.join(d3, 'constellations.cn.json')).features.map((f) => {
  const [lon, lat] = f.geometry.coordinates;
  return [f.id, f.properties.name, +f.properties.rank, toRa(lon), r2(lat)];
});
const cnLines = lines('constellations.lines.cn.json');

{
  const all = [...named.flatMap((n) => [n[1], n[2]]), ...iau.map((c) => c[1]), ...cnConsts.map((c) => c[1])];
  const conv = toSimplified(all);
  let k = 0;
  for (const n of named) { n[1] = conv[k++]; n[2] = conv[k++]; }
  for (const c of iau) c[1] = conv[k++];
  for (const c of cnConsts) c[1] = conv[k++];
  // typos in the source data
  const FIX = [['萁宿', '箕宿'], ['蝘蜒', '蝘蜓']];
  const fix = (t) => FIX.reduce((acc, [a, b]) => acc.split(a).join(b), t);
  for (const n of named) { n[1] = fix(n[1]) || n[2] || n[3]; n[2] = fix(n[2]); if (n[2] === n[1]) n[2] = ''; }
  for (const c of iau) c[1] = fix(c[1]);
  for (const c of cnConsts) c[1] = fix(c[1]);
}
fs.writeFileSync(path.join(out, 'sky.json'), JSON.stringify({
  v: 1, magLimit: MAG_LIMIT, count: nakedCount, deepLimit: DEEP_LIMIT, deepCount: stars.length - nakedCount,
  named, iau, iauLines, cn: cnConsts, cnLines,
}));

// ---------------------------------------------------------------- milky way texture
const W = 2048, H = 1024;
const mw = readJSON(path.join(d3, 'mw.json'));
const acc = new Float32Array(W * H);
const levelWeight = { ol1: 0.18, ol2: 0.2, ol3: 0.22, ol4: 0.2, ol5: 0.2 };

// Even-odd fill by XOR-ing every ring into a per-level mask; each ring is rasterised on its own so
// rings that wrap around in RA (see below) tile cleanly at the -W/0/+W offsets.
function xorRing(mask, ring) {
  let prev = null;
  const pts = ring.map(([lon, lat]) => {
    let x = ((lon + 360) % 360) / 360 * W;
    if (prev !== null) { while (x - prev > W / 2) x -= W; while (prev - x > W / 2) x += W; }
    prev = x;
    return [x, (90 - lat) / 180 * H];
  });
  // The Milky Way is a loop around the whole sky, so its outlines are annuli whose rings wrap all
  // the way around in RA. Close such a ring over the north pole; XOR-ing the two rings of the
  // annulus then leaves exactly the band between them.
  if (Math.abs(pts[pts.length - 1][0] - pts[0][0]) > W / 2) {
    pts.push([pts[pts.length - 1][0], -1], [pts[0][0], -1]);
  }
  const edges = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a, b] : [b, a]);
  }
  if (!edges.length) return;
  let ymin = Infinity, ymax = -Infinity;
  for (const [a, b] of edges) { ymin = Math.min(ymin, a[1]); ymax = Math.max(ymax, b[1]); }
  for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(H - 1, Math.ceil(ymax)); y++) {
    const yc = y + 0.5, xs = [];
    for (const [a, b] of edges) {
      if (yc >= a[1] && yc < b[1]) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (const off of [-W, 0, W]) {
        const x0 = Math.max(0, Math.ceil(xs[k] + off - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1] + off - 0.5));
        for (let x = x0; x <= x1; x++) mask[y * W + x] ^= 1;
      }
    }
  }
}
for (const f of mw.features) {
  const w = levelWeight[f.id] ?? 0.2;
  const mask = new Uint8Array(W * H);
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const p of polys) for (const ring of p) xorRing(mask, ring);
  for (let i = 0; i < mask.length; i++) if (mask[i]) acc[i] += w;
}

function blur(src, sigmaDeg) {
  // separable gaussian; horizontal radius widens toward the poles so the blur is ~isotropic on the sky
  const tmp = new Float32Array(W * H), dst = new Float32Array(W * H);
  const pxPerDeg = W / 360;
  for (let y = 0; y < H; y++) {
    const dec = 90 - (y + 0.5) / H * 180;
    const sx = Math.min(W / 4, sigmaDeg * pxPerDeg / Math.max(0.08, Math.cos(dec * Math.PI / 180)));
    const r = Math.ceil(sx * 3), k = [];
    let ks = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sx * sx)); k.push(v); ks += v; }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[y * W + ((x + i) % W + W) % W] * k[i + r];
      tmp[y * W + x] = s / ks;
    }
  }
  const sy = sigmaDeg * H / 180, r = Math.ceil(sy * 3), k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sy * sy)); k.push(v); ks += v; }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x] * k[i + r];
      dst[y * W + x] = s / ks;
    }
  }
  return dst;
}
// Structure. The outlines give the large-scale shape — the band, the Great Rift, the bright clouds in
// Cygnus, Scutum and Sagittarius. A light blur keeps their edges instead of melting them into fog, and
// a procedural layer in galactic coordinates (stretched along the plane, like the real thing) adds
// the mottled star clouds and the thin dark dust lanes that the outlines are too coarse to carry.
const fine = blur(acc, 0.35), mid = blur(acc, 1.2), wide = blur(acc, 4.0);
const GAL = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
function hash2(i, j, seed) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// gradient (Perlin) noise, periodic in x, remapped to 0…1 — rounder and less blocky than value noise
function vnoise(x, y, period, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const i0 = ((ix % period) + period) % period, i1 = (i0 + 1) % period;
  const grad = (i, j, dx, dy) => { const a = hash2(i, j, seed) * 6.283185307; return Math.cos(a) * dx + Math.sin(a) * dy; };
  const a = grad(i0, iy, fx, fy), b = grad(i1, iy, fx - 1, fy), c = grad(i0, iy + 1, fx, fy - 1), d = grad(i1, iy + 1, fx - 1, fy - 1);
  const v = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  return 0.5 + v * 0.9;
}
// fBm periodic in galactic longitude; cell sizes in degrees (along the plane, across it)
function fbm(l, b, cellL, cellB, octaves, seed, gain = 0.55) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const period = Math.max(1, Math.round(360 / cellL));
    sum += amp * vnoise((l / 360) * period, b / cellB, period, seed + o * 17);
    norm += amp; amp *= gain; cellL /= 2; cellB /= 2;
  }
  return sum / norm;
}
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let max = 0;
const lum = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  const dec = (90 - (y + 0.5) / H * 180) * Math.PI / 180, cd = Math.cos(dec), sd = Math.sin(dec);
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    // sharp detail only inside the band; its outer edge comes from the softer layers, so it feathers
    // out the way the real one does instead of ending in cottony lobes
    const fw = sstep(0.12, 0.42, mid[i]);
    const base = fine[i] * 0.45 * fw + mid[i] * (0.35 + 0.4 * (1 - fw)) + wide[i] * 0.3;
    if (base < 0.004) { lum[i] = base; continue; }
    const ra = (x + 0.5) / W * 2 * Math.PI;
    const e = [cd * Math.cos(ra), cd * Math.sin(ra), sd];
    const g = GAL.map((r) => r[0] * e[0] + r[1] * e[1] + r[2] * e[2]);
    const l = Math.atan2(g[1], g[0]) * 180 / Math.PI;          // −180…180, 0 = galactic centre
    const b = Math.asin(Math.max(-1, Math.min(1, g[2]))) * 180 / Math.PI;
    const inner = Math.exp(-((l / 75) ** 2));                  // the inner Galaxy is lumpier and dustier
    // domain warp so nothing lines up with the noise lattice
    const wl = l + 360 + 4 * (fbm(l + 360, b, 20, 14, 2, 91) - 0.5);
    const wb = b + 2.5 * (fbm(l + 360, b, 20, 14, 2, 57) - 0.5);
    // Star clouds: only a gentle large-scale swell (big soft blobs read as cumulus, not as stars),
    // with the texture carried by small knots: granular, not billowy.
    const m = fbm(wl, wb, 9, 6, 4, 1);
    let cloud = 0.8 + 0.4 * Math.max(0, Math.min(1, (m - 0.5) * 1.8 + 0.5));
    const knots = fbm(wl + 3.3, wb, 2.2, 1.6, 3, 7);
    cloud += (0.18 + 0.3 * inner) * sstep(0.5, 0.78, knots);
    cloud = 1 + (cloud - 1) * sstep(0.03, 0.3, base); // faint edges fade smoothly, no cotton lobes
    // Dust. Ragged absorbing patches near the plane (the outlines carry the big dark clouds), plus
    // thin filaments stretched along the plane, as in the Great Rift and the lanes around the bulge.
    const dust = fbm(wl + 11, wb, 8, 4, 5, 23, 0.55);
    const near = Math.exp(-((b / 9) ** 2)) * sstep(0.03, 0.25, base);
    let tau = 0.95 * sstep(0.56, 0.76, dust) * (0.35 + 0.65 * inner);
    const fil = 1 - Math.abs(2 * fbm(wl + 29, wb, 16, 4, 2, 41, 0.45) - 1);
    tau += 0.45 * sstep(0.74, 0.94, fil) * (0.3 + 0.7 * inner) * sstep(0.45, 0.6, dust);
    tau *= near;
    lum[i] = base * cloud * Math.exp(-tau);
    if (lum[i] > max) max = lum[i];
  }
}

// PNG (8-bit greyscale) storing sqrt(luminance): the shader squares it back, which keeps the faint
// outer band free of banding. Rows are filtered (PNG adaptive filtering) so the detail stays small.
const raw = Buffer.alloc((W + 1) * H);
{
  const row = new Uint8Array(W), prev = new Uint8Array(W), cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(W));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) row[x] = Math.round(255 * Math.sqrt(Math.max(0, lum[y * W + x]) / max));
    let best = 0, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let cost = 0;
      for (let x = 0; x < W; x++) {
        const a = x ? row[x - 1] : 0, b = y ? prev[x] : 0, cc = x && y ? prev[x - 1] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
        const v = (row[x] - pred) & 255;
        c[x] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) { bestCost = cost; best = f; }
    }
    raw[y * (W + 1)] = best;
    raw.set(cand[best], y * (W + 1) + 1);
    prev.set(row);
  }
}
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(out, 'milkyway.png'), png);

const size = (f) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
console.log(`stars: ${nakedCount} (≤${MAG_LIMIT}) → stars.bin ${size('stars.bin')}; ${stars.length - nakedCount} (≤${DEEP_LIMIT}) → deep.bin ${size('deep.bin')}`);
console.log(`named: ${named.length}, IAU: ${iau.length}, 星官: ${cnConsts.length} → sky.json ${size('sky.json')}`);
console.log(`milkyway.png ${size('milkyway.png')}`);
console.log('sample:', named.slice(0, 12).map((n) => `${n[1]}(${n[3]}${n[2] ? '/' + n[2] : ''}, ${n[5]}ly)`).join(' '));
