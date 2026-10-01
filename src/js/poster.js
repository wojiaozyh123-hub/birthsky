// 留存: the export studio (spec §6, owner addendum §10.3–§10.4). A wallpaper or a 便签 card is a frame of
// the film: the same camera (P pinned to 0 — a true rectilinear lens, straight horizon), the same ridge,
// extinction and airglow as the screen, rendered offscreen in the studio's own WebGL context at the
// export resolution, with a line or two of small type set where lock screens leave room.
//
// Public API
//   new PosterStudio(catalog)
//   studio.render(opts) → Promise<{ canvas, dataUrl, W, H, fallback, groundScrim, qr, ms }>
//        dataUrl is a JPEG at q .92. `canvas` stays alive until the next render() or release().
//        fallback: '1080' when the full size could not be allocated and 1080 wide was drawn instead
//        (show T.result.fallback1080). groundScrim: 0..1, how much ground darkening was baked in
//        (> 0 → show T.hint.groundScrim). qr: { url, version, modules, size } | null.
//   studio.previewText(ctx, opts) → Promise     draws only the text + QR layer, in export pixels (the
//        caller scales ctx to its viewfinder frame), so the viewfinder previews exactly what is baked in
//   studio.release()                            frees the output canvas and the WebGL context
//   exportSize(format, { screenW, screenH, dpr, desktop, preset }) → { W, H }
//   exportFraming(format, az, { pair, style, W, H, targets, zB, nearlySame }) → { az, alt, fov }
//   groundScrimFor(format, view, { pair, style, textMode, W, H }) → 0..1
//   clockNudge(view, sky, { W, H }) → { az, alt, fov, ids } | null   (S14 wallpaper auto-nudge target)
//   exportBlob(dataUrl) → Blob                  (navigator.share({ files }) / <a download>)
//   qrTileSize(modules) → px                    DESKTOP_SIZES, PAPER_WINDOW, FONT_TEXT
//
// render(opts)
//   format      'wallpaper' | 'card'
//   style       'night' (夜色) | 'mono' (黑白) | 'paper' (纸, card only)
//   textMode    wallpaper: 'poem+date' (default) | 'poem' | 'date' | 'none'   ('full' = 'poem+date')
//               card:      'full' (default: date + sentence) | 'date' | 'none'
//   lines       constellation lines (连线：开), default false; culture 'cn' | 'iau' | 'none'
//   qr          card only, default true; url is the QR target (default: the person link, or the
//               two-person result link)
//   sentence    wallpaper: the viewer's own line (写一句), replaces the poem and its attribution;
//               card: L3, a string or a poem { lines, by, title } (default: the 光年之星 sentence)
//   poem        wallpaper poem { lines, by, title } (default poemForPerson(person, 0, { pair }).poem)
//   view        { az, alt, fov } as framed in the viewfinder (default exportFraming(format, 180))
//   size        { W, H } (default exportSize(format, this screen))
//   screenCSSW  CSS width of the screen the view was framed on: dpr = W / screenCSSW (clamped 2–3.5),
//               so stars keep their on-screen size relative to the frame, only sharper
//   person, sky, facts        sky and facts are computed when missing
//   subjectName '你' on your own sky, the friend's name (or 'TA') on a guest sky; guest: boolean
//               (default: subjectName is set and is not 你). A guest wallpaper prefixes the friend's name.
//   pair        a computeHepan() result: A's sky with B's horizon baked in, non-shared stars at 0.25
//   dayMask     as on screen (1 = true daylight, 0.14 = 藏起阳光); terrainH as on screen (default 0.05)
//   poemFont    'auto' (default: Songti SC in canvas on iOS when installed, else the text face) | 'serif' | 'sans'
//   onProgress  (0..1) callback, for the 就这张 underline
import qrcode from 'qrcode-generator';
import { SkyRenderer } from './renderer.js';
import { Camera, altForHorizonAt, horizonFracAt, terrainAtRad, ridgeNearRad, ridgeFarRad, angDiff } from './camera.js';
import { skyState, zonedToUtc, mul } from './astro.js';
import { computeFacts, lightStarSentence } from './facts.js';
import { T, wrapCanvas, fmtDot, nameOr, graphemes } from './copy.js';
import { poemForPerson, attribution } from './poems.js';
import { linkFor } from './share.js';
import { mulberry32, mwAt } from './catalog.js';

const DEG = Math.PI / 180;
const AU_KM = 149597870.7;
const MOON_R_KM = 1737.4;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// a yield so the 就这张 underline can move; a timer, not rAF, which never fires in a backgrounded WebView
const tick = () => new Promise((r) => setTimeout(r, 16));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- tokens (spec §2)
export const FONT_TEXT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const FONT_DISPLAY = '"Nawan Serif", "Songti SC", "STSong", serif';
const FONT_NUM = `"Cormorant Lining", ${FONT_TEXT}`;
const FONT_POEM_SERIF = `"Songti SC", ${FONT_TEXT}`;
const NIGHT_BG = [3 / 255, 4 / 255, 7 / 255];
const INK = {
  night: { text: [239, 232, 218], tile: [239, 232, 218], module: [7, 9, 12], line: [200, 214, 236] },
  mono: { text: [230, 230, 227], tile: [230, 230, 227], module: [6, 6, 6], line: [214, 214, 214] },
  paper: { text: [30, 35, 43], tile: null, module: [30, 35, 43], line: [30, 35, 43], paper: [238, 232, 220] },
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;

/** 纸: the sky is printed inside this window of the 1080 × 1440 card, horizon at 82% of it. */
export const PAPER_WINDOW = { x: 64, y: 64, w: 952, h: 1008, horizon: 0.82 };
const PAPER_HORIZON_FRAC = (PAPER_WINDOW.y + PAPER_WINDOW.horizon * PAPER_WINDOW.h) / 1440;

export const DESKTOP_SIZES = [
  { W: 1290, H: 2796, label: T.keep.desktopSizes[0] },
  { W: 1080, H: 2400, label: T.keep.desktopSizes[1] },
  { W: 2880, H: 1800, label: T.keep.desktopSizes[2] },
];

// ---------------------------------------------------------------- sizes and framings
/**
 * Pixel size of an export (spec §6 A/B). Phones: the screen at min(dpr, 3), long side ≤ 2868, short side
 * ≥ 1080 (a native size is kept exactly, e.g. 1179 × 2556; a scaled one is rounded to even). Desktop:
 * DESKTOP_SIZES[preset] (the resolution label cycles them). Cards are always 1080 × 1440.
 */
export function exportSize(format, { screenW, screenH, dpr = 1, desktop = false, preset = 0 } = {}) {
  if (format === 'card') return { W: 1080, H: 1440 };
  if (desktop) {
    const p = DESKTOP_SIZES[((preset % 3) + 3) % 3];
    return { W: p.W, H: p.H };
  }
  const sw = screenW || (typeof screen !== 'undefined' ? screen.width : 390) || 390;
  const sh = screenH || (typeof screen !== 'undefined' ? screen.height : 844) || 844;
  const s = Math.min(dpr || 1, 3);
  let W = Math.min(sw, sh) * s, H = Math.max(sw, sh) * s; // a phone wallpaper is portrait
  let k = 1;
  if (W < 1080) k = 1080 / W;
  if (H * k > 2868) k = 2868 / H;
  if (Math.abs(k - 1) < 1e-9 && Math.abs(W - Math.round(W)) < 0.01) return { W: Math.round(W), H: Math.round(H) };
  return { W: 2 * Math.round((W * k) / 2), H: 2 * Math.round((H * k) / 2) };
}

/** Where the horizon sits (fraction of the frame height) for each export. */
function horizonFrac(format, { pair = false, style = 'night', W, H } = {}) {
  if (format === 'wallpaper') return W && H && W > H ? 0.80 : 0.78;
  if (style === 'paper') return PAPER_HORIZON_FRAC;
  return pair ? 0.66 : 0.70;
}
function framingFov(format, { W, H } = {}) {
  if (format === 'wallpaper') return W && H && W > H ? 56 : 80;
  return 76;
}

/**
 * The viewfinder's framing for a format at an azimuth (spec S14): 壁纸 fov 80° with the horizon at 0.78H
 * (a landscape desktop size: fov 56°, 0.80H); 便签 fov 76° at 0.70H (两个人 0.66H; 纸 at 82% of the
 * printed window).
 *   targets  NEU vectors (e.g. a pair's 牛郎星 + 织女星): face their middle; on a card widen up to 90°,
 *            then let the horizon sink, until they sit in the sky above the text.
 *   zB       B's zenith in A's NEU (a pair; skipped when nearlySame): choose the azimuth (and on a card
 *            the fov) so B's horizon crosses the frame's centre column at 25–45% of the height (spec S17;
 *            40–62% on a wallpaper, below the clock), as flat as possible, the targets still in view.
 */
export function exportFraming(format, az = 180, opts = {}) {
  const frac = horizonFrac(format, opts);
  const fov0 = framingFov(format, opts);
  const W = opts.W || (format === 'card' ? 1080 : 1179), H = opts.H || (format === 'card' ? 1440 : 2556);
  const targets = (opts.targets || []).map((t) => t.n || t).filter((n) => Array.isArray(n) || n instanceof Float32Array);
  let azPref = az;
  if (targets.length) {
    let sx = 0, sy = 0;
    for (const n of targets) { const a = Math.atan2(n[1], n[0]); sx += Math.cos(a); sy += Math.sin(a); }
    azPref = az + angDiff(az, Math.atan2(sy, sx) / DEG);
  }
  const cam = new Camera();
  cam.setSize(W, H);
  cam.Pfixed = 0;
  const put = (v) => { cam.az = v.az; cam.alt = v.alt; cam.fov = v.fov; cam.update(); };
  const card = format === 'card';
  const inZone = (n) => {
    const p = cam.project(n);
    return !!p && p.x > 0.1 * W && p.x < 0.9 * W && p.y > (card ? 0.08 : 0.36) * H && p.y < (card ? 0.58 : 0.70) * H;
  };
  const fovs = card ? [76, 78, 80, 82, 84, 86, 88, 90] : [fov0];

  const zB = opts.zB && !opts.nearlySame ? opts.zB : null;
  if (zB) {
    const [lo, hi] = card ? [0.25, 0.45] : [0.40, 0.62];
    let best = null, bestScore = Infinity;
    for (const fov of fovs) {
      for (let d = -180; d < 180; d += 2) {
        const v = { az: azPref + d, alt: altForHorizonAt(frac, fov), fov };
        put(v);
        const line = centreCrossing(cam, zB);
        if (!line) continue;
        const f = line.y / H;
        let score = (f < lo ? lo - f : f > hi ? f - hi : 0) * 12 + Math.abs(line.angle) * 0.8
          + Math.abs(d) / 180 * 0.4 + (fov - fovs[0]) / 14 * 0.3;
        for (const n of targets) if (!inZone(n)) score += 1;
        if (score < bestScore) { bestScore = score; best = v; }
      }
    }
    if (best) return best;
  }

  const view = { az: azPref, alt: altForHorizonAt(frac, fov0), fov: fov0 };
  if (!targets.length || !card) return view;
  const fits = (v) => { put(v); return targets.every(inZone); };
  for (const fov of fovs) {
    const v = { az: azPref, alt: altForHorizonAt(frac, fov), fov };
    if (fits(v)) return v;
  }
  for (let dAlt = 1; dAlt <= 30; dAlt++) {
    const v = { az: azPref, alt: altForHorizonAt(frac, 90) + dAlt, fov: 90 };
    if (fits(v)) return v;
  }
  return { az: azPref, alt: altForHorizonAt(frac, 90), fov: 90 };
}

/**
 * Where B's horizon (the great circle n·zB = 0) crosses the screen's centre column — which, with no
 * roll and P = 0, is the great circle through the view centre f and up u — and the line's screen angle
 * there (radians, 0 = level). null when it crosses behind the camera.
 */
function centreCrossing(cam, zB) {
  const fz = cam.f[0] * zB[0] + cam.f[1] * zB[1] + cam.f[2] * zB[2];
  const uz = cam.u[0] * zB[0] + cam.u[1] * zB[1] + cam.u[2] * zB[2];
  // cos φ·fz + sin φ·uz = 0 has two roots, φ and φ + π; take the one in front (cos φ > 0)
  const l = Math.hypot(fz, uz);
  if (l < 1e-9) return null;
  let c = uz / l, s = -fz / l;
  if (c < 0) { c = -c; s = -s; }
  if (c < 0.2) return null;
  const n = [c * cam.f[0] + s * cam.u[0], c * cam.f[1] + s * cam.u[1], c * cam.f[2] + s * cam.u[2]];
  const t = [zB[1] * n[2] - zB[2] * n[1], zB[2] * n[0] - zB[0] * n[2], zB[0] * n[1] - zB[1] * n[0]];
  const e = 0.01, m = [n[0] + e * t[0], n[1] + e * t[1], n[2] + e * t[2]];
  const a = cam.project(n), b = cam.project(m);
  if (!a || !b) return null;
  let ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
  return { y: a.y, angle: ang };
}

/**
 * How much ground darkening to bake in under the text (spec §6 A "Horizon moved"): 0 at the default
 * framing, rising to 1 as the horizon drops below the text band and the ground leaves the frame.
 */
export function groundScrimFor(format, view, { pair = false, style = 'night', textMode, W, H } = {}) {
  if (style === 'paper' || textMode === 'none') return 0;
  const hf = horizonFracAt(view.alt, view.fov);
  if (!(hf < 1)) return 1;
  if (format === 'wallpaper') return W && H && W > H ? smooth(0.84, 0.94, hf) : smooth(0.80, 0.90, hf);
  return pair ? smooth(0.68, 0.76, hf) : smooth(0.72, 0.80, hf);
}

/**
 * The S14 wallpaper auto-nudge: when the Moon or a planet brighter than 0 等 lies in the lock-screen
 * clock rect (x 0.2–0.8W, y 0.08–0.34H), the smallest turn (az ±10°, alt ±6°, turning preferred to
 * tilting) that moves every such body out of it. null when nothing is in the way or nothing helps.
 */
export function clockNudge(view, sky, { W = 1179, H = 2556 } = {}) {
  const cam = new Camera();
  cam.setSize(W, H);
  cam.Pfixed = 0;
  const bodies = (sky?.bodies || []).filter((b) => b.alt > 0 && (b.id === 'Moon' || (b.id !== 'Sun' && b.mag < 0)));
  if (!bodies.length) return null;
  const hits = (v) => {
    Object.assign(cam, v);
    cam.update();
    const m = 0.03 * W;
    return bodies.filter((b) => {
      const p = cam.project(b.n);
      return p && p.x > 0.2 * W - m && p.x < 0.8 * W + m && p.y > 0.08 * H - m && p.y < 0.34 * H + m;
    });
  };
  const now = hits(view);
  if (!now.length) return null;
  let best = null, bestCost = Infinity;
  for (let dAz = -10; dAz <= 10; dAz += 0.5) {
    for (let dAlt = -6; dAlt <= 6; dAlt += 0.5) {
      const cost = (dAz / 10) ** 2 + 2.5 * (dAlt / 6) ** 2;
      if (cost >= bestCost) continue;
      const v = { az: view.az + dAz, alt: view.alt + dAlt, fov: view.fov };
      if (!hits(v).length) { best = v; bestCost = cost; }
    }
  }
  return best ? { ...best, ids: now.map((b) => b.id) } : null;
}

/** A JPEG data URL (render().dataUrl) as a Blob, e.g. for navigator.share({ files: [new File([blob], name)] }). */
export function exportBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(',');
  const bin = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: /data:([^;]+)/.exec(head)?.[1] || 'image/jpeg' });
}

// ---------------------------------------------------------------- small helpers
const isIOS = () => typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

let songtiKnown = null;
/** Whether a system font is installed: its metrics differ from both generic fallbacks. */
function hasFont(family) {
  try {
    const c = document.createElement('canvas').getContext('2d');
    const s = '星汉灿烂若出其里0123';
    const w = (f) => { c.font = `40px ${f}`; return c.measureText(s).width; };
    return w(`"${family}", monospace`) !== w('monospace') || w(`"${family}", sans-serif`) !== w('sans-serif');
  } catch { return false; }
}

function momentOf(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm] = (p.time || '22:00').split(':').map(Number);
  return zonedToUtc(y, m, d, hh, mm, p.city.tz);
}

/** Kasten–Young extinction in magnitudes at a true altitude (radians), as the star shader does. */
function extinction(alt) {
  const a = Math.max(alt, 0);
  const X = 1 / (Math.sin(a) + 0.50572 * Math.pow(6.07995 + a / DEG, -1.6364));
  return Math.min(0.28 * (X - 1), 3.5);
}

/** A digit run (0-9 . : -, starting and ending with a digit) is set in Cormorant Lining, the rest in the text face. */
function runsOf(text) {
  const out = [];
  const re = /[0-9](?:[0-9.:\-]*[0-9])?/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), num: false });
    out.push({ t: m[0], num: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), num: false });
  return out;
}

function runFont(run, size, textWeight = 400, numSize = size) {
  return run.num ? `500 ${numSize}px ${FONT_NUM}` : `${textWeight} ${size}px ${run.font || FONT_TEXT}`;
}

function measureRuns(ctx, runs, size, opts) {
  let w = 0;
  for (const r of runs) {
    ctx.font = runFont(r, r.size || size, opts?.weight, opts?.numSize);
    r.w = ctx.measureText(r.t).width;
    w += r.w;
  }
  return w;
}

/** Draw mixed-face runs on one baseline; align 'left' | 'center'. */
function drawRuns(ctx, runs, x, y, size, align, fill, opts) {
  const total = measureRuns(ctx, runs, size, opts);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = fill;
  for (const r of runs) {
    ctx.font = runFont(r, r.size || size, opts?.weight, opts?.numSize);
    ctx.fillText(r.t, cx, y);
    cx += r.w;
  }
  return total;
}

function drawLine(ctx, text, x, y, font, fill, align = 'left') {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/**
 * Phrase breaking: lines that end only at a phrase boundary (after ，。、；：！？ or ——), each as long
 * as fits, the last keeping at least 4 characters (the no-widow rule). null when that cannot be done
 * within maxLines.
 */
const PHRASE_END = /[，。、；：！？,;!?]$|——$/;
function wrapPhraseStrict(ctx, text, maxW, maxLines) {
  const g = graphemes(String(text ?? '').trim());
  const w = (a, b) => ctx.measureText(g.slice(a, b).join('').trim()).width;
  const out = [];
  let start = 0;
  while (start < g.length) {
    if (w(start, g.length) <= maxW) { out.push(g.slice(start).join('').trim()); break; }
    let best = -1;
    for (let end = start + 1; end < g.length; end++) {
      if (!PHRASE_END.test(g.slice(start, end).join('')) || g[end] === '—') continue;
      if (w(start, end) > maxW) break;
      best = end;
    }
    if (best < 0) return null;
    out.push(g.slice(start, best).join('').trim());
    start = best;
    while (g[start] === ' ') start++;
  }
  if (out.length > maxLines || (out.length > 1 && charCount(out[out.length - 1]) < 4)) return null;
  return out;
}

/**
 * wrapCanvas (copy.js: no widows, kinsoku, names kept whole), preferring phrase boundaries when the
 * text still fits in the same number of lines: 「…2001 年出发的，／那年你 3 岁。」 rather than
 * 「…出发的，那年／你 3 岁。」.
 */
function wrapPhrase(ctx, text, maxW, maxLines = 2) {
  const lines = wrapCanvas(ctx, text, maxW, maxLines);
  if (lines.length < 2 || /\n/.test(text) || lines[lines.length - 1].endsWith('…')) return lines;
  return wrapPhraseStrict(ctx, text, maxW, lines.length) || lines;
}

const isPoem = (x) => x && typeof x === 'object' && Array.isArray(x.lines);
const charCount = (s) => graphemes(s).filter((c) => !/\s/.test(c)).length;

// ---------------------------------------------------------------- the Moon and planets
/** Screen angle (radians) from the Moon toward the Sun: the bright limb faces it. */
function limbAngle(cam, moonN, sunN) {
  const d = moonN[0] * sunN[0] + moonN[1] * sunN[1] + moonN[2] * sunN[2];
  const t = [sunN[0] - d * moonN[0], sunN[1] - d * moonN[1], sunN[2] - d * moonN[2]];
  const tl = Math.hypot(t[0], t[1], t[2]) || 1;
  const e = 0.02;
  const q = [moonN[0] + (t[0] / tl) * e, moonN[1] + (t[1] / tl) * e, moonN[2] + (t[2] / tl) * e];
  const ql = Math.hypot(q[0], q[1], q[2]);
  const a = cam.project(moonN, {}), b = cam.project([q[0] / ql, q[1] / ql, q[2] / ql], {});
  return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
}

/** The lit part of the disc (spec: true phase), in a frame rotated so the Sun is toward +x. */
function litPath(r, illum) {
  const p = new Path2D();
  const e = r * (1 - 2 * illum);
  p.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  p.ellipse(0, 0, Math.max(0.001, Math.abs(e)), r, 0, Math.PI / 2, -Math.PI / 2, e > 0);
  p.closePath();
  return p;
}

/** 夜色 Moon (spec §3.4): a crisp disc, a halo of 3r at α.10 and earthshine at α.12; no big glow. */
function moonLight(ctx, x, y, r, illum, limb, a) {
  const halo = ctx.createRadialGradient(x, y, r, x, y, 3 * r);
  halo.addColorStop(0, `rgba(239,232,218,${(0.10 * a).toFixed(3)})`);
  halo.addColorStop(1, 'rgba(239,232,218,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(x, y, 3 * r, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = `rgba(176,184,200,${(0.12 * a).toFixed(3)})`;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(limb);
  const lit = litPath(r, illum);
  const g = ctx.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r * 1.05);
  g.addColorStop(0, `rgba(248,245,236,${a.toFixed(3)})`);
  g.addColorStop(1, `rgba(220,215,202,${a.toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fill(lit);
  ctx.clip(lit);
  ctx.rotate(-limb);
  ctx.fillStyle = `rgba(118,118,124,${(0.16 * a).toFixed(3)})`;
  for (const [mx, my, mr] of [[-0.25, -0.3, 0.32], [0.18, -0.1, 0.26], [0.05, 0.3, 0.22], [-0.35, 0.15, 0.18], [0.35, 0.28, 0.14]]) {
    ctx.beginPath(); ctx.arc(mx * r, my * r, mr * r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** 纸 Moon: the almanac convention — the dark part in ink, the lit part left as paper, a hairline limb. */
function moonInk(ctx, x, y, r, illum, limb, a, ink, paper) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = rgba(ink, 0.40 * a);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(limb);
  ctx.fillStyle = rgba(paper, 1);
  ctx.fill(litPath(r, illum));
  ctx.strokeStyle = rgba(ink, 0.62 * a);
  ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/**
 * 纸 star dot (spec §6 B): the spec's curve r = 0.55 + 3.4·10^(−0.19(mag+1)), ink α .55 (6 等) → .95
 * (−1 等). Its radii are taken in units of 2 card px (INK_UNIT): read literally in 1080-px units a 4 等
 * star is a 2-px speck that reads as dust on a phone; doubled, 0 等 is ~11 px across and 6 等 ~3 px.
 */
const INK_UNIT = 2;
// brighter than −0.3 等 the dot stops growing (Sirius, Venus), so no single blot dominates the print
const inkRadius = (m) => INK_UNIT * (0.55 + 3.4 * Math.pow(10, -0.19 * (Math.max(m, -0.3) + 1)));
const inkAlpha = (m) => 0.55 + 0.40 * clamp((6 - m) / 7, 0, 1);

// ---------------------------------------------------------------- geometry of one frame
/**
 * The ridge (or one of its layers) as device-px points across the frame, sampled finely enough to keep
 * the tree crowns. `fn(azRad, H)` is one of camera.js's exact ports of the shader's ridge.
 */
function ridgePoints(env, fn) {
  const { cam, dpr, terrainH } = env;
  const pxDeg = cam.pxPerDeg() * dpr;
  const step = clamp(1.1 / pxDeg, 0.02, 0.25);
  const span = Math.min(179, cam.diagFov * 0.62 + 12);
  const xs = [], ys = [];
  const q = {};
  for (let a = cam.az - span; a <= cam.az + span; a += step) {
    const ar = a * DEG, h = fn(ar, terrainH), ch = Math.cos(h);
    if (!cam.project([ch * Math.cos(ar), ch * Math.sin(ar), Math.sin(h)], q) || q.d < 0.08) continue;
    xs.push(q.x * dpr); ys.push(q.y * dpr);
  }
  return { xs, ys };
}

/** Region above (sky) or below (ground) a ridge polyline, extended past the frame. */
function regionPath({ xs, ys }, W, H, below = false) {
  const p = new Path2D();
  const B = 4 * (W + H);
  if (!xs.length) {
    // no horizon in front of the camera (looking straight up or down)
    if (!below) p.rect(-B, -B, W + 2 * B, H + 2 * B);
    return p;
  }
  const n = xs.length;
  p.moveTo(-B, below ? H + B : -B);
  p.lineTo(-B, ys[0]);
  for (let i = 0; i < n; i++) p.lineTo(xs[i], ys[i]);
  p.lineTo(W + B, ys[n - 1]);
  p.lineTo(W + B, below ? H + B : -B);
  p.closePath();
  return p;
}

/** y of a polyline at x (linear interpolation); +∞ when there is no ridge in front. */
function yAt({ xs, ys }, x) {
  const n = xs.length;
  if (!n) return Infinity;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const t = (x - xs[lo]) / Math.max(1e-6, xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

// ---------------------------------------------------------------- QR
function makeQR(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr;
}

/**
 * Spec §6 B: a square tile of at least 156 px and at least 3.4 px per module, anchored at its bottom-right
 * corner (it grows leftward and upward), quiet zone 4 modules, ECC M. Modules are whole pixels — at
 * least 4 px (the 3.4 rounded up) — because fractional modules alternate 3 and 4 px columns, which
 * decoders mis-sample once a chat app has scaled the image down (tools/dev/export-test.mjs checks the
 * decode after JPEG q .80 at 0.5×). A version-6 person link gives a 196 px tile, a version-8 two-person
 * link 228 px. On paper the modules are printed straight on the paper (the paper is the quiet zone).
 */
export function qrTileSize(modules) {
  return (modules + 8) * Math.max(4, Math.ceil(156 / (modules + 8)));
}

function drawQR(ctx, url, right, bottom, ink) {
  const qr = makeQR(url);
  const n = qr.getModuleCount();
  const cell = Math.max(4, Math.ceil(156 / (n + 8)));
  const x0 = right - (n + 8) * cell, y0 = bottom - (n + 8) * cell;
  if (ink.tile) {
    ctx.fillStyle = rgba(ink.tile, 0.94);
    ctx.fillRect(x0, y0, right - x0, bottom - y0);
  }
  ctx.fillStyle = rgba(ink.module, 1);
  const edge = (i) => x0 + (i + 4) * cell;
  const edgeY = (i) => y0 + (i + 4) * cell;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let e = c;
      while (e + 1 < n && qr.isDark(r, e + 1)) e++;
      ctx.fillRect(edge(c), edgeY(r), edge(e + 1) - edge(c), edgeY(r + 1) - edgeY(r));
      c = e;
    }
  }
  return { url, version: (n - 17) / 4, modules: n, size: right - x0, x: x0, y: y0 };
}

// ---------------------------------------------------------------- the studio
export class PosterStudio {
  constructor(catalog) {
    this.catalog = catalog;
    this.renderer = null;
    this.glCanvas = null;
    this.out = null;
    this.queue = Promise.resolve();
    this.maxTile = null; // tests: force tiling below this many device px
    this.debugState = null; // tests: renderer-state overrides
  }

  /** Fonts (spec §6: awaited before any text is drawn) and the deep stars. */
  ready() {
    if (!this._ready) {
      this._ready = Promise.all([
        loadFonts(),
        Promise.race([this.catalog.deepReady || Promise.resolve(), sleep(4000)]).catch(() => null),
      ]).then(() => undefined);
    }
    return this._ready;
  }

  sky() {
    if (!this.renderer || this.renderer.lost) {
      this.renderer?.dispose?.();
      this.glCanvas = document.createElement('canvas');
      this.renderer = new SkyRenderer(this.glCanvas, this.catalog, { preserve: true });
    }
    return this.renderer;
  }

  release() {
    this.releaseOutput();
    if (this.renderer) { try { this.renderer.dispose(); } catch { /* already lost */ } }
    if (this.glCanvas) { this.glCanvas.width = 0; this.glCanvas.height = 0; }
    this.renderer = null;
    this.glCanvas = null;
  }

  releaseOutput() {
    if (this.out) { this.out.width = 0; this.out.height = 0; }
    this.out = null;
  }

  render(opts) {
    const job = this.queue.then(() => this.renderNow(opts));
    this.queue = job.catch(() => null);
    return job;
  }

  async renderNow(opts) {
    const t0 = performance.now();
    this.releaseOutput(); // one full-size canvas at a time
    const progress = opts.onProgress || (() => {});
    await this.ready();
    progress(0.1);
    const req = this.request(opts);
    let res;
    try {
      res = await this.renderAt(req, req.size, progress);
    } catch (e) {
      if (e && e.code === 'webgl') throw e;
      // last resort (spec §6): 1080 wide
      if (req.size.W <= 1080) throw e;
      this.releaseOutput();
      const W = 1080, H = 2 * Math.round((req.size.H * 1080) / req.size.W / 2);
      res = await this.renderAt(req, { W, H }, progress);
      res.fallback = '1080';
    }
    progress(1);
    res.ms = Math.round(performance.now() - t0);
    return res;
  }

  /** Normalised request: defaults, the sky and facts, the text to set. */
  request(o) {
    const format = o.format === 'card' ? 'card' : 'wallpaper';
    let style = ['night', 'mono', 'paper'].includes(o.style) ? o.style : 'night';
    if (style === 'paper' && format !== 'card') style = 'night'; // 纸 is a 便签 style only
    const pair = o.pair || null;
    const person = pair ? pair.a : o.person;
    if (!person) throw new Error('poster: person required');
    const sky = pair ? pair.sa : (o.sky || skyState(momentOf(person), person.city.lat, person.city.lon));
    let textMode = o.textMode || (format === 'card' ? 'full' : 'poem+date');
    if (format === 'wallpaper' && textMode === 'full') textMode = 'poem+date';
    if (format === 'card' && !['full', 'date', 'none'].includes(textMode)) textMode = textMode === 'poem' || textMode === 'poem+date' ? 'full' : 'date';
    const size = o.size || exportSize(format, {
      screenW: typeof screen !== 'undefined' ? screen.width : 390,
      screenH: typeof screen !== 'undefined' ? screen.height : 844,
      dpr: typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 3,
    });
    let view = o.view || exportFraming(format, 180, { pair: !!pair, style, W: size.W, H: size.H });
    // a gift card faces the most beautiful part of the friend's sky (the brightest Milky Way that is up),
    // and needs more ground for 致/message/signature: horizon at 0.66H instead of 0.70H
    if (o.gift && !o.view && format === 'card') {
      const az = this.bestAzimuth(sky);
      view = exportFraming(format, az ?? 180, { style, W: size.W, H: size.H });
      if (style !== 'paper') view = { ...view, alt: altForHorizonAt(0.66, view.fov) };
    }
    const subject = o.subjectName || '你';
    const guest = o.guest ?? (!!o.subjectName && o.subjectName !== '你');
    return {
      ...o, format, style, pair, person, sky, textMode, size, view, subject, guest,
      qr: format === 'card' && o.qr !== false,
      url: o.url || (pair ? linkFor('result', pair.a, pair.b) : o.gift ? linkFor('gift', person, null, { from: o.gift.from }) : linkFor('person', person)),
      culture: o.culture || 'cn',
      lines: !!o.lines && o.culture !== 'none',
      dayMask: o.dayMask ?? 1,
      terrainH: o.terrainH ?? 0.05,
      screenCSSW: o.screenCSSW || (typeof innerWidth !== 'undefined' ? innerWidth : 390),
      facts: o.facts || null,
    };
  }

  /** Azimuth (deg) whose sky from 12° to 55° holds the most Milky Way at this moment; null if it is all down. */
  bestAzimuth(sky) {
    const lum = this.catalog.mwLum;
    if (!lum) return null;
    const M = sky.M, Mt = [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
    let best = null, bestL = 0.6;
    for (let az = 0; az < 360; az += 8) {
      let L = 0;
      for (const alt of [12, 22, 32, 44, 55]) {
        const a = az * DEG, h = alt * DEG;
        const e = mul(Mt, [Math.cos(h) * Math.cos(a), Math.cos(h) * Math.sin(a), Math.sin(h)]);
        L += mwAt(lum, Math.atan2(e[1], e[0]) / DEG, Math.asin(Math.max(-1, Math.min(1, e[2]))) / DEG);
      }
      if (L > bestL) { bestL = L; best = az; }
    }
    return best;
  }

  cardSentence(req) {
    if (req.sentence != null && req.sentence !== '') return req.sentence;
    if (req.poem) return req.poem;
    const facts = req.facts || computeFacts(this.catalog, req.person, momentOf(req.person), req.sky);
    return lightStarSentence(facts, req.subject);
  }

  async renderAt(req, { W, H }, progress) {
    const dpr = clamp(W / req.screenCSSW, 2, 3.5);
    const cam = new Camera();
    cam.setSize(W / dpr, H / dpr);
    cam.Pfixed = 0;
    cam.az = req.view.az; cam.alt = req.view.alt; cam.fov = req.view.fov;
    cam.update();

    // before allocating anything big: the GPU must take the frame's width (tiles only split it vertically)
    const gl = this.sky().gl;
    if (!gl || gl.isContextLost?.()) { const e = new Error('poster: WebGL unavailable'); e.code = 'webgl'; throw e; }
    const glMaxW = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
    if (W > glMaxW) throw new Error('poster: frame wider than the GPU allows');

    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    if (!ctx || out.width !== W || out.height !== H) throw new Error('poster: canvas allocation failed');
    this.out = out;

    const env = { cam, dpr, W, H, sky: req.sky, terrainH: req.terrainH, req, ink: INK[req.style] };
    env.ridge = ridgePoints(env, terrainAtRad);
    env.skyPath = regionPath(env.ridge, W, H);
    const scrim = groundScrimFor(req.format, req.view, { pair: !!req.pair, style: req.style, textMode: req.textMode, W, H });

    if (req.style === 'paper') {
      await this.paintPaper(ctx, env);
      progress(0.6);
    } else {
      this.paintSky(ctx, env, this.glState(env));
      progress(0.45);
      await tick();
      ctx.save();
      ctx.clip(env.skyPath);
      if (req.lines) this.drawLines(ctx, env);
      this.drawBodies(ctx, env);
      ctx.restore();
      if (req.pair && !req.pair.nearlySame) this.drawHorizonB(ctx, env);
      if (scrim > 0.001) this.bakeScrim(ctx, env, scrim);
      if (req.style === 'mono') { this.monoMap(ctx, W, H); await tick(); }
      progress(0.65);
    }

    const qr = this.drawText(ctx, req, W, H);
    if (req.style === 'paper') this.paperGrain(ctx, W, H);
    progress(0.8);
    await tick();
    const dataUrl = out.toDataURL('image/jpeg', 0.92);
    if (!dataUrl || dataUrl.length < 2000) throw new Error('poster: encoding failed');
    return { canvas: out, dataUrl, W, H, fallback: null, groundScrim: scrim, qr };
  }

  /** The renderer state for an export (spec §6: twinkle 0, vignette 0.08, dither 0.5/255, exposure 1.05). */
  glState(env) {
    const { cam, sky, req } = env;
    const sunAlt = sky.sun.alt;
    const pair = req.pair;
    return {
      cam, M: sky.M, time: 0, sun: sky.sun.n, moon: sky.moon.n,
      moonIllum: sky.moonPhase.illum * (sky.moon.alt > -2 ? 1 : 0) * (pair && !pair.bodyShared?.Moon ? 0.4 : 1),
      twilight: smooth(-18, -2, sunAlt) * 0.92 * req.dayMask, day: smooth(-3, 10, sunAlt) * 0.6 * req.dayMask,
      reveal: 6.6, mwAmt: 1, starGain: 1, dustGain: 1,
      sizeGain: clamp(Math.pow(72 / cam.fov, 0.1), 0.92, 1.15),
      crisp: 1, sel: -1, twinkle: 0, terrainH: req.terrainH, bg: NIGHT_BG,
      exposure: 1.05, dither: 0.5 / 255, vignette: 0.08, listenAz: 0, listenOn: 0,
      zB: pair && !pair.nearlySame ? pair.zB : [0, 0, 0], sharedDim: pair && !pair.nearlySame ? 0.25 : 1, sharedT: pair ? 1 : 0,
      trail: null,
      ...this.debugState, // dev tests only (e.g. dither 0 to compare tiled and untiled frames exactly)
    };
  }

  /**
   * Render the sky for a rectangle of the frame (device px) through the GL context, in horizontal tiles
   * when the GPU's renderbuffer / viewport limit (or the drawing buffer it actually gave us) is shorter
   * than the rectangle. Tiles overlap by 64 px and are cropped, because GPUs clip point sprites whose
   * centre falls outside the viewport. `sink(tileCanvas, y0, y1, ry0)` receives each finished tile.
   */
  eachTile(env, state, rect, sink) {
    const r = this.sky();
    const gl = r.gl;
    if (!gl || gl.isContextLost?.()) { const e = new Error('poster: WebGL unavailable'); e.code = 'webgl'; throw e; }
    const EXT = 64;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    let maxH = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[1], this.maxTile || Infinity);
    const maxW = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0]);
    if (rect.w > maxW) throw new Error('poster: frame wider than the GPU allows');
    const { dpr } = env;
    for (let attempt = 0; attempt < 4; attempt++) {
      const tiles = [];
      if (rect.h <= maxH) tiles.push([rect.y, rect.y + rect.h]);
      else {
        const inner = maxH - 2 * EXT;
        if (inner < 64) throw new Error('poster: GPU too small');
        const n = Math.ceil(rect.h / inner);
        const step = Math.ceil(rect.h / n);
        for (let y = rect.y; y < rect.y + rect.h; y += step) tiles.push([y, Math.min(rect.y + rect.h, y + step)]);
      }
      let shrunk = false;
      for (const [y0, y1] of tiles) {
        const ry0 = tiles.length > 1 ? Math.max(rect.y, y0 - EXT) : y0;
        const ry1 = tiles.length > 1 ? Math.min(rect.y + rect.h, y1 + EXT) : y1;
        r.resize(rect.w / dpr, (ry1 - ry0) / dpr, dpr);
        if (gl.drawingBufferHeight < this.glCanvas.height || gl.drawingBufferWidth < this.glCanvas.width) {
          // the browser capped the drawing buffer: tile to what we actually got
          maxH = Math.min(maxH, gl.drawingBufferHeight);
          if (gl.drawingBufferWidth < this.glCanvas.width) throw new Error('poster: drawing buffer too small');
          shrunk = true;
          break;
        }
        r.setTileOffset(rect.x, ry0);
        r.render(state);
        if (r.lost || gl.isContextLost?.()) { const e = new Error('poster: WebGL context lost'); e.code = 'webgl'; throw e; }
        sink(this.glCanvas, y0, y1, ry0);
      }
      if (!shrunk) break;
    }
    r.setTileOffset(0, 0);
    r.resize(1, 1, 1); // free the big drawing buffer before the 2D work
  }

  paintSky(ctx, env, state) {
    const rect = { x: 0, y: 0, w: env.W, h: env.H };
    this.eachTile(env, state, rect, (c, y0, y1, ry0) => {
      ctx.drawImage(c, 0, y0 - ry0, rect.w, y1 - y0, rect.x, y0, rect.w, y1 - y0);
    });
    this.drawBigHalos(ctx, env);
  }

  /**
   * Spec §6: stars whose sprite would exceed ALIASED_POINT_SIZE_RANGE get their halo in 2D. The shader
   * windows the wing to the (clamped) sprite; this adds the part of the wing outside it.
   */
  drawBigHalos(ctx, env) {
    const maxPoint = this.renderer?.maxPoint || 64;
    const { cam, dpr, sky, W, H } = env;
    const pr = dpr * clamp(Math.pow(72 / cam.fov, 0.1), 0.92, 1.15);
    const al = 1.5 * pr;
    const st = this.catalog.stars;
    const q = {}, n = [0, 0, 0];
    ctx.save();
    ctx.clip(env.skyPath);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < st.count && st.mag[i] < 1.6; i++) {
      mul(sky.M, [st.pos[i * 3], st.pos[i * 3 + 1], st.pos[i * 3 + 2]], n);
      if (n[2] < 0 || !cam.project(n, q)) continue;
      const m = st.mag[i] + extinction(Math.asin(n[2]));
      const F = Math.pow(2, -1.3287712 * (m - 6));
      const Pw = 0.03 * Math.pow(F, 0.85); // wing peak at gain 1
      const rw = al * Math.sqrt(Math.max(Math.pow(Math.max(Pw, 0.004) / 0.004, 1 / 1.8) - 1, 0));
      if (2 * rw + 1.5 <= maxPoint) continue;
      const x = q.x * dpr, y = q.y * dpr;
      if (x < -rw || y < -rw || x > W + rw || y > H + rw) continue;
      const r0 = maxPoint * 0.5 * 0.7, stops = 8;
      const g = ctx.createRadialGradient(x, y, r0, x, y, rw);
      for (let k = 0; k <= stops; k++) {
        const rr = r0 + ((rw - r0) * k) / stops;
        const v = Pw * Math.pow(1 + (rr * rr) / (al * al), -1.8);
        const I = (1 - Math.exp(-v)) * 0.93 * (k === 0 ? 0.3 : 1);
        g.addColorStop(k / stops, `rgba(235,236,245,${I.toFixed(4)})`);
      }
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rw, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- vectors
  drawBodies(ctx, env) {
    const { cam, dpr, sky, req } = env;
    const q = {};
    const day = smooth(-3, 10, sky.sun.alt) * 0.6 * req.dayMask;
    const paper = req.style === 'paper';
    for (const b of sky.bodies) {
      if (b.id === 'Sun' || b.alt < -1) continue;
      if (!cam.project(b.n, q)) continue;
      const x = q.x * dpr, y = q.y * dpr;
      const dim = req.pair && !req.pair.bodyShared?.[b.id] ? 0.4 : 1;
      if (b.id === 'Moon') {
        const rCss = clamp(2.2 * cam.pxPerRad(b.n) * Math.asin(Math.min(1, MOON_R_KM / (b.dist * AU_KM))), 5, 14);
        const r = rCss * dpr;
        const limb = limbAngle(cam, b.n, sky.sun.n);
        if (paper) moonInk(ctx, x, y, r, sky.moonPhase.illum, limb, dim, env.ink.text, env.ink.paper);
        else moonLight(ctx, x, y, r, sky.moonPhase.illum, limb, dim);
        continue;
      }
      if (paper) {
        const r = inkRadius(b.mag);
        ctx.fillStyle = rgba(env.ink.text, 0.92 * (dim < 1 ? 0.3 : 1));
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      // small coloured points: core radius 1.6–3 px, glow 3r at α.35 (spec §3.4)
      const a = dim * (1 - 0.85 * day * (b.id === 'Venus' ? 0.4 : 1));
      if (a < 0.02) continue;
      const r = clamp(2.3 - 0.3 * b.mag, 1.6, 3) * dpr;
      const c = b.color.map((v) => Math.round(255 * (0.82 * v + 0.18)));
      const g = ctx.createRadialGradient(x, y, 0, x, y, 3 * r);
      g.addColorStop(0, rgba(c, 0.35 * a));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 3 * r, 0, Math.PI * 2); ctx.fill();
      // the core is a point of light, not a disc: white-hot centre, the planet's colour, a soft edge
      const k = ctx.createRadialGradient(x, y, 0, x, y, r);
      k.addColorStop(0, `rgba(255,252,246,${(0.98 * a).toFixed(3)})`);
      k.addColorStop(0.45, rgba(c, 0.92 * a));
      k.addColorStop(0.8, rgba(c, 0.45 * a));
      k.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = k;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** 连线：开 — α.20, 1.2 px @1290 (spec §6), cool silver on the night styles, ink on paper. */
  drawLines(ctx, env) {
    const { cam, dpr, sky, req, W } = env;
    const set = req.culture === 'iau' ? this.catalog.iau : this.catalog.cn;
    if (!set?.lines) return;
    const ref = req.format === 'card' ? 1080 : Math.min(W, env.H);
    const gap = 2.6 * dpr;
    const a = [0, 0, 0], b = [0, 0, 0], pa = {}, pb = {};
    const path = new Path2D();
    for (const [, polys] of set.lines) {
      for (const poly of polys) {
        const count = poly.length / 3;
        for (let i = 0; i < count - 1; i++) {
          mul(sky.M, [poly[i * 3], poly[i * 3 + 1], poly[i * 3 + 2]], a);
          mul(sky.M, [poly[i * 3 + 3], poly[i * 3 + 4], poly[i * 3 + 5]], b);
          if (a[2] < -0.05 && b[2] < -0.05) continue;
          if (!cam.project(a, pa) || !cam.project(b, pb) || pa.d < 0.1 || pb.d < 0.1) continue;
          const x0 = pa.x * dpr, y0 = pa.y * dpr, x1 = pb.x * dpr, y1 = pb.y * dpr;
          const len = Math.hypot(x1 - x0, y1 - y0);
          if (len < 2 * gap + 2) continue;
          const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
          path.moveTo(x0 + ux * gap, y0 + uy * gap);
          path.lineTo(x1 - ux * gap, y1 - uy * gap);
        }
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.9, (1.2 * ref) / 1290);
    ctx.strokeStyle = rgba(env.ink.line, req.style === 'paper' ? 0.24 : 0.20);
    ctx.stroke(path);
    ctx.restore();
  }

  /**
   * B's horizon (spec §6 C): the great circle n·zB = 0 — a straight line in the rectilinear projection —
   * 1.5 px, dash 12 gap 10, α.40, drawn only across A's sky, with 「小红的地平线」 20 px α.50 lying along it
   * near the right end. Sizes are for the 1080 card and scale with the frame.
   */
  drawHorizonB(ctx, env) {
    const { cam, dpr, req, W, H } = env;
    const zB = req.pair.zB;
    const s = (req.format === 'card' ? 1080 : Math.min(W, H)) / 1080;
    // an orthonormal pair spanning the plane ⟂ zB
    const t = Math.abs(zB[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let e1 = [zB[1] * t[2] - zB[2] * t[1], zB[2] * t[0] - zB[0] * t[2], zB[0] * t[1] - zB[1] * t[0]];
    const l1 = Math.hypot(...e1); e1 = e1.map((v) => v / l1);
    const e2 = [zB[1] * e1[2] - zB[2] * e1[1], zB[2] * e1[0] - zB[0] * e1[2], zB[0] * e1[1] - zB[1] * e1[0]];
    const pts = [];
    const q = {};
    for (let th = 0; th < 360; th += 0.5) {
      const c = Math.cos(th * DEG), sn = Math.sin(th * DEG);
      const n = [c * e1[0] + sn * e2[0], c * e1[1] + sn * e2[1], c * e1[2] + sn * e2[2]];
      if (!cam.project(n, q) || q.d < 0.12) continue;
      pts.push([q.x * dpr, q.y * dpr]);
    }
    if (pts.length < 2) return;
    // one straight line: its two farthest-apart samples, oriented left → right
    let A = pts[0], B = pts[0], best = -1;
    for (const p of pts) { const d = (p[0] - pts[0][0]) ** 2 + (p[1] - pts[0][1]) ** 2; if (d > best) { best = d; B = p; } }
    best = -1;
    for (const p of pts) { const d = (p[0] - B[0]) ** 2 + (p[1] - B[1]) ** 2; if (d > best) { best = d; A = p; } }
    if (A[0] > B[0]) [A, B] = [B, A];
    const clipRect = req.style === 'paper' ? [PAPER_WINDOW.x, PAPER_WINDOW.y, PAPER_WINDOW.w, PAPER_WINDOW.h] : [0, 0, W, H];
    const ink = env.ink.text;
    ctx.save();
    ctx.beginPath(); ctx.rect(...clipRect); ctx.clip();
    ctx.clip(env.skyPath);
    ctx.setLineDash([12 * s, 10 * s]);
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = rgba(ink, 0.40);
    ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
    ctx.restore();

    // the label, near the right end: lying along the line (12 px above it) when the line is within 25°
    // of level; otherwise upright beside it, low in the sky, so it never reads sideways
    const label = req.pair.horizonLabel || T.export.pairHorizon(req.pair.nameB);
    const size = 20 * s;
    const font = `400 ${size}px ${FONT_TEXT}`;
    ctx.font = font;
    const lw = ctx.measureText(label).width;
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L;
    const ang = Math.atan2(uy, ux);
    const [fx, fy, fw, fh] = clipRect;
    const m = 44 * s;
    const inside = (x, y) => x > fx + m && x < fx + fw - m && y > fy + m && y < fy + fh - m && y < yAt(env.ridge, x) - 10 * s;
    const fill = rgba(ink, 0.50);
    if (Math.abs(ang) <= 25 * DEG) {
      const off = 12 * s, nx = uy, ny = -ux; // left normal of left→right = above the line
      for (let d = L; d > lw; d -= 4 * s) {
        const x = A[0] + ux * d, y = A[1] + uy * d;
        const xr = x + nx * off, yr = y + ny * off, xl = xr - ux * lw, yl = yr - uy * lw;
        if (![[xr, yr], [xl, yl], [xr + nx * size, yr + ny * size], [x, y], [x - ux * lw, y - uy * lw]].every(([a, b]) => inside(a, b))) continue;
        ctx.save();
        ctx.translate(xr, yr);
        ctx.rotate(ang);
        drawLine(ctx, label, 0, 0, font, fill, 'right');
        ctx.restore();
        return;
      }
    }
    // upright: walk the line from low in the sky upward; the text sits 16 px beside the line
    const along = [];
    for (let d = 0; d <= L; d += 4 * s) along.push([A[0] + ux * d, A[1] + uy * d]);
    along.sort((p, q) => q[1] - p[1]);
    for (const [x, y] of along) {
      const gap = 16 * s + size * 0.5 / Math.max(0.3, Math.abs(Math.tan(ang)));
      for (const side of [1, -1]) {
        const x0 = side > 0 ? x + gap : x - gap - lw, x1 = x0 + lw;
        const yb = y + size * 0.35;
        if (!inside(x0, yb) || !inside(x1, yb) || !inside(x0, yb - size) || !inside(x1, yb - size)) continue;
        if (yb > yAt(env.ridge, x) - 40 * s) continue;
        drawLine(ctx, label, x0, yb, font, fill, 'left');
        return;
      }
    }
  }

  /** Ground darkening under the text when the horizon was dragged below the text band (spec §6 A). */
  bakeScrim(ctx, env, amt) {
    const { H, W } = env;
    const land = W > H;
    const top = env.req.format === 'wallpaper' ? (land ? 0.70 : 0.66) : env.req.pair ? 0.58 : 0.62;
    const g = ctx.createLinearGradient(0, top * H, 0, H);
    g.addColorStop(0, 'rgba(3,4,7,0)');
    g.addColorStop(0.45, `rgba(3,4,7,${(0.62 * amt).toFixed(3)})`);
    g.addColorStop(0.7, `rgba(3,4,7,${(0.80 * amt).toFixed(3)})`);
    g.addColorStop(1, `rgba(3,4,7,${(0.88 * amt).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, top * H, W, H - top * H);
  }

  /** 黑白 (spec §6 A): luminance → silver, blacks #060606, highlights #E6E6E3, a gentle S-curve. */
  monoMap(ctx, W, H) {
    const rnd = mulberry32(606);
    const band = Math.max(1, Math.floor(4e6 / (W * 4)));
    for (let y0 = 0; y0 < H; y0 += band) {
      const h = Math.min(band, H - y0);
      const img = ctx.getImageData(0, y0, W, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        const sCurve = l * l * (3 - 2 * l);
        const v = clamp(l + (sCurve - l) * 0.3 + (rnd() - 0.5) / 224, 0, 1);
        d[i] = 6 + 224 * v;
        d[i + 1] = 6 + 224 * v;
        d[i + 2] = 6 + 221 * v;
      }
      ctx.putImageData(img, 0, y0);
    }
  }

  // -------------------------------------------------------------- 纸
  /**
   * The paper card (spec §6 B 纸): paper #EEE8DC; inside the window, the Milky Way as an ink wash (≤ α.14,
   * from a Milky-Way-only GL pass, blurred 2 px), the ridges as ink washes (far α.10, near α.22), the stars
   * as vector ink dots from the catalogue, the Moon in ink, lines and B's horizon when asked.
   */
  async paintPaper(ctx, env) {
    const { W, H, req } = env;
    const ink = env.ink.text, paper = env.ink.paper;
    ctx.fillStyle = rgba(paper, 1);
    ctx.fillRect(0, 0, W, H);
    const win = PAPER_WINDOW;

    // 1. the Milky Way wash: difference of two GL passes (with / without the band)
    const base = this.glState(env);
    const A = { ...base, starGain: 0, dustGain: 0, crisp: 0, moonIllum: 0, twilight: 0, day: 0, dither: 0, vignette: 0, exposure: 1, mwAmt: 1 };
    const rect = { x: win.x, y: win.y, w: win.w, h: win.h };
    const lum = new Float32Array(rect.w * rect.h);
    const gl = this.sky().gl;
    const buf = new Uint8Array(rect.w * rect.h * 4);
    for (const [state, sign] of [[A, 1], [{ ...A, mwAmt: 0 }, -1]]) {
      this.eachTile(env, state, rect, (c, y0, y1, ry0) => {
        const th = c.height, w = rect.w;
        const px = buf.subarray(0, w * th * 4);
        gl.readPixels(0, 0, w, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let y = y0; y < y1; y++) {
          const row = th - 1 - (y - ry0); // GL rows are bottom-up
          const o = row * w * 4, lo = (y - rect.y) * w;
          for (let x = 0; x < w; x++) {
            const k = o + x * 4;
            lum[lo + x] += sign * (0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]) / 255;
          }
        }
      });
    }
    await tick();
    boxBlur(lum, rect.w, rect.h, 2);
    boxBlur(lum, rect.w, rect.h, 2);
    const img = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const d = img.data;
    // only the star clouds approach the α.14 cap; the faint outer band stays a breath of grey
    const wash = { floor: 0.015, ref: 0.42, gamma: 1.35, ...(this.debugState?.paperWash || {}) };
    for (let i = 0, k = 0; i < lum.length; i++, k += 4) {
      const a = 0.14 * Math.pow(clamp((lum[i] - wash.floor) / (wash.ref - wash.floor), 0, 1), wash.gamma);
      d[k] = paper[0] + (ink[0] - paper[0]) * a;
      d[k + 1] = paper[1] + (ink[1] - paper[1]) * a;
      d[k + 2] = paper[2] + (ink[2] - paper[2]) * a;
    }
    ctx.putImageData(img, rect.x, rect.y);

    ctx.save();
    ctx.beginPath(); ctx.rect(win.x, win.y, win.w, win.h); ctx.clip();
    // 2. ridges as washes: the far ridge α.10 where it shows above the near one; the near ridge α.22
    //    along its crest, thinning toward the bottom of the window the way a wash does
    const far = ridgePoints(env, ridgeFarRad), near = ridgePoints(env, ridgeNearRad);
    ctx.save();
    ctx.clip(regionPath(near, W, H));
    ctx.fillStyle = rgba(ink, 0.10);
    ctx.fill(regionPath(far, W, H, true));
    ctx.restore();
    let crest = win.y + win.h;
    for (let i = 0; i < near.xs.length; i++) if (near.xs[i] >= win.x && near.xs[i] <= win.x + win.w) crest = Math.min(crest, near.ys[i]);
    const g = ctx.createLinearGradient(0, crest, 0, win.y + win.h);
    g.addColorStop(0, rgba(ink, 0.22));
    g.addColorStop(0.35, rgba(ink, 0.15));
    g.addColorStop(1, rgba(ink, 0.06));
    ctx.fillStyle = g;
    ctx.fill(regionPath(near, W, H, true));

    // 3. stars as ink dots (and the rest of the vector sky), only above the ridge
    ctx.save();
    ctx.clip(env.skyPath);
    if (req.lines) this.drawLines(ctx, env);
    this.inkStars(ctx, env);
    this.drawBodies(ctx, env);
    ctx.restore();
    ctx.restore();
    if (req.pair && !req.pair.nearlySame) this.drawHorizonB(ctx, env);
  }

  inkStars(ctx, env) {
    const { cam, dpr, sky, req } = env;
    const st = this.catalog.stars;
    const win = PAPER_WINDOW;
    const zB = req.pair && !req.pair.nearlySame ? req.pair.zB : null;
    const n = [0, 0, 0], q = {};
    const ink = env.ink.text;
    for (let i = 0; i < st.count; i++) {
      const mag = st.mag[i];
      if (mag > 6.0) continue;
      mul(sky.M, [st.pos[i * 3], st.pos[i * 3 + 1], st.pos[i * 3 + 2]], n);
      if (n[2] <= 0) continue;
      const m = mag + extinction(Math.asin(n[2]));
      if (m > 6.0 || !cam.project(n, q)) continue;
      const x = q.x * dpr, y = q.y * dpr;
      if (x < win.x - 6 || x > win.x + win.w + 6 || y < win.y - 6 || y > win.y + win.h + 6) continue;
      let a = inkAlpha(m);
      if (zB && n[0] * zB[0] + n[1] * zB[1] + n[2] * zB[2] < 0) a *= 0.3;
      ctx.fillStyle = rgba(ink, a);
      ctx.beginPath(); ctx.arc(x, y, inkRadius(m), 0, Math.PI * 2); ctx.fill();
    }
  }

  /** 1.5% luminance noise over the whole print (no fibres, no vignette). */
  paperGrain(ctx, W, H) {
    const rnd = mulberry32(1440);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const k = 1 + 0.015 * (rnd() + rnd() - 1);
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
    ctx.putImageData(img, 0, 0);
  }

  // -------------------------------------------------------------- text
  async previewText(ctx, opts) {
    await this.ready();
    const req = this.request(opts);
    return this.drawText(ctx, req, req.size.W, req.size.H);
  }

  drawText(ctx, req, W, H) {
    if (req.format === 'wallpaper') { this.wallpaperText(ctx, req, W, H); return null; }
    if (req.gift) return this.giftCardText(ctx, req);
    return req.pair ? this.pairCardText(ctx, req) : this.cardText(ctx, req);
  }

  /**
   * 星空贺卡 (a card made for a friend): the FRIEND's birth sky; on the ground, set like a letter —
   * a faint line naming whose night it is, 「给 小红」, an optional greeting (T.gift.greetingDefault
   * 「又到了你来的那一天。」), the message (a poem from the library — default poemForPerson(friend) — or
   * the sender's own words), the sender's 「小明 赠」 right-aligned at the end of the text column, the
   * wordmark, and the QR that opens the friend's own sky with the sender's name (linkFor('gift')).
   * gift: { to, from, greeting, message }. Every word on it comes from T.gift.
   * Positions for 1080 × 1440; 纸 prints below its sky window and allows two message lines.
   */
  giftCardText(ctx, req) {
    const paper = req.style === 'paper';
    const P = paper
      ? { x: 64, date: 1118, to: 1172, body: 1226, maxLines: 2, wm: 1392, qrR: 1016, qrB: 1392, cap: 1418 }
      : { x: 80, date: 1008, to: 1072, body: 1134, maxLines: 4, wm: 1376, qrR: 1000, qrB: 1376, cap: 1404 };
    const col = INK[req.style].text;
    const g = req.gift || {};
    const p = req.person;
    const colW = 700;
    const to = (g.to || p.name || '').trim();

    // whose night: 「2000.05.20  06:10　成都 · 小红来的那晚」
    const parts = T.export.cardDateParts(p);
    const whose = T.gift.cardWhose(p.city.name, to);
    drawRuns(ctx, [{ t: `${parts.dot}  ${parts.time || parts.night}　`, num: !!parts.time }, { t: whose, num: false }],
      P.x, P.date, 24, 'left', rgba(col, 0.50));
    drawLine(ctx, T.gift.cardTo(to), P.x, P.to, `500 40px ${FONT_TEXT}`, rgba(col, 0.94));

    // body: greeting + message, wrapped to the column, then the attribution
    const rows = [];
    ctx.font = `400 30px ${FONT_TEXT}`;
    if (g.greeting) rows.push({ text: g.greeting, size: 30, alpha: 0.94 });
    const msg = g.message ?? poemForPerson(p).poem;
    if (isPoem(msg)) {
      let ls = msg.lines.filter(Boolean);
      if (ls.length > 2) {
        const paired = [];
        for (let i = 0; i < ls.length; i += 2) paired.push(ls[i] + (ls[i + 1] || ''));
        if (paired.every((l) => ctx.measureText(l).width <= colW)) ls = paired;
      }
      for (const l of ls.flatMap((x) => wrapPhrase(ctx, x, colW, 2))) rows.push({ text: l, size: 30, alpha: 0.88 });
    } else if (typeof msg === 'string' && msg.trim()) {
      for (const l of wrapPhrase(ctx, msg.trim(), colW, P.maxLines)) rows.push({ text: l, size: 30, alpha: 0.88 });
    }
    const body = rows.slice(0, P.maxLines + (g.greeting ? 1 : 0));
    let y = P.body;
    for (const r of body) {
      drawLine(ctx, r.text, P.x, y, `400 ${r.size}px ${FONT_TEXT}`, rgba(col, r.alpha));
      y += 46;
    }
    const by = isPoem(msg) ? attribution(msg) : '';
    if (by) { drawLine(ctx, by, P.x, y - 6, `400 18px ${FONT_TEXT}`, rgba(col, 0.46)); y += 30; }
    if (g.from) {
      drawLine(ctx, T.gift.cardFrom(g.from), P.x + colW, y + 10, `400 26px ${FONT_TEXT}`, rgba(col, 0.72), 'right');
    }

    drawLine(ctx, T.export.wordmark, P.x, P.wm, `400 22px ${FONT_DISPLAY}`, rgba(col, 0.50));
    let qr = null;
    if (req.qr) {
      qr = drawQR(ctx, req.url, P.qrR, P.qrB, INK[req.style]);
      drawLine(ctx, T.export.giftQrCaption, qr.x + qr.size / 2, P.cap, `400 16px ${FONT_TEXT}`, rgba(col, 0.46), 'center');
    }
    return qr;
  }

  /**
   * Wallpaper (§10.3/§10.4): the poem (1–4 lines, centred; a single phrase of ≤ 5 characters larger),
   * its attribution, then the date line 「1998.07.14　杭州」 — in the band 0.77–0.86H (from 0.74H for a
   * 3–4 line poem), column ≤ 0.60W. A landscape desktop size sets it bottom-left at x 0.06W.
   */
  wallpaperText(ctx, req, W, H) {
    const mode = req.textMode;
    if (mode === 'none') return;
    const land = W > H;
    const ref = land ? H * 0.62 : W;
    const u = ref / 1290;
    const col = INK[req.style].text;
    const maxW = 0.60 * ref;
    const x = land ? 0.06 * W : W / 2;
    const align = land ? 'left' : 'center';
    const items = []; // { kind, lines, size, lh, alpha, gap, font }

    if (mode === 'poem+date' || mode === 'poem') {
      const own = typeof req.sentence === 'string' && req.sentence.trim() ? req.sentence.trim() : null;
      const poem = own ? { lines: [own], by: '' } : (isPoem(req.poem) ? req.poem : poemForPerson(req.person, 0, { pair: !!req.pair }).poem);
      const lines = (poem?.lines || []).filter(Boolean);
      if (lines.length) {
        const short = lines.length === 1 && charCount(lines[0]) <= 5;
        const serif = req.poemFont === 'serif' || (req.poemFont !== 'sans' && isIOS() && (songtiKnown ??= hasFont('Songti SC')));
        items.push({
          kind: 'poem', raw: lines, size: (short ? 0.0340 : 0.0290) * ref, min: 0.0250 * ref,
          lh: lines.length >= 3 ? 1.55 : 1.62, alpha: short ? 0.84 : 0.78, font: serif ? FONT_POEM_SERIF : FONT_TEXT,
        });
        const by = own ? '' : attribution(poem);
        if (by) items.push({ kind: 'attr', raw: [by], size: 0.0200 * ref, lh: 1.4, alpha: 0.40, gap: 10 * u, font: FONT_TEXT });
      }
    }
    if (mode === 'poem+date' || mode === 'date') {
      const p = req.person;
      let text;
      if (req.pair) text = `${fmtDot(req.pair.a)} ／ ${fmtDot(req.pair.b)}`;
      else {
        const who = req.guest ? nameOr(p, '') : '';
        text = `${who ? `${who} · ` : ''}${fmtDot(p)}　${p.city.name}`;
      }
      items.push({ kind: 'date', raw: [text], size: 0.0240 * ref, lh: 1.4, alpha: 0.46, gap: (items.length ? 18 : 0) * u, runs: true });
    }
    if (!items.length) return;

    const anchor = (land ? 0.905 : 0.852) * H; // the last baseline
    const nPoem = items.find((it) => it.kind === 'poem')?.raw.length || 0;
    const topLimit = (land ? 0.78 : nPoem >= 3 ? 0.74 : 0.77) * H;
    let layout;
    for (let pass = 0; pass < 8; pass++) {
      layout = [];
      let y = 0, prevBottom = null;
      for (const it of items) {
        let lines = it.raw;
        if (it.kind === 'poem') {
          ctx.font = `400 ${it.size}px ${it.font}`;
          lines = it.raw.flatMap((l) => wrapPhrase(ctx, l, maxW, 2));
        }
        for (let i = 0; i < lines.length; i++) {
          const asc = 0.86 * it.size, desc = 0.14 * it.size;
          const lead = ((it.lh - 1) * it.size) / 2;
          let base;
          if (prevBottom === null) base = asc;
          else if (i === 0) base = prevBottom + (it.gap ?? 0) + lead + asc;
          else base = layout[layout.length - 1].y + it.lh * it.size;
          layout.push({ it, text: lines[i], y: base });
          prevBottom = base + desc + lead;
        }
      }
      const shift = anchor - layout[layout.length - 1].y;
      const top = shift + layout[0].y - 0.86 * layout[0].it.size;
      for (const l of layout) l.y += shift;
      const poemIt = items.find((it) => it.kind === 'poem');
      if (top >= topLimit || !poemIt || poemIt.size <= poemIt.min + 0.01) break;
      poemIt.size = Math.max(poemIt.min, poemIt.size * 0.94);
    }
    for (const l of layout) {
      const { it } = l;
      const fill = rgba(col, it.alpha);
      const font = `400 ${it.size}px ${it.font}`;
      let lx = x;
      if (align === 'center' && it.kind === 'poem' && /[，。、；：！？,.;:!?]$/.test(l.text)) {
        // hanging punctuation: centre the characters, not the trailing comma or full stop
        ctx.font = font;
        lx += ctx.measureText(l.text.slice(-1)).width / 2;
      }
      if (it.runs) drawRuns(ctx, runsOf(l.text), lx, l.y, it.size, align, fill);
      else drawLine(ctx, l.text, lx, l.y, font, fill, align);
    }
  }

  /** 便签 (spec §6 B): text on the ground, left-aligned; QR at the bottom right. Positions for 1080 × 1440. */
  cardText(ctx, req) {
    const paper = req.style === 'paper';
    const P = paper
      ? { x: 64, l1: 1150, l2: 1198, l3: 1262, wm: 1392, qrR: 1016, qrB: 1392, cap: 1418 }
      : { x: 80, l1: 1112, l2: 1164, l3: 1236, wm: 1376, qrR: 1000, qrB: 1376, cap: 1404 };
    const col = INK[req.style].text;
    const p = req.person;
    const mode = req.textMode;
    let qr = null;

    if (mode !== 'none') {
      // L3 first: a long poem may need the group to move up a little
      let l3 = null, shift = 0;
      if (mode === 'full') {
        const s = this.cardSentence(req);
        if (isPoem(s) || (typeof s === 'string' && s.trim())) l3 = this.fitCardL3(ctx, s, P, paper);
        shift = l3?.shift || 0;
      }
      const y1 = P.l1 - shift, y2 = P.l2 - shift;
      // L1 「1998.07.14  22:00」 Cormorant Lining 52; unknown time 「1998.07.14  夜里」 with 夜里 in text 40
      const parts = T.export.cardDateParts(p);
      const runs = parts.time
        ? [{ t: `${parts.dot}  ${parts.time}`, num: true }]
        : [{ t: `${parts.dot}  `, num: true }, { t: parts.night, num: false, size: 40 }];
      drawRuns(ctx, runs, P.x, y1, 52, 'left', rgba(col, 0.94));
      drawLine(ctx, T.export.cardPlace(p), P.x, y2, `400 28px ${FONT_TEXT}`, rgba(col, 0.66));
      if (l3) {
        for (const l of l3.lines) drawLine(ctx, l.text, P.x, l.y - shift, `400 ${l.size}px ${FONT_TEXT}`, rgba(col, l.alpha));
      }
    }
    if (mode !== 'none' || req.qr) {
      drawLine(ctx, T.export.wordmark, P.x, P.wm, `400 22px ${FONT_DISPLAY}`, rgba(col, 0.50));
    }
    if (req.qr) {
      qr = drawQR(ctx, req.url, P.qrR, P.qrB, INK[req.style]);
      drawLine(ctx, T.export.qrCaption, qr.x + qr.size / 2, P.cap, `400 16px ${FONT_TEXT}`, rgba(col, 0.46), 'center');
    }
    return qr;
  }

  /**
   * L3 on a card: a sentence (30/46, α.90, max width 700, canvas no-widow breaker) or a poem (its lines,
   * then the attribution in small type; a 3–4 line poem is set as two lines of paired clauses, the way a
   * quatrain is usually printed). Two lines is the aim (spec); the default 光年之星 sentence already
   * carries its own line break (「织女星今晚的光，2001 年就动身了。\n又过了 …」), and a long sentence may
   * step down in size and take a third line rather than be cut short, and the whole text group may move up a little (≤ 44 px on the
   * night styles, ≤ 12 px on paper, where the printed window sits just above) so nothing reaches the
   * wordmark.
   */
  fitCardL3(ctx, s, P, paper) {
    const strictOk = (ls) => ls.slice(0, -1).every((l) => PHRASE_END.test(l)) || ls.length < 2;
    // whether phrase breaks are possible at all (a sentence with no commas is simply wrapped)
    ctx.font = `400 28px ${FONT_TEXT}`;
    const phraseable = !isPoem(s) && !!wrapPhraseStrict(ctx, s, 700, 3);
    const limit = P.wm - 22 - 26; // lowest descender above the wordmark
    const maxShift = paper ? 12 : 44;
    const configs = [[30, 46, 2], [28, 42, 2], [28, 42, 3], [26, 38, 3], [26, 36, 4]];
    let last = null;
    for (const [size, lh, max] of configs) {
      ctx.font = `400 ${size}px ${FONT_TEXT}`;
      let src, cut = false;
      if (isPoem(s)) {
        let ls = s.lines.filter(Boolean);
        if (ls.length > 2) {
          const paired = [];
          for (let i = 0; i < ls.length; i += 2) paired.push(ls[i] + (ls[i + 1] || ''));
          if (paired.every((l) => ctx.measureText(l).width <= 700)) ls = paired;
        }
        src = ls.flatMap((l) => wrapPhrase(ctx, l, 700, 2));
        cut = src.length > max;
      } else {
        src = wrapPhrase(ctx, s, 700, max);
        cut = src[src.length - 1].endsWith('…') && !String(s).trim().endsWith('…');
        // a break inside a phrase («出发／的») costs a line: prefer phrase breaks in up to max lines
        if (!cut && phraseable && !strictOk(src)) { const st = wrapPhraseStrict(ctx, s, 700, max); if (st) src = st; else cut = true; }
      }
      const lines = src.map((t, i) => ({ text: t, y: P.l3 + i * lh, size, alpha: 0.90 }));
      const by = isPoem(s) ? attribution(s) : '';
      if (by) lines.push({ text: by, y: lines[lines.length - 1].y + 0.14 * size + 15 + 0.86 * 20, size: 20, alpha: 0.46 });
      const over = lines[lines.length - 1].y + 0.14 * lines[lines.length - 1].size - limit;
      last = { lines, shift: clamp(Math.ceil(over), 0, maxShift) };
      if (!cut && over <= maxShift) return last;
    }
    return last;
  }

  /**
   * 两个人 card (spec §6 C): 「小明与小红」 500 34 · the count 30 α.90 · 牛郎织女 26 α.80 (only when true) ·
   * the two dates 22 α.50; wordmark bottom-left, QR to the result link bottom-right. No percentage.
   */
  pairCardText(ctx, req) {
    const paper = req.style === 'paper';
    // the dates line is anchored; the lines above it stack upward, so the group always sits with the
    // wordmark and the QR however many lines there are
    const P = paper
      ? { x: 64, dates: 1270, wm: 1392, qrR: 1016, qrB: 1392, cap: 1418 }
      : { x: 80, dates: 1250, wm: 1376, qrR: 1000, qrB: 1376, cap: 1404 };
    const col = INK[req.style].text;
    const r = req.pair;
    let qr = null;
    if (req.textMode !== 'none') {
      const rows = [{ text: T.export.pairTitle(r.nameA, r.nameB), font: `500 34px ${FONT_TEXT}`, alpha: 0.94, gap: 58 }];
      if (req.textMode === 'full') {
        ctx.font = `400 30px ${FONT_TEXT}`;
        const count = wrapPhrase(ctx, T.export.pairCount(r.both), 700, 2);
        count.forEach((t, i) => rows.push({ text: t, font: `400 30px ${FONT_TEXT}`, alpha: 0.90, gap: i ? 44 : 56 }));
        if (r.vegaAltair === 'both') rows.push({ text: T.export.pairVegaAltair, font: `400 26px ${FONT_TEXT}`, alpha: 0.80, gap: 48 });
      }
      rows.push({ text: T.export.pairDates(r.a, r.b), runs: true, alpha: 0.50, gap: rows.length > 1 ? 52 : 56 });
      let y = P.dates;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.runs) drawRuns(ctx, runsOf(row.text), P.x, y, 22, 'left', rgba(col, row.alpha));
        else drawLine(ctx, row.text, P.x, y, row.font, rgba(col, row.alpha));
        y -= row.gap;
      }
    }
    if (req.textMode !== 'none' || req.qr) {
      drawLine(ctx, T.export.wordmark, P.x, P.wm, `400 22px ${FONT_DISPLAY}`, rgba(col, 0.50));
    }
    if (req.qr) {
      qr = drawQR(ctx, req.url, P.qrR, P.qrB, INK[req.style]);
      drawLine(ctx, T.export.qrCaption, qr.x + qr.size / 2, P.cap, `400 16px ${FONT_TEXT}`, rgba(col, 0.46), 'center');
    }
    return qr;
  }
}

// ---------------------------------------------------------------- fonts
let fontsPromise = null;
/**
 * Nawan Serif (the wordmark) and Cormorant Lining (the date digits), awaited before any text is drawn.
 * main.css declares both faces; when a page has not (yet), they are registered here from assets/fonts.
 */
function loadFonts() {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    const fonts = typeof document !== 'undefined' ? document.fonts : null;
    if (!fonts?.load) return;
    const have = (fam) => { try { return [...fonts].some((f) => f.family.replace(/["']/g, '') === fam); } catch { return true; } };
    const add = (fam, file, weight) => {
      if (have(fam) || typeof FontFace === 'undefined') return;
      try { fonts.add(new FontFace(fam, `url(${new URL(`assets/fonts/${file}`, document.baseURI)}) format("woff2")`, { weight })); } catch { /* keep the fallback */ }
    };
    add('Nawan Serif', 'nawan-serif-400.woff2', '400');
    add('Cormorant Lining', 'cormorant-lining-500.woff2', '500');
    try {
      await Promise.race([
        Promise.all([fonts.load('400 24px "Nawan Serif"', '你来的那晚'), fonts.load('500 24px "Cormorant Lining"', '0123456789.:')]),
        sleep(4000),
      ]);
    } catch { /* system fallbacks */ }
  })();
  return fontsPromise;
}

// ---------------------------------------------------------------- blur
/** In-place separable box blur of radius r (two passes ≈ a Gaussian of σ ≈ 1.6r). */
function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(Math.max(w, h));
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += a[o + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[x] = s * k;
      s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
    }
    a.set(tmp.subarray(0, w), o);
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += a[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = s * k;
      s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) a[y * w + x] = tmp[y];
  }
}
