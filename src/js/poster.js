// Poster studio: renders a print-quality star map (its own WebGL context) and lays out the
// share poster — single sky or 合盘 — with a QR code back to the site. Free, full resolution.
import qrcode from 'qrcode-generator';
import { SkyRenderer } from './renderer.js';
import { Overlay, drawMoon, FONT_SERIF, FONT_SANS, FONT_LATIN } from './overlay.js';
import { Camera } from './camera.js';
import { lunarDate, DEG } from './astro.js';
import { mulberry32 } from './catalog.js';

const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export const POSTER_STYLES = [
  { id: 'night', name: '夜空', swatch: '#0d1530', bg: ['#0c1430', '#03050d'], glow: [60, 80, 150], text: [243, 236, 220], muted: [243, 236, 220, 0.62],
    accent: [226, 199, 150], line: [226, 199, 150], sky: 'color', qrDark: [10, 16, 38], qrLight: [239, 231, 214] },
  { id: 'paper', name: '宣纸', swatch: '#efe6d4', paper: [240, 232, 216], text: [34, 38, 52], muted: [34, 38, 52, 0.62],
    accent: [168, 50, 40], line: [38, 46, 74], sky: 'ink', ink: [24, 30, 52], qrDark: [24, 30, 52], qrLight: [240, 232, 216] },
  { id: 'ink', name: '墨', swatch: '#050505', bg: ['#0a0a0a', '#000000'], glow: [40, 40, 40], text: [236, 236, 236], muted: [236, 236, 236, 0.58],
    accent: [236, 236, 236], line: [220, 220, 220], sky: 'mono', qrDark: [0, 0, 0], qrLight: [236, 236, 236] },
  { id: 'dusk', name: '暮光', swatch: '#4a2f5c', bg: ['#2a1f4a', '#0c0a1c'], glow: [150, 80, 120], text: [248, 234, 230], muted: [248, 234, 230, 0.62],
    accent: [240, 184, 170], line: [240, 196, 184], sky: 'color', qrDark: [30, 22, 52], qrLight: [248, 236, 230] },
];
const byId = Object.fromEntries(POSTER_STYLES.map((s) => [s.id, s]));

function spacedText(ctx, text, x, y, spacing, align = 'center') {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + spacing; });
  ctx.textAlign = prev;
  return total;
}

function fitFont(ctx, text, family, weight, maxSize, maxWidth, spacingEm = 0) {
  let size = maxSize;
  for (; size > 18; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    const w = ctx.measureText(text).width + spacingEm * size * ([...text].length - 1);
    if (w <= maxWidth) break;
  }
  return size;
}

function paperTexture(ctx, W, H, base, seed = 5) {
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, W, H);
  const rnd = mulberry32(seed);
  // fibres
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * W, y = rnd() * H, len = 6 + rnd() * 26, a = rnd() * Math.PI;
    ctx.strokeStyle = `rgba(120,100,70,${0.025 + rnd() * 0.04})`;
    ctx.lineWidth = 0.6 + rnd();
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
  }
  const g = ctx.createRadialGradient(W / 2, H * 0.45, W * 0.3, W / 2, H * 0.5, W * 0.95);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(110,90,60,0.16)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function darkBackground(ctx, W, H, st, glowAt) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, st.bg[0]);
  g.addColorStop(1, st.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const [x, y, r] of glowAt) {
    const rg = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 1.2);
    rg.addColorStop(0, rgb(st.glow, 0.22));
    rg.addColorStop(1, rgb(st.glow, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
  // a sprinkle of tiny margin stars so the page feels like night, not a frame
  const rnd = mulberry32(9);
  for (let i = 0; i < 420; i++) {
    const x = rnd() * W, y = rnd() * H, s = rnd();
    ctx.fillStyle = `rgba(255,250,240,${0.06 + s * 0.22})`;
    ctx.beginPath(); ctx.arc(x, y, 0.6 + s * s * 1.6, 0, Math.PI * 2); ctx.fill();
  }
  // film grain
  const n = document.createElement('canvas');
  n.width = n.height = 256;
  const nc = n.getContext('2d'), id = nc.createImageData(256, 256), r2 = mulberry32(21);
  for (let i = 0; i < id.data.length; i += 4) { const v = r2() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 10; }
  nc.putImageData(id, 0, 0);
  ctx.fillStyle = ctx.createPattern(n, 'repeat');
  ctx.fillRect(0, 0, W, H);
}

function drawQR(ctx, url, x, y, size, st) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3, cell = size / (n + quiet * 2);
  ctx.fillStyle = rgb(st.qrLight);
  roundRect(ctx, x, y, size, size, size * 0.06);
  ctx.fill();
  ctx.fillStyle = rgb(st.qrDark);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(Math.floor(x + (c + quiet) * cell), Math.floor(y + (r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function seal(ctx, text, x, y, size, color) {
  const chars = [...(text || '星空')].slice(0, 4);
  while (chars.length < 2) chars.push('印');
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.04);
  ctx.fillStyle = rgb(color);
  roundRect(ctx, -size / 2, -size / 2, size, size, size * 0.08);
  ctx.fill();
  ctx.fillStyle = '#f7efe2';
  const grid = chars.length <= 2 ? [[0, -0.2], [0, 0.22]] : [[0.21, -0.2], [0.21, 0.22], [-0.21, -0.2], [-0.21, 0.22]];
  const fs = chars.length <= 2 ? size * 0.36 : size * 0.34;
  ctx.font = `600 ${fs}px ${FONT_SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  chars.forEach((c, i) => ctx.fillText(c, grid[i][0] * size, grid[i][1] * size));
  // worn stone edges
  ctx.globalCompositeOperation = 'destination-out';
  const rnd = mulberry32(text.length * 31 + 7);
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.3 + rnd() * 0.6})`;
    ctx.beginPath();
    ctx.arc((rnd() - 0.5) * size * 1.02, (rnd() - 0.5) * size * 1.02, rnd() * size * 0.018, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export class PosterStudio {
  constructor(catalog) {
    this.catalog = catalog;
    this.glCanvas = document.createElement('canvas');
    this.renderer = null;
    this.overlay = new Overlay(document.createElement('canvas'), catalog);
    this.cam = new Camera();
  }

  async fonts() {
    if (!document.fonts?.load) return;
    try {
      await Promise.all([
        document.fonts.load(`500 40px "Cormorant Garamond"`),
        document.fonts.load(`italic 400 40px "Cormorant Garamond"`),
      ]);
    } catch { /* fall back to system serif */ }
  }

  /** A square star map (transparent outside the horizon circle). */
  dome(sky, size, styleId = 'night', { culture = 'iau', lines = true, labels = true, names = true } = {}) {
    const st = byId[styleId] || POSTER_STYLES[0];
    if (!this.renderer) this.renderer = new SkyRenderer(this.glCanvas, this.catalog, { preserve: true });
    const R = size / 2 - 2;
    const cam = this.cam;
    cam.cx = size / 2; cam.cy = size / 2; cam.domeR = R; cam.alt = 90; cam.az = 180; cam.zoom = 1;
    cam.update();
    this.renderer.resize(size, size, 1);
    const sunAlt = sky.sun.alt;
    const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    this.renderer.render({
      cam, M: sky.M, time: 0, sun: sky.sun.n, moon: sky.moon.n, moonIllum: sky.moonPhase.illum * (sky.moon.alt > -2 ? 1 : 0),
      twilight: st.sky === 'color' ? sm(-18, -2, sunAlt) * 0.7 : 0, day: st.sky === 'color' ? sm(-3, 10, sunAlt) * 0.35 : 0,
      // ink on paper wants the stars as firm printed dots: larger cores, more of them saturated
      reveal: 6.8, mwAmt: st.sky === 'ink' ? 1.1 : 1.08, starGain: st.sky === 'ink' ? 1.8 : 1.3, dustGain: st.sky === 'ink' ? 0.5 : 1.0,
      sizeGain: st.sky === 'ink' ? Math.max(1, size / 300) : Math.max(1, size / 430),
      crisp: 1, flash: 0, sweep: 0, sweepOn: 0, sel: -1, twinkle: 0, terrainH: 0, bg: [0, 0, 0], dome: 1,
      exposure: 1.08, grain: 0, vignette: 0, trail: null,
    });
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const ctx = out.getContext('2d', { willReadFrequently: st.sky !== 'color' });
    ctx.drawImage(this.glCanvas, 0, 0);
    if (st.sky !== 'color') {
      const img = ctx.getImageData(0, 0, size, size), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const l0 = (0.3 * d[i] + 0.55 * d[i + 1] + 0.15 * d[i + 2]) / 255;
        const l = Math.min(1, Math.max(0, l0 - 0.06) / 0.94 * 1.25);
        if (st.sky === 'ink') {
          const a = Math.min(1, Math.pow(l, 0.95) * 1.3);
          d[i] = st.paper[0] + (st.ink[0] - st.paper[0]) * a;
          d[i + 1] = st.paper[1] + (st.ink[1] - st.paper[1]) * a;
          d[i + 2] = st.paper[2] + (st.ink[2] - st.paper[2]) * a;
        } else {
          const v = Math.min(255, l * 255);
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    // vector layer
    this.overlay.culture = culture;
    const unit = size / 420;
    const theme = { line: st.line, text: st.line, label: st.text };
    const moonStyle = st.sky === 'ink'
      ? { light: rgb(st.ink), light2: rgb(st.ink), dark: rgb(st.ink, 0.12), maria: 'rgba(240,232,216,0.16)', glow: 0 }
      : undefined;
    this.overlay.w = size; this.overlay.h = size;
    this.overlay.draw({
      cam, M: sky.M, sky, poster: true, moonStyle,
      vis: { lines: lines ? 1 : 0, linesProgress: 1, labels: labels ? 1 : 0, names: names ? 1 : 0, ring: 0, bodies: 1, bodyLabels: 1, sweepOn: 0 },
      sel: null,
    }, ctx, { unit, theme });
    // clip to the horizon circle
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath(); ctx.arc(size / 2, size / 2, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    return out;
  }

  ring(ctx, cx, cy, R, st, { labels = true, scale = 1 } = {}) {
    ctx.save();
    ctx.strokeStyle = rgb(st.line, 0.55);
    ctx.lineWidth = 2 * scale;
    ctx.beginPath(); ctx.arc(cx, cy, R + 5 * scale, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgb(st.line, 0.25);
    ctx.lineWidth = 1.2 * scale;
    ctx.beginPath(); ctx.arc(cx, cy, R + 26 * scale, 0, Math.PI * 2); ctx.stroke();
    for (let d = 0; d < 360; d += 2) {
      const a = -Math.PI / 2 - d * DEG; // north up, east to the left
      const long = d % 90 === 0 ? 16 : d % 10 === 0 ? 10 : 5;
      ctx.strokeStyle = rgb(st.line, d % 10 === 0 ? 0.6 : 0.3);
      ctx.lineWidth = (d % 10 === 0 ? 1.6 : 1) * scale;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (R + 5 * scale), cy + Math.sin(a) * (R + 5 * scale));
      ctx.lineTo(cx + Math.cos(a) * (R + (5 + long) * scale), cy + Math.sin(a) * (R + (5 + long) * scale));
      ctx.stroke();
    }
    if (labels) {
      ctx.fillStyle = rgb(st.text, 0.9);
      ctx.font = `${30 * scale}px ${FONT_SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const [d, t] of [[0, '北'], [90, '东'], [180, '南'], [270, '西']]) {
        const a = -Math.PI / 2 - d * DEG;
        ctx.fillText(t, cx + Math.cos(a) * (R + 50 * scale), cy + Math.sin(a) * (R + 50 * scale));
      }
    }
    ctx.restore();
  }

  background(ctx, W, H, st, glowAt) {
    if (st.paper) paperTexture(ctx, W, H, st.paper);
    else darkBackground(ctx, W, H, st, glowAt);
  }

  async single({ person, sky, facts, style = 'night', texts = {}, url, culture = 'iau' }) {
    await this.fonts();
    const st = byId[style] || POSTER_STYLES[0];
    const W = 1440, H = 1920;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const D = 1040, cx = W / 2, cy = 110 + D / 2, R = D / 2 - 2;
    this.background(ctx, W, H, st, [[cx, cy, D * 0.62]]);
    const dome = this.dome(sky, D, style, { culture });
    ctx.drawImage(dome, cx - D / 2, cy - D / 2);
    this.ring(ctx, cx, cy, R, st);

    const [y, m, d] = person.date.split('-').map(Number);
    let ty = cy + R + 142;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgb(st.accent, 0.95);
    ctx.font = `italic 400 34px ${FONT_LATIN}`;
    spacedText(ctx, 'THE NIGHT YOU ARRIVED', cx, ty, 9);
    ty += 88;
    const title = texts.title || '你出生那晚的星空';
    const ts = fitFont(ctx, title, FONT_SERIF, 500, 70, W - 260, 0.14);
    ctx.font = `500 ${ts}px ${FONT_SERIF}`;
    ctx.fillStyle = rgb(st.text);
    spacedText(ctx, title, cx, ty, ts * 0.14);
    ty += 66;
    ctx.font = `500 40px ${FONT_LATIN}`;
    ctx.fillStyle = rgb(st.text, 0.82);
    const when = `${y} 年 ${m} 月 ${d} 日  ${person.unknownTime ? '' : person.time}`.trim();
    spacedText(ctx, `${when}  ·  ${person.city.name}`, cx, ty, 2);
    ty += 50;
    const lunar = lunarDate(new Date(sky.date), person.city.tz);
    const coord = `${Math.abs(person.city.lat).toFixed(2)}°${person.city.lat >= 0 ? 'N' : 'S'}  ${Math.abs(person.city.lon).toFixed(2)}°${person.city.lon >= 0 ? 'E' : 'W'}`;
    ctx.font = `400 29px ${FONT_LATIN}`;
    ctx.fillStyle = rgb(st.muted, st.muted[3]);
    spacedText(ctx, [coord, lunar?.text, sky.moonPhase.name].filter(Boolean).join('  ·  '), cx, ty, 1.5);
    if (texts.line) {
      ty += 76;
      const ls = fitFont(ctx, texts.line, FONT_SERIF, 400, 38, W - 300, 0.12);
      ctx.font = `400 ${ls}px ${FONT_SERIF}`;
      ctx.fillStyle = rgb(st.accent);
      spacedText(ctx, texts.line, cx, ty, ls * 0.12);
    }
    if (st.paper) seal(ctx, person.name || '星辰', W - 150, cy + R + 150, 104, st.accent);
    this.footer(ctx, W, H, st, url, '扫码，看看你出生那晚的星空');
    return c;
  }

  footer(ctx, W, H, st, url, cta) {
    const q = 176, qx = W - 110 - q, qy = H - 64 - q;
    drawQR(ctx, url, qx, qy, q, st);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgb(st.text, 0.92);
    ctx.font = `500 38px ${FONT_SERIF}`;
    spacedText(ctx, '你来的那晚', 110, qy + 70, 12, 'left');
    ctx.fillStyle = rgb(st.muted, st.muted[3]);
    ctx.font = `400 26px ${FONT_SANS}`;
    spacedText(ctx, cta, 110, qy + 122, 3, 'left');
    ctx.strokeStyle = rgb(st.line, 0.25);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(110, qy - 34); ctx.lineTo(W - 110, qy - 34); ctx.stroke();
  }

  async hepan(result, { style = 'night', texts = {}, url }) {
    await this.fonts();
    const st = byId[style] || POSTER_STYLES[0];
    const W = 1440, H = 1920;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const D = 840, R = D / 2 - 2, off = 262, cy = 150 + D / 2;
    const ax = W / 2 - off, bx = W / 2 + off;
    this.background(ctx, W, H, st, [[W / 2, cy, D * 0.9]]);
    const da = this.dome(result.sa, D, style, { labels: false, names: false });
    const db = this.dome(result.sb, D, style, { labels: false, names: false });
    ctx.drawImage(da, ax - D / 2, cy - D / 2);
    ctx.save();
    ctx.globalCompositeOperation = st.paper ? 'multiply' : 'screen';
    ctx.drawImage(db, bx - D / 2, cy - D / 2);
    ctx.restore();
    // glow the lens where the two skies overlap
    ctx.save();
    ctx.beginPath(); ctx.arc(ax, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.beginPath(); ctx.arc(bx, cy, R, 0, Math.PI * 2); ctx.clip();
    const lg = ctx.createRadialGradient(W / 2, cy, 10, W / 2, cy, R);
    lg.addColorStop(0, rgb(st.accent, st.paper ? 0.1 : 0.16));
    lg.addColorStop(1, rgb(st.accent, 0));
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    this.ring(ctx, ax, cy, R, st, { labels: false, scale: 0.8 });
    this.ring(ctx, bx, cy, R, st, { labels: false, scale: 0.8 });

    const { a, b } = result;
    ctx.fillStyle = rgb(st.text, 0.9);
    ctx.font = `500 34px ${FONT_SERIF}`;
    ctx.textBaseline = 'alphabetic';
    const fmt = (p) => `${p.date.replace(/-/g, '.')} · ${p.city.name}`;
    spacedText(ctx, a.name || '我', ax - 90, cy + R + 86, 6);
    spacedText(ctx, b.name || 'TA', bx + 90, cy + R + 86, 6);
    ctx.font = `400 26px ${FONT_LATIN}`;
    ctx.fillStyle = rgb(st.muted, st.muted[3]);
    spacedText(ctx, fmt(a), ax - 90, cy + R + 128, 1);
    spacedText(ctx, fmt(b), bx + 90, cy + R + 128, 1);

    let ty = cy + R + 332;
    ctx.fillStyle = rgb(st.accent);
    ctx.font = `400 30px ${FONT_SERIF}`;
    spacedText(ctx, '星 空 重 合 度', W / 2, cy + R + 212, 10);
    ctx.font = `500 150px ${FONT_LATIN}`;
    ctx.fillStyle = rgb(st.text);
    const sw = spacedText(ctx, String(result.score), W / 2 - 30, ty + 30, 0);
    ctx.font = `500 64px ${FONT_LATIN}`;
    ctx.fillStyle = rgb(st.accent);
    ctx.textAlign = 'left';
    ctx.fillText('%', W / 2 - 30 + sw / 2 + 8, ty + 30);
    ty += 150;
    const line = texts.line || result.keyword;
    const ls = fitFont(ctx, line, FONT_SERIF, 400, 42, W - 280, 0.12);
    ctx.font = `400 ${ls}px ${FONT_SERIF}`;
    ctx.fillStyle = rgb(st.text, 0.92);
    spacedText(ctx, line, W / 2, ty, ls * 0.12);
    if (texts.title) {
      ty += 60;
      ctx.font = `400 30px ${FONT_SERIF}`;
      ctx.fillStyle = rgb(st.muted, st.muted[3]);
      spacedText(ctx, texts.title, W / 2, ty, 4);
    }
    if (st.paper) seal(ctx, '合盘', W - 160, 150, 96, st.accent);
    this.footer(ctx, W, H, st, url, '扫码，和 TA 合一下星空');
    return c;
  }
}
