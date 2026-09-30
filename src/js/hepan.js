// 星空合盘: overlay two birth skies and tell the story of what they share — all real astronomy,
// no fortune-telling. The "score" is simply the share of naked-eye stars that were up for both.
import { skyState, mul, greatCircleKm, YEAR_MS, dirName } from './astro.js';
import { $, show, escapeHtml, fmtNum } from './ui.js';
import { slotHtml, activateSlots } from './monetize.js';
import { linkFor } from './share.js';
import { fmtLy } from './facts.js';
import { ease } from './camera.js';

const KEYWORDS = [
  [85, '同一片星空', '你们几乎是在同一片星空下来到这个世界的。'],
  [65, '同频的夜', '你们的夜空大半重叠，像是约好了一样。'],
  [45, '相互照亮', '一半的星星同时照着你们，另一半各自守着一个人。'],
  [25, '各自的银河', '你们各有一片银河，却在交界处亮着同样的星。'],
  [0, '互补的夜空', '你看不见的那些星，TA 替你看见了。'],
];

export function computeHepan(catalog, a, b, momentOf) {
  const ta = momentOf(a), tb = momentOf(b);
  const sa = skyState(ta, a.city.lat, a.city.lon);
  const sb = skyState(tb, b.city.lat, b.city.lon);
  const pos = catalog.stars.pos, count = catalog.stars.count;
  const va = [0, 0, 0], vb = [0, 0, 0];
  let both = 0, either = 0;
  const upA = new Set(), upB = new Set();
  for (let i = 0; i < count; i++) {
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    mul(sa.M, p, va); mul(sb.M, p, vb);
    const A = va[2] > 0, B = vb[2] > 0;
    if (A || B) either++;
    if (A && B) both++;
    if (catalog.names.has(i)) { if (A) upA.add(i); if (B) upB.add(i); }
  }
  const score = either ? Math.round((both / either) * 100) : 0;
  const shared = [...catalog.names.values()].filter((s) => s.mag < 1.6 && upA.has(s.i) && upB.has(s.i)).slice(0, 4);
  const planetsShared = sa.bodies.filter((p) => !['Sun', 'Moon'].includes(p.id) && p.alt > 0 && sb.bodies.find((q) => q.id === p.id).alt > 0);
  const [, keyword, keySentence] = KEYWORDS.find(([min]) => score >= min);

  const find = (en) => [...catalog.names.values()].find((s) => s.en === en);
  const vega = find('Vega'), altair = find('Altair');
  const nA = escapeHtml(a.name || '你'), nB = escapeHtml(b.name || 'TA');
  const lines = [];

  lines.push(`你们出生的那一刻，有 <em>${fmtNum(both)}</em> 颗星同时亮在你们两个人的头顶${shared.length ? `，最亮的是${shared.map((s) => `<em>${escapeHtml(s.zh)}</em>`).join('、')}` : ''}。`);

  if (vega && altair) {
    const aV = upA.has(vega.i), aA = upA.has(altair.i), bV = upB.has(vega.i), bA = upB.has(altair.i);
    if (aV && aA && bV && bA) lines.push('<em>牛郎星</em>和<em>织女星</em>，同时照着你们两个人出生的夜晚。');
    else if ((aV && bA) || (aA && bV)) {
      const [w, c] = aV && bA ? [nA, nB] : [nB, nA];
      lines.push(`${w}出生时<em>织女星</em>在天上，${c}出生时<em>牛郎星</em>在天上——隔着一条银河，也还是遇见了。`);
    }
  }

  const pa = sa.moonPhase.name, pb = sb.moonPhase.name;
  lines.push(pa === pb
    ? `同一种月亮：你们都出生在<em>${pa}</em>之下。`
    : `${nA}的月亮是<em>${pa}</em>，${nB}的是<em>${pb}</em>。`);

  if (planetsShared.length) {
    lines.push(`${planetsShared.map((p) => `<em>${p.zh}</em>`).join('、')}，在你们各自出生的那一刻都挂在天上。`);
  }

  const km = greatCircleKm(a.city.lat, a.city.lon, b.city.lat, b.city.lon);
  const days = Math.round(Math.abs(tb - ta) / 86400000);
  const place = km < 30 ? '你们出生在同一座城市' : `出生地相隔 <em>${fmtNum(km)}</em> 公里`;
  const when = days === 0 ? '出生在同一天' : `出生相隔 <em>${fmtNum(days)}</em> 天`;
  lines.push(`${place}，${when}。`);

  const years = Math.abs(tb - ta) / YEAR_MS;
  if (years >= 3.8) {
    let near = null;
    for (const s of catalog.names.values()) {
      if (!s.ly || s.mag > 3.5) continue;
      if (!near || Math.abs(s.ly - years) < Math.abs(near.ly - years)) near = s;
    }
    if (near) lines.push(`把你们相差的 ${years.toFixed(1)} 年换成光走过的路，差不多能从这里抵达<em>${escapeHtml(near.zh)}</em>（${fmtLy(near.ly)}）。`);
  } else if (years >= 0.2) {
    lines.push(`在你们出生之间的这段时间里，光走了 ${years.toFixed(1)} 光年，差不多是去往最近的恒星南门二路程的 ${Math.round((years / 4.37) * 100)}%。`);
  } else if (days > 0) {
    lines.push(`你们出生之间的 ${fmtNum(days)} 天里，光已经飞出了 ${fmtNum(days * 173.1)} 个日地距离，远远越过了冥王星。`);
  }

  return { a, b, ta, tb, sa, sb, score, both, either, keyword, keySentence, lines, shared };
}

export class HepanView {
  constructor(app) {
    this.app = app;
    this.canvas = $('#hp-canvas');
    this.result = null;
    this.images = null;
  }

  defaultTitle() {
    const r = this.result;
    return `${r.a.name || '我'} × ${r.b.name || 'TA'}`;
  }

  defaultLine() {
    return this.result.keySentence;
  }

  link() {
    return linkFor('result', this.result.a, this.result.b);
  }

  show(result) {
    this.result = result;
    const { a, b } = result;
    const api = this.app.api;
    api.setPlace(a);
    api.tween(this.app.vis, 'lines', 0.35, 800);
    api.tween(this.app.vis, 'labels', 0, 600);
    api.tween(this.app.vis, 'names', 0, 600);
    api.moveCamera('horizon', 2400);
    const isMine = this.app.me && (samePerson(this.app.me, a) || samePerson(this.app.me, b));
    $('#hp-body').innerHTML = `
      <p class="hp-names">${escapeHtml(a.name || '我')}<span style="color:var(--gold);margin:0 .6em">×</span>${escapeHtml(b.name || 'TA')}</p>
      <p class="hp-score latin-num"><span id="hp-num">0</span><small>%</small></p>
      <p class="hp-score-label">星空重合度</p>
      <p class="hp-keyword">${result.keyword}</p>
      <p class="fine" style="margin-top:8px">${result.keySentence}</p>
      <ul class="hp-lines">${result.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
      ${slotHtml('hepan')}
      <div class="hp-actions">
        <button class="btn-primary wide" id="hp-poster"><span class="btn-label">生成合盘海报</span></button>
        <button class="btn-ghost" id="hp-send">${isMine ? '把结果发给 TA' : '分享这个合盘'}</button>
        <button class="btn-ghost" id="hp-more">${isMine ? '再邀请一位朋友' : '我也要合盘'}</button>
        <button class="btn-ghost" id="hp-mine">看看我的星空</button>
      </div>
      <p class="fine">重合度 = 两人出生时同在地平线上的肉眼可见恒星 ÷ 至少一人能看见的恒星。</p>`;
    activateSlots($('#hp-body'));
    $('#hp-poster').onclick = () => { this.app.viewing = a; api.openPoster('hepan'); };
    $('#hp-send').onclick = () => api.shareResult(a, b, result);
    $('#hp-more').onclick = () => {
      if (isMine) api.inviteOthers(this.app.me);
      else if (this.app.me) this.show(computeHepanAgain(this.app, this.app.me, a));
      else { this.hide(); this.app.link = { kind: 'invite', a }; api.openForm('hepan-self'); }
    };
    $('#hp-mine').onclick = () => api.mySky();
    show('#hepan', true);
    $('#hepan').scrollTop = 0;
    this.images = null;
    requestAnimationFrame(() => this.animate());
  }

  hide() {
    show('#hepan', false);
    cancelAnimationFrame(this.raf);
  }

  animate() {
    const r = this.result;
    const c = this.canvas;
    const cssW = c.clientWidth || 360, cssH = cssW / 1.45;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    const ctx = c.getContext('2d');
    const D = Math.round(Math.min(cssH * 0.9, cssW / 1.72) * dpr);
    if (!this.images) {
      const ps = this.app.posters;
      this.images = [ps.dome(r.sa, D, 'night', { labels: false, names: false }), ps.dome(r.sb, D, 'night', { labels: false, names: false })];
    }
    const [ia, ib] = this.images;
    const t0 = performance.now();
    const W = c.width, H = c.height, cy = H / 2, R = D / 2;
    const finalOff = R * 0.62;
    const startOff = W / 2 + R;
    let chimed = false;
    const numEl = $('#hp-num');
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 2400);
      const e = ease.out(t);
      const off = startOff + (finalOff - startOff) * e;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = Math.min(1, t * 3);
      ctx.drawImage(ia, W / 2 - off - R, cy - R);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(ib, W / 2 + off - R, cy - R);
      ctx.restore();
      // lens glow
      if (t > 0.6) {
        ctx.save();
        ctx.beginPath(); ctx.arc(W / 2 - off, cy, R, 0, Math.PI * 2); ctx.clip();
        ctx.beginPath(); ctx.arc(W / 2 + off, cy, R, 0, Math.PI * 2); ctx.clip();
        const g = ctx.createRadialGradient(W / 2, cy, 0, W / 2, cy, R);
        const a = 0.22 * Math.min(1, (t - 0.6) / 0.4) * (0.85 + 0.15 * Math.sin(now / 600));
        g.addColorStop(0, `rgba(226,199,150,${a})`);
        g.addColorStop(1, 'rgba(226,199,150,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      for (const x of [W / 2 - off, W / 2 + off]) {
        ctx.strokeStyle = 'rgba(226,199,150,0.5)';
        ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.arc(x, cy, R + 3 * dpr, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      numEl.textContent = String(Math.round(r.score * ease.inOut(Math.min(1, t * 1.1))));
      if (t > 0.72 && !chimed) {
        chimed = true;
        const au = this.app.audio;
        [0, 4, 7, 9].forEach((k, i) => au.bell(62 + k + (i > 2 ? 12 : 0), 0.3, au.now() + i * 0.12, { bright: 0.4, pan: i % 2 ? 0.4 : -0.4, decay: 5 }));
      }
      if (t < 1 || document.getElementById('hepan').classList.contains('is-active')) {
        // keep the lens breathing while visible
        this.raf = requestAnimationFrame(step);
      }
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(step);
  }
}

function samePerson(p, q) {
  return p && q && p.date === q.date && p.time === q.time && Math.abs(p.city.lat - q.city.lat) < 0.01 && Math.abs(p.city.lon - q.city.lon) < 0.01;
}

function computeHepanAgain(app, a, b) {
  return computeHepan(app.catalog, a, b, app.api.momentOf);
}
