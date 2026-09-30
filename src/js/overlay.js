// Crisp vector layer drawn over the WebGL sky: constellations, names, horizon ring, Moon & planets,
// selection, the "listen" sweep and note ripples. Shared by the live view and the poster renderer.
import { mul, DEG } from './astro.js';

const TAU = Math.PI * 2;
const GOLD = [222, 196, 148];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export const FONT_SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", "Noto Serif CJK SC", serif';
export const FONT_SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif';
export const FONT_LATIN = '"Cormorant Garamond", "Times New Roman", serif';

/** Moon disc with the correct phase, bright limb turned toward the Sun (angle in screen radians). */
export function drawMoon(ctx, x, y, r, illum, limbAngle, opts = {}) {
  const glow = opts.glow ?? 1;
  ctx.save();
  if (glow > 0) {
    const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 5);
    g.addColorStop(0, `rgba(235,236,230,${0.22 * glow * (0.3 + illum)})`);
    g.addColorStop(1, 'rgba(235,236,230,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 5, 0, TAU); ctx.fill();
  }
  ctx.translate(x, y);
  ctx.rotate(limbAngle);
  // earthshine on the dark side
  ctx.fillStyle = opts.dark || 'rgba(120,130,150,0.22)';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  // lit part: half disc on the +x side joined to a half ellipse for the terminator
  const e = r * (1 - 2 * illum);
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.abs(e), r, 0, Math.PI / 2, -Math.PI / 2, e < 0);
  ctx.closePath();
  const lit = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r * 1.05);
  lit.addColorStop(0, opts.light || '#fbf8ef');
  lit.addColorStop(1, opts.light2 || '#d9d4c6');
  ctx.fillStyle = lit;
  ctx.fill();
  // a few soft maria so it reads as the Moon, not a coin
  ctx.globalCompositeOperation = 'source-atop';
  ctx.rotate(-limbAngle);
  ctx.fillStyle = opts.maria || 'rgba(120,120,125,0.18)';
  for (const [mx, my, mr] of [[-0.25, -0.3, 0.32], [0.18, -0.1, 0.26], [0.05, 0.3, 0.22], [-0.35, 0.15, 0.18], [0.35, 0.28, 0.14]]) {
    ctx.beginPath(); ctx.arc(mx * r, my * r, mr * r, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

export class Overlay {
  constructor(canvas, catalog) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.catalog = catalog;
    this.dpr = 1; this.w = 1; this.h = 1;
    this.ripples = [];
    this.culture = 'iau';
    this.tmp = [0, 0, 0];
    this.pt = {};
    // stable per-constellation reveal order
    const order = (arr) => new Map(arr.map(([id], i) => [id, ((i * 0.61803398875) % 1)]));
    this.order = { iau: order(catalog.iau.lines), cn: order(catalog.cn.lines) };
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
  }

  addRipple(x, y, color = GOLD, size = 1) {
    this.ripples.push({ x, y, t0: performance.now(), color, size });
    if (this.ripples.length > 40) this.ripples.shift();
  }

  /**
   * @param s  frame state: cam, M, sky (skyState), vis {lines, labels, names, ring, bodies, sweepOn, sweep},
   *           sel {type, index|id}, lightStar index, time
   * @param ctx optional external context (poster), with its own scale already applied
   */
  draw(s, ctx = null, opts = {}) {
    const own = !ctx;
    ctx = ctx || this.ctx;
    const { cam, M, vis } = s;
    if (own) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
    }
    const unit = opts.unit || 1;              // poster scale multiplier for line widths & fonts
    const theme = opts.theme || { line: GOLD, text: GOLD, label: [236, 226, 206] };
    const dome = cam.alt > 89;
    const hz = cam.horizonCircle();

    ctx.save();
    if (hz) { // everything celestial is clipped to the sky
      ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.r, 0, TAU); ctx.clip();
    }
    if (vis.lines > 0.001) this.drawLines(ctx, s, unit, theme);
    if (vis.sweepOn > 0.001 && hz) this.drawSweep(ctx, s, hz, unit);
    if (vis.labels > 0.001) this.drawConstellationNames(ctx, s, unit, theme);
    if (vis.names > 0.001) this.drawStarNames(ctx, s, unit, theme);
    if (vis.bodies > 0.001) this.drawBodies(ctx, s, unit, theme);
    if (s.sel) this.drawSelection(ctx, s, unit);
    this.drawRipples(ctx, s);
    ctx.restore();

    if (vis.ring > 0.001 && hz) this.drawRing(ctx, s, hz, dome, unit, theme);
  }

  // -------------------------------------------------------------- constellation lines
  drawLines(ctx, s, unit, theme) {
    const { cam, M, vis } = s;
    const set = this.culture === 'cn' ? this.catalog.cn : this.catalog.iau;
    const order = this.order[this.culture];
    const gap = 3.2 * unit, p = this.pt, q = {}, n = this.tmp, m = [0, 0, 0];
    const prog = vis.linesProgress ?? 1;
    ctx.lineWidth = (this.culture === 'cn' ? 0.8 : 0.9) * unit;
    ctx.lineCap = 'round';
    for (const [id, polys] of set.lines) {
      const local = Math.max(0, Math.min(1, (prog - order.get(id) * 0.55) / 0.45));
      if (local <= 0) continue;
      for (const poly of polys) {
        const count = poly.length / 3;
        const lim = local >= 1 ? count - 1 : (count - 1) * local;
        for (let i = 0; i < count - 1 && i < lim; i++) {
          mul(M, [poly[i * 3], poly[i * 3 + 1], poly[i * 3 + 2]], n);
          mul(M, [poly[i * 3 + 3], poly[i * 3 + 4], poly[i * 3 + 5]], m);
          if (n[2] < -0.02 && m[2] < -0.02) continue;
          if (!cam.project(n, p) || !cam.project(m, q)) continue;
          let dx = q.x - p.x, dy = q.y - p.y;
          const len = Math.hypot(dx, dy);
          if (len < gap * 2.4 || len > cam.scale * 3) continue;
          dx /= len; dy /= len;
          const frac = Math.min(1, lim - i);
          const x0 = p.x + dx * gap, y0 = p.y + dy * gap;
          const x1 = p.x + dx * (gap + (len - 2 * gap) * frac), y1 = p.y + dy * (gap + (len - 2 * gap) * frac);
          const low = Math.min(n[2], m[2]);
          const a = vis.lines * (this.culture === 'cn' ? 0.42 : 0.5) * Math.min(1, Math.max(0, (low + 0.02) * 9));
          ctx.strokeStyle = rgba(theme.line, a);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      }
    }
  }

  drawConstellationNames(ctx, s, unit, theme) {
    const { cam, M, vis } = s;
    const set = this.culture === 'cn' ? this.catalog.cn : this.catalog.iau;
    const p = this.pt, n = this.tmp;
    const zoom = cam.zoom;
    const maxRank = this.culture === 'cn' ? (zoom > 2.2 ? 3 : zoom > 1.4 ? 2 : 1) : (zoom > 1.6 ? 3 : 2);
    const size = (this.culture === 'cn' ? 10.5 : 11) * unit;
    ctx.font = `${size}px ${FONT_SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const boxes = this.boxes = [];
    for (const l of set.labels) {
      if (l.rank > maxRank) continue;
      mul(M, l.v, n);
      if (n[2] < 0.06) continue;
      if (!cam.project(n, p)) continue;
      if (p.x < -40 || p.y < -40 || p.x > this.w + 40 || p.y > this.h + 40) if (!s.poster) continue;
      const text = spaced(l.zh);
      const w = ctx.measureText(text).width, h = size * 1.3;
      const box = [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
      if (boxes.some((b) => overlap(b, box))) continue;
      boxes.push(box);
      ctx.fillStyle = rgba(theme.text, vis.labels * 0.62 * Math.min(1, (n[2] - 0.06) * 8));
      ctx.fillText(text, p.x, p.y);
    }
  }

  drawStarNames(ctx, s, unit, theme) {
    const { cam, M, vis } = s;
    const p = this.pt, n = this.tmp;
    const limit = cam.zoom > 2.5 ? 2.6 : cam.zoom > 1.5 ? 1.9 : (s.poster ? 1.2 : 1.35);
    const size = 10 * unit;
    ctx.font = `${size}px ${FONT_SANS}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const boxes = this.boxes || [];
    const pos = this.catalog.stars.pos;
    for (const [i, info] of this.catalog.names) {
      if (info.mag > limit) break; // names are inserted brightest first
      mul(M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], n);
      if (n[2] < 0.05) continue;
      if (!cam.project(n, p)) continue;
      const text = info.zh;
      const w = ctx.measureText(text).width, x = p.x + 7 * unit, y = p.y + 1;
      const box = [x - 2, y - size * 0.7, x + w + 2, y + size * 0.7];
      if (boxes.some((b) => overlap(b, box))) continue;
      boxes.push(box);
      ctx.fillStyle = rgba(theme.label, vis.names * 0.8 * Math.min(1, (n[2] - 0.05) * 8));
      ctx.fillText(text, x, y);
    }
  }

  drawBodies(ctx, s, unit, theme) {
    const { cam, sky, vis } = s;
    const p = this.pt;
    const R = cam.scale * 2;
    for (const b of sky.bodies) {
      if (b.alt < -0.5) continue;
      if (!cam.project(b.n, p)) continue;
      const a = vis.bodies * Math.min(1, (b.alt + 0.5) / 2);
      if (b.id === 'Moon') {
        const r = Math.max(8 * unit, R * 0.028) * (s.poster ? 1 : Math.min(1.8, Math.sqrt(cam.zoom)));
        const ang = limbAngle(cam, b.n, sky.sun.n);
        ctx.globalAlpha = a;
        drawMoon(ctx, p.x, p.y, r, sky.moonPhase.illum, ang, s.moonStyle);
        ctx.globalAlpha = 1;
        if (vis.bodyLabels) label(ctx, '月亮', p.x, p.y + r + 10 * unit, unit, rgba(theme.label, a * 0.8));
      } else if (b.id === 'Sun') {
        const r = Math.max(7 * unit, R * 0.022);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 6);
        g.addColorStop(0, `rgba(255,236,200,${a})`);
        g.addColorStop(0.18, `rgba(255,210,150,${a * 0.6})`);
        g.addColorStop(1, 'rgba(255,190,120,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 6, 0, TAU); ctx.fill();
        if (vis.bodyLabels) label(ctx, '太阳', p.x, p.y + r + 12 * unit, unit, rgba(theme.label, a * 0.85));
      } else {
        const bright = Math.max(0.35, Math.min(1, (2.5 - b.mag) / 4));
        const r = (2.2 + 2.2 * bright) * unit * (s.poster ? 1 : 1);
        const c = b.color.map((x) => Math.round(x * 255));
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
        g.addColorStop(0, rgba(c, a));
        g.addColorStop(0.3, rgba(c, a * 0.5));
        g.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 4, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba([255, 252, 240], a);
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.55, 0, TAU); ctx.fill();
        if (vis.bodyLabels) label(ctx, b.zh, p.x, p.y + r * 2 + 9 * unit, unit, rgba(c, a * 0.9));
      }
    }
  }

  drawSelection(ctx, s, unit) {
    const p = this.selectionPoint(s);
    if (!p) return;
    const t = (performance.now() % 2400) / 2400;
    ctx.strokeStyle = rgba(GOLD, 0.85);
    ctx.lineWidth = 1 * unit;
    ctx.beginPath(); ctx.arc(p.x, p.y, 12 * unit, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba(GOLD, 0.5 * (1 - t));
    ctx.beginPath(); ctx.arc(p.x, p.y, (12 + 14 * t) * unit, 0, TAU); ctx.stroke();
  }

  selectionPoint(s) {
    const sel = s.sel;
    if (!sel) return null;
    let n;
    if (sel.type === 'star') {
      const pos = this.catalog.stars.pos, i = sel.index;
      n = mul(s.M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    } else if (sel.type === 'body') {
      n = s.sky.bodies.find((b) => b.id === sel.id)?.n;
    }
    if (!n || n[2] < -0.05) return null;
    return s.cam.project(n, {});
  }

  drawSweep(ctx, s, hz, unit) {
    const { cam, vis } = s;
    const zen = cam.project([0, 0, 1], {});
    if (!zen) return;
    const a = vis.sweepOn;
    const edge = (az) => cam.project([Math.cos(az), Math.sin(az), 0.0], {});
    const head = edge(vis.sweep);
    if (!head) return;
    // trailing wedge
    const steps = 18, span = 32 * DEG;
    for (let i = 0; i < steps; i++) {
      const a0 = vis.sweep + (i / steps) * span, a1 = vis.sweep + ((i + 1) / steps) * span;
      const p0 = edge(a0), p1 = edge(a1);
      if (!p0 || !p1) continue;
      ctx.fillStyle = `rgba(232,206,150,${(0.085 * a * Math.pow(1 - i / steps, 2)).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(zen.x, zen.y); ctx.lineTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.closePath(); ctx.fill();
    }
    const g = ctx.createLinearGradient(zen.x, zen.y, head.x, head.y);
    g.addColorStop(0, `rgba(255,236,200,${0.1 * a})`);
    g.addColorStop(1, `rgba(255,226,170,${0.75 * a})`);
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.2 * unit;
    ctx.beginPath(); ctx.moveTo(zen.x, zen.y); ctx.lineTo(head.x, head.y); ctx.stroke();
  }

  drawRipples(ctx) {
    const now = performance.now();
    this.ripples = this.ripples.filter((r) => now - r.t0 < 1600);
    for (const r of this.ripples) {
      const t = (now - r.t0) / 1600;
      ctx.strokeStyle = rgba(r.color, 0.7 * Math.pow(1 - t, 2));
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, (4 + 26 * ease(t)) * r.size, 0, TAU); ctx.stroke();
    }
  }

  drawRing(ctx, s, hz, dome, unit, theme) {
    const { cam, vis } = s;
    const a = vis.ring;
    if (dome) {
      ctx.strokeStyle = rgba(theme.line, 0.38 * a);
      ctx.lineWidth = 1 * unit;
      ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.r + 1.5 * unit, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(theme.line, 0.16 * a);
      ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.r + 9 * unit, 0, TAU); ctx.stroke();
      // ticks every 5°, longer every 15°
      for (let d = 0; d < 360; d += 5) {
        const p = cam.project([Math.cos(d * DEG), Math.sin(d * DEG), 0], {});
        if (!p) continue;
        const dx = (p.x - hz.x) / hz.r, dy = (p.y - hz.y) / hz.r;
        const len = (d % 90 === 0 ? 7 : d % 15 === 0 ? 4.5 : 2.2) * unit;
        ctx.strokeStyle = rgba(theme.line, (d % 15 === 0 ? 0.5 : 0.28) * a);
        ctx.beginPath();
        ctx.moveTo(hz.x + dx * (hz.r + 1.5 * unit), hz.y + dy * (hz.r + 1.5 * unit));
        ctx.lineTo(hz.x + dx * (hz.r + 1.5 * unit + len), hz.y + dy * (hz.r + 1.5 * unit + len));
        ctx.stroke();
      }
    }
    ctx.font = `${12 * unit}px ${FONT_SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [d, t] of [[0, '北'], [90, '东'], [180, '南'], [270, '西']]) {
      const p = cam.project([Math.cos(d * DEG), Math.sin(d * DEG), 0], {});
      if (!p) continue;
      let x = p.x, y = p.y;
      if (dome) {
        const dx = (p.x - hz.x) / hz.r, dy = (p.y - hz.y) / hz.r;
        x = hz.x + dx * (hz.r + 20 * unit); y = hz.y + dy * (hz.r + 20 * unit);
      } else {
        y += 16 * unit;
        if (x < -20 || x > this.w + 20) continue;
      }
      ctx.fillStyle = rgba(theme.text, (d === 0 ? 0.95 : 0.7) * a);
      ctx.fillText(t, x, y);
    }
  }

  /** Nearest named star or body to a screen point, for tap-to-identify. */
  pick(s, x, y) {
    const { cam, M, sky } = s;
    let best = null, bestScore = Infinity;
    const p = {}, n = [0, 0, 0];
    for (const b of sky.bodies) {
      if (b.alt < 0 || !cam.project(b.n, p)) continue;
      const d = Math.hypot(p.x - x, p.y - y) - (b.id === 'Moon' ? 14 : 6);
      if (d < 26 && d < bestScore) { bestScore = d; best = { type: 'body', id: b.id }; }
    }
    const pos = this.catalog.stars.pos;
    for (const [i, info] of this.catalog.names) {
      if (info.mag > 5) continue;
      mul(M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], n);
      if (n[2] < 0 || !cam.project(n, p)) continue;
      const d = Math.hypot(p.x - x, p.y - y) - Math.max(0, (3 - info.mag) * 3);
      if (d < 24 && d < bestScore) { bestScore = d; best = { type: 'star', index: i }; }
    }
    return best;
  }
}

function spaced(t) {
  return t.length <= 4 ? t.split('').join(' ') : t;
}
function overlap(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}
function ease(t) { return 1 - Math.pow(1 - t, 3); }
function label(ctx, text, x, y, unit, color) {
  ctx.font = `${10 * unit}px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Screen angle from the Moon toward the Sun (for the bright limb). */
export function limbAngle(cam, moonN, sunN) {
  const d = moonN[0] * sunN[0] + moonN[1] * sunN[1] + moonN[2] * sunN[2];
  const t = [sunN[0] - d * moonN[0], sunN[1] - d * moonN[1], sunN[2] - d * moonN[2]];
  const tl = Math.hypot(...t) || 1;
  const eps = 0.02;
  const q = [moonN[0] + (t[0] / tl) * eps, moonN[1] + (t[1] / tl) * eps, moonN[2] + (t[2] / tl) * eps];
  const ql = Math.hypot(...q);
  const a = cam.project(moonN, {}), b = cam.project([q[0] / ql, q[1] / ql, q[2] / ql], {});
  if (!a || !b) return 0;
  return Math.atan2(b.y - a.y, b.x - a.x);
}
