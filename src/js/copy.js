// Every visible string of 「你来的那晚」, verbatim from the design spec (§4–§7, S19 titles), plus the
// small formatters and line-breaking rules they share. Plain text everywhere: no HTML, no emphasis markup.
//
// Public API
//   T                       nested object of strings and (args) => string builders
//   DISPLAY_STRINGS         the only strings set in the "Nawan Serif" subset (spec §2.1)
//   noWidow(text) → html    escapes text; '\n' → <br>; unbreakable runs wrapped in <span class="nw">
//                           (CSS: .nw { white-space: nowrap }). Always kept whole: the last 4 characters
//                           of every CJK sentence (spec §2.1). Also kept whole: short dictionary words,
//                           registered names (keepWords), a number with its unit (「2001 年」「35 光年」).
//   wrapCanvas(ctx, text, maxWidth, maxLines = Infinity) → string[]
//                           canvas line breaker with exactly the same rules plus CJK kinsoku; '\n' is a
//                           hard break; '…' when it runs past maxLines
//   keepWords(list)         registers names that must never break (facts.js / hepan.js call it)
//   graphemes(s) → string[] user-perceived characters
//   fmtWhen(p, { name, at }) → '1998 年 7 月 14 日 22:00 · 杭州'   (alias fmtWhenCN)
//                           name: string (or true for p.name) prefixes 「小明 · 」;
//                           at: {y, m, d, hh, mm} wall-clock parts (e.g. astro.zonedParts) override
//                           the stored date/time (ruler)
//   fmtDate(p) → '1998 年 7 月 14 日'      fmtTime(p) → '22:00' | '夜里'
//   fmtDot(p | Date | {y,m,d}) → '1998.07.14'
//   fmtCount(n) → '4,267'   fmtMag(m) → '−1.2' (U+2212)   fmtDeg(x, digits) → '10.4°'
//   fmtLightTime(minutes) → '12 分钟' | '1.3 小时'
//   cjk`…${v}…`             template tag: inserts one half-width space where an inserted value meets
//                           CJK on one side and a Latin letter/digit on the other (「发给 TA」)
//   nameOr(p | string, fallback = 'TA') → display name
//
// Line breaks inside a string are written as '\n' (the spec's 「／」). Render with noWidow() in the
// DOM and wrapCanvas() on canvas; both honour it.

// ---------------------------------------------------------------- text utilities
const HAN = /\p{Script=Han}/u;
const ALNUM = /[A-Za-z0-9]/;

function glue(a, b) {
  if (!a || !b) return a + b;
  const x = a[a.length - 1], y = b[0];
  if ((HAN.test(x) && ALNUM.test(y)) || (ALNUM.test(x) && HAN.test(y))) return `${a} ${b}`;
  return a + b;
}

/** Template tag: CJK ↔ Latin/digit spacing at the seams of interpolated values (spec §2.1). */
export function cjk(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) {
    out = glue(out, vals[i] == null ? '' : String(vals[i]));
    out = glue(out, strings[i + 1]);
  }
  return out;
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
/** User-perceived characters (keeps emoji ZWJ sequences whole where Intl.Segmenter exists). */
export function graphemes(s) {
  s = String(s ?? '');
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CLOSE = new Set([...'，。、；：！？）」』》”’〉】…%·,.;:!?)]}']);
const OPEN = new Set([...'（「『《“‘〈【([{']);
const isWideChar = (c) => HAN.test(c) || /[\u3000-\u303F\uFF00-\uFFEF\u2014\u2026\u201C\u201D\u2018\u2019]/.test(c) || /\p{Extended_Pictographic}/u.test(c);
const DIGIT = /[0-9]/, NUMCH = /[0-9.,]/;
const ENDERS = '。！？', AFTER_END = '”’」』）》';
const UNIT2 = new Set(['光年', '小时', '分钟', '公里']);

const wordSeg = (() => {
  try { return typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null; } catch { return null; }
})();

// Names that must never be split across lines: star, constellation, planet, person and city names.
// facts.js / hepan.js register the catalogue and the people; a few common ones are built in.
const PHRASES = new Map(); // first grapheme → [graphemes[]], longest first
const PHRASE_SET = new Set();
export function keepWords(list) {
  for (const w of list || []) {
    const s = String(w ?? '').trim();
    if (!s || PHRASE_SET.has(s) || !HAN.test(s) || /\s/.test(s)) continue;
    const g = graphemes(s);
    if (g.length < 2 || g.length > 8) continue;
    PHRASE_SET.add(s);
    const arr = PHRASES.get(g[0]) || [];
    arr.push(g);
    arr.sort((x, y) => y.length - x.length);
    PHRASES.set(g[0], arr);
  }
}
keepWords(['月亮', '银河', '地平线', '牛郎星', '织女星', '南门二', '水星', '金星', '火星', '木星', '土星', '太阳',
  '新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月', '天文单位', '两个人', '那一刻', '那一夜']);

/**
 * Break opportunities for g (graphemes): ok[i] = true when a line may start at g[i].
 * CJK breaks between characters except before closing / after opening punctuation; Latin words and
 * numbers stay whole; spaces break after themselves. Kept whole as well: short dictionary words
 * (Intl.Segmenter), registered names (keepWords), a number with its unit (2001 年, 35 光年), and —
 * the spec's no-widow rule — the last 4 characters of every CJK sentence.
 */
function breakable(g) {
  const n = g.length, ok = new Array(n + 1).fill(false);
  for (let i = 1; i < n; i++) {
    const a = g[i - 1], b = g[i];
    if (b === ' ' || CLOSE.has(b) || b === '—') ok[i] = false; // never start a line with these
    else if (a === ' ') ok[i] = true;
    else if (OPEN.has(a)) ok[i] = false;
    else if (isWideChar(a) || isWideChar(b)) ok[i] = true;
    else ok[i] = false; // inside a Latin word or number
  }
  ok[n] = true;
  const hold = (x, y) => { for (let i = Math.max(1, x + 1); i < Math.min(n, y); i++) ok[i] = false; };

  if (wordSeg && n > 2) {
    const at = new Map();
    for (let i = 0, off = 0; i <= n; i++) { at.set(off, i); off += i < n ? g[i].length : 0; }
    for (const w of wordSeg.segment(g.join(''))) {
      if (!w.isWordLike || !HAN.test(w.segment)) continue;
      const x = at.get(w.index), y = at.get(w.index + w.segment.length);
      if (x != null && y != null && y - x >= 2 && y - x <= 4) hold(x, y);
    }
  }
  for (let i = 0; i < n; i++) {
    const list = PHRASES.get(g[i]);
    if (!list) continue;
    const p = list.find((ph) => i + ph.length <= n && ph.every((c, k) => g[i + k] === c));
    if (p) { hold(i, i + p.length); i += p.length - 1; }
  }
  for (let i = 0; i < n; i++) {
    if (!DIGIT.test(g[i]) || (i > 0 && NUMCH.test(g[i - 1]))) continue;
    let j = i;
    while (j < n && NUMCH.test(g[j])) j++;
    let k = j < n && g[j] === ' ' ? j + 1 : j;
    if (k < n && HAN.test(g[k])) hold(i, k + (k + 1 < n && UNIT2.has(g[k] + g[k + 1]) ? 2 : 1));
    i = j - 1;
  }

  // no widows: sentence ends are after 。！？ (+ closers) or at the end of the line
  const ends = [];
  for (let i = 0; i < n; i++) {
    if (ENDERS.includes(g[i])) {
      let j = i + 1;
      while (j < n && (ENDERS.includes(g[j]) || AFTER_END.includes(g[j]))) j++;
      ends.push(j); i = j - 1;
    }
  }
  if (!ends.length || ends[ends.length - 1] !== n) ends.push(n);
  let start = 0;
  for (let e of ends) {
    if (g.slice(start, e).some((c) => HAN.test(c))) {
      // the last 4 characters (spaces not counted) of the sentence stay on one line
      while (e > start && g[e - 1] === ' ') e--;
      let t = e, seen = 0;
      while (t > start && seen < 4) { t--; if (g[t] !== ' ') seen++; }
      hold(t, e);
    }
    start = e;
  }
  return ok;
}

// a run is worth a nowrap span when the browser could otherwise break inside it
const breaksInside = (run) => run.filter((c) => c !== ' ' && !CLOSE.has(c) && !OPEN.has(c)).length >= 2;

/**
 * HTML for DOM text (captions, hints, plates): escaped, '\n' → <br>, and every unbreakable run from
 * breakable() — which always includes the last 4 characters of each CJK sentence (spec §2.1) — wrapped
 * in <span class="nw"> (CSS: .nw { white-space: nowrap }).
 */
export function noWidow(text) {
  return String(text ?? '').split('\n').map((line) => {
    const g = graphemes(line);
    if (!g.some((c) => HAN.test(c))) return escapeHtml(line);
    const ok = breakable(g);
    let html = '', start = 0;
    for (let i = 1; i <= g.length; i++) {
      if (!ok[i]) continue;
      let x = start, y = i;
      while (x < y && g[x] === ' ') x++;
      while (y > x && g[y - 1] === ' ') y--;
      const run = g.slice(x, y);
      html += escapeHtml(g.slice(start, x).join(''))
        + (breaksInside(run) ? `<span class="nw">${escapeHtml(run.join(''))}</span>` : escapeHtml(run.join('')))
        + escapeHtml(g.slice(y, i).join(''));
      start = i;
    }
    return html;
  }).join('<br>');
}

/** Canvas line breaker (spec §2.1): same no-widow rule as noWidow(); '\n' is a hard break. */
export function wrapCanvas(ctx, text, maxWidth, maxLines = Infinity) {
  const w = (s) => ctx.measureText(s).width;
  const out = [];
  for (const hard of String(text ?? '').split('\n')) {
    const g = graphemes(hard.trim());
    if (!g.length) { out.push(''); continue; }
    const ok = breakable(g);
    let start = 0;
    while (start < g.length) {
      // longest run start..end that fits and ends at a break opportunity
      let best = -1;
      for (let end = start + 1; end <= g.length; end++) {
        if (!ok[end]) continue;
        if (w(g.slice(start, end).join('').trimEnd()) <= maxWidth) best = end;
        else break;
      }
      if (best < 0) {
        // nothing fits: take the first unbreakable run if it fits, else break by character
        let end = start + 1;
        while (end < g.length && !ok[end]) end++;
        if (w(g.slice(start, end).join('').trimEnd()) > maxWidth) {
          end = start + 1;
          while (end < g.length && w(g.slice(start, end + 1).join('')) <= maxWidth) end++;
        }
        best = end;
      }
      out.push(g.slice(start, best).join('').trimEnd());
      start = best;
      while (start < g.length && g[start] === ' ') start++;
    }
  }
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  let last = graphemes(out.slice(maxLines - 1).reduce((acc, l) => (acc && ALNUM.test(acc[acc.length - 1]) && ALNUM.test(l[0] || '') ? `${acc} ${l}` : acc + l), ''));
  while (last.length && w(last.join('').trimEnd() + '…') > maxWidth) last.pop();
  kept[maxLines - 1] = last.join('').trimEnd().replace(/[，。、；：,.;:]$/, '') + '…';
  return kept;
}

// ---------------------------------------------------------------- formatters
const pad = (n) => String(n).padStart(2, '0');

function ymd(p) {
  if (p instanceof Date) return { y: p.getFullYear(), m: p.getMonth() + 1, d: p.getDate() };
  if (p && typeof p.date === 'string') {
    const [y, m, d] = p.date.split('-').map(Number);
    return { y, m, d };
  }
  return { y: p.y, m: p.m, d: p.d };
}

export function fmtCount(n) {
  const r = Math.round(Number(n) || 0);
  const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return r < 0 ? `−${s}` : s;
}

/** Signed decimal with U+2212 for negatives (magnitudes, altitudes). */
export function fmtSigned(x, digits = 1) {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  if (r === 0) return (0).toFixed(digits);
  return r < 0 ? `−${Math.abs(r).toFixed(digits)}` : r.toFixed(digits);
}
export const fmtMag = (m) => fmtSigned(m, 1);
export const fmtDeg = (x, digits = 0) => `${fmtSigned(x, digits)}°`;

export function fmtLightTime(min) {
  if (min < 59.5) return `${Math.max(1, Math.round(min))} 分钟`;
  return `${(min / 60).toFixed(1)} 小时`;
}

export function fmtDate(p) {
  const { y, m, d } = ymd(p);
  return `${y} 年 ${m} 月 ${d} 日`;
}

export function fmtTime(p) {
  return p.unknownTime ? '夜里' : p.time;
}

export function fmtDot(p) {
  const { y, m, d } = ymd(p);
  return `${y}.${pad(m)}.${pad(d)}`;
}

export function nameOr(p, fallback = 'TA') {
  const n = typeof p === 'string' ? p : p?.name;
  return n && String(n).trim() ? String(n).trim() : fallback;
}

export function fmtWhen(p, { name, at } = {}) {
  const date = at ? fmtDate(at) : fmtDate(p);
  const time = at ? `${pad(at.hh)}:${pad(at.mm)}` : fmtTime(p);
  const s = `${date} ${time} · ${p.city.name}`;
  const who = name === true ? (p.name || '').trim() : (name || '').trim();
  return who ? `${who} · ${s}` : s;
}

/** impl-steps name for fmtWhen. */
export const fmtWhenCN = fmtWhen;

/** Rewind sub-line: 28 年，一夜一夜退回去 / 退回 45 个夜晚. */
function agoText(birth, now) {
  const ms = Math.max(0, now.getTime() - birth.getTime());
  const years = Math.floor(ms / (365.2425 * 86400000));
  if (years >= 1) return `${years} 年，一夜一夜往回走`;
  return `往回走 ${Math.max(1, Math.round(ms / 86400000))} 个夜晚`;
}

function relText(minutes) {
  const m = Math.round(Math.abs(minutes));
  if (m === 0) return '出生那一刻';
  const h = Math.floor(m / 60), mm = m % 60;
  const span = h ? (mm ? `${h} 小时 ${mm} 分` : `${h} 小时`) : `${mm} 分钟`;
  return `${minutes > 0 ? '出生后' : '出生前'} ${span}`;
}

const joinAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join('、')}和${xs[xs.length - 1]}`);

// ---------------------------------------------------------------- the strings
export const DISPLAY_STRINGS = ['你来的那晚', '这一夜，你来到世上', '两个人的星空', '你是哪一天来到这世上的？', 'TA 是哪一天来到这世上的？', '你是这一天来的吗？', '那一夜', '关于'];

const BRAND = '你来的那晚';

// Strings that must read the same in two places (the tour caption and the 那一夜 plate row).
const PLANETS_NONE = '那一刻，五颗亮行星都沉在地平线下，\n正行在大地的另一边。';
const countLine = (n) => `那一刻，抬头可见的星有 ${n} 颗——\n每一颗，都是一个太阳。`;

// 送一张 · 星空贺卡: the sender's form, the friend's sky, the 贺卡 viewfinder and result, and the
// receiver's landing. The card text itself is drawn by poster.js giftCardText().
const GIFT = {
  action: '送一张',
  // form (the friend's birthday)
  formOver: '为 TA 寻回一片星空',
  formTitle: 'TA 是哪一天来到这世上的？', // a display string (same as T.form.partnerTitle)
  toLabel: 'TA 的名字',
  toPlaceholder: '会写在贺卡上',
  dateLabel: 'TA 的生日',
  timeLabel: '出生时间',
  cityLabel: '出生城市',
  unknown: '不记得具体时间，按当晚 22:00',
  fromLabel: '你的署名',
  fromPlaceholder: '会写在贺卡右下角',
  go: '去那一晚',
  fine: '二维码带着 TA 的生日、时间、城市、名字和署名。',
  // the friend's sky and the 贺卡 viewfinder
  arriveCaption: (to) => cjk`这是${nameOr(to)}来的那一夜。\n拖动，挑一角天空，裁成一张贺卡。`,
  tab: '贺卡',
  keepHint: '拖动取景，把想送的那一角天，轻轻框进来。',
  greetingOn: '祝福：加上',
  greetingOff: '祝福：不加',
  // the default greeting line above the message (meant for the birthday itself; 生日快乐。 is the plain alternative)
  greetingDefault: '地球又绕太阳走了一圈。',
  poemNext: '换一首',
  ownWords: '自己写',
  ownPlaceholder: '想对 TA 说的话，写在星空下',
  // on the card (poster.js giftCardText)
  cardTo: (to) => `给 ${nameOr(to, '你')}`,
  cardFrom: (from) => `${String(from ?? '').trim()} 赠`,
  cardWhose: (city, to) => {
    const n = nameOr(to, '');
    return n ? cjk`${city} · ${n}来的那一夜` : city;
  },
  qrCaption: '长按识别，回到你来的那晚',
  // S15 result and S19 share
  resultTip: '长按图片，把这一夜寄给 TA',
  resultHow: 'TA 扫一扫，便能站回自己来的那一夜。',
  guide2: (to) => cjk`把这一夜的星空送给${nameOr(to)}`,
  // the receiver (a gift link ?p=…&f=<sender>)
  receiverLede: (from, p) => cjk`${nameOr(from, '有人')}为你寻回了一片星空：\n${fmtDate(p)}，${p.city.name}，你来的那一夜。`,
  receiverGo: '去看看',
  receiverTitle: '这一夜，你来到世上', // a display string (same as T.arrive.titleOwn)
  receiverCaption: (from) => cjk`这片天，是${nameOr(from, '有人')}为你找回来的。\n你来的那一刻，它就在你头顶。`,
  docTitle: (from) => cjk`${nameOr(from, '有人')}为你寻回了出生那夜的星空｜${BRAND}`,
  shareText: '送你一片星空，是你出生那一夜的天。',
  fileName: (p) => `${BRAND}-${p.date}-贺卡.jpg`,
};

// 印成明信片: the print upsell on the export result, the order sheet, and the seller's print page (?print=)
const PRINT = {
  upsell: (price) => `印成明信片，寄给 TA · ¥${price}`,
  upsellWall: (price) => `把这片星空印成明信片 · ¥${price}`,
  wallSwitch: '换成便签的取景，就这张之后，就能印成明信片。',
  shareNudge: '也可以把这片星空发到群里，让大家看看自己出生那晚的天。',
  sheetTitle: '把这一夜印出来',
  sheetBody: '105 × 140 毫米，350 克卡纸，正面丝绒触感，背面可以手写。\n装进信封，寄到 TA 手里。',
  codeLabel: '订单码',
  copy: '复制订单码',
  copied: '订单码已复制',
  stepShop: '复制订单码，去店铺下单，把它粘贴在「买家留言」里。',
  stepContact: (c) => `复制订单码，发给我们下单：${c}`,
  go: '去下单',
  close: '关闭',
  custom: '定制商品，印好就寄出，不支持七天无理由退货。',
  // the seller's page
  pageTitle: '印刷文件',
  download: '下载印刷文件',
  bad: '这个订单码无法识别，请让顾客重新复制。',
  drawing: '正在绘制印刷文件…',
  spec: '1080 × 1440 · 3:4 · 105 × 140 毫米约 261 dpi',
};

export const T = {
  brand: BRAND,
  print: PRINT,
  tip: { label: '喝杯咖啡', close: '关闭' },

  // S1 开场 · 自己打开
  intro: {
    title: BRAND,
    lede: '你看见的每一颗星，都是它很久以前的样子。\n现在，让天空退回你来的那一刻。',
    loading: (pct) => `载入星表 ${Math.round(pct)}%`,
    start: '回到那一晚',
    hint: '戴上耳机，夜有它的声音',
    about: '关于',
    failed: '载入失败，轻触重试',
  },

  // S2 开场 · 从链接进入
  link: {
    person: (p) => cjk`${nameOr(p, '有人')}想领你去一个很远的夜晚：\n${fmtDate(p)}，${p.city.name}的星空下。`,
    personGo: '去看看',
    invite: (p) => cjk`${nameOr(p, '有人')}想把你们来的那两个夜晚，\n放进同一片天空。`,
    inviteFill: '填我的生日',
    inviteUse: '用我的生日',
    inviteOther: '换一个生日',
    result: (a, b) => {
      const A = nameOr(a, ''), B = nameOr(b, '');
      if (!A && !B) return '两个夜晚，两片天空，\n有些星，在两边都亮着。';
      return cjk`${A || 'TA'}来的那晚，${B || 'TA'}来的那晚，\n有些星，在两边都亮着。`;
    },
    resultGo: '去看看',
  },

  // S3 填写
  form: {
    title: '你是哪一天来到这世上的？',
    nameLabel: '名字（可不填）',
    namePlaceholder: '会写进字幕和图片里',
    dateLabel: '出生日期',
    units: { y: '年', m: '月', d: '日' },
    timeLabel: '出生时间',
    timeDefault: '22:00',
    unknown: '不记得具体时间，按当晚 22:00',
    cityLabel: '出生城市',
    cityPlaceholder: '选择城市',
    cityValue: (c) => (c.region ? `${c.name} · ${c.region}` : c.name),
    errors: {
      incomplete: '出生日期还没填完',
      invalid: '日历上没有这一天，再看看月和日',
      tooEarly: '目前只能回到 1900 年以后',
      future: '这一天还没有到来',
      city: '出生城市还没选',
    },
    go: '出发',
    fine: '你的生日只在这台手机上计算和保存，不会上传。',
    back: '返回',
    // invite mode, no stored birthday
    inviteOver: (name) => cjk`${nameOr(name)}想认识你来的那一夜`,
    // invite mode, stored birthday
    confirmOver: (name) => cjk`${nameOr(name)}在同一片星空下等你`,
    confirmTitle: '你是这一天来的吗？',
    confirmLine: (me) => fmtWhen(me),
    confirmGo: '就用这个',
    confirmOther: '换一个生日',
    // 替 TA 填
    partnerTitle: 'TA 是哪一天来到这世上的？',
    partnerNameLabel: 'TA 的名字（可不填）',
    partnerGo: '放在一起看',
  },

  // S3b 选择城市
  city: {
    placeholder: '输入城市，如 杭州、成都、Toronto',
    cancel: '取消',
    common: '常用',
    commonList: ['北京', '上海', '广州', '深圳', '成都', '杭州', '重庆', '武汉', '西安', '南京'],
    none: '没有找到这座城市，试试附近的大城市',
    loading: '城市列表载入中…',
  },

  // S4 时光倒流
  rewind: {
    counter: (from, to) => `${fmtDot(from)} → ${fmtDot(to)}`,
    ago: (birth, now = new Date()) => agoText(birth, now),
    place: (p, name) => {
      const who = nameOr(name ?? p.name, '');
      return who ? `${p.city.name} · ${who}` : p.city.name;
    },
    skip: '跳过',
  },

  // S5 抵达
  arrive: {
    sub: (p) => `${fmtTime(p)} · ${p.city.name}`,
    titleOwn: '这一夜，你来到世上',
    titleGuest: (name) => cjk`这一夜，${nameOr(name)}来到世上`,
  },

  // S5 主角字幕 (facts.js fills the values; S = subject: 你 / 小明 / TA). '\n' is the subtitle's line break.
  hero: {
    lightBefore: (S, star, year, n) => cjk`${star}的光 ${year} 年出发，\n走过 ${n} 年的黑暗，${S}才出生。`,
    lightAfter: (S, star, year, age) => cjk`${year} 年，${S} ${age} 岁。\n${star}的光那年出发，今夜才到。`,
    lightSame: (S, star, ly) => cjk`${star}的光与${S}同年出发，\n走了 ${ly} 光年，今夜刚好抵达。`,
    lightYoung: (S) => cjk`今夜每一束星光，都比${S}年长。\n最近的南门二，光也走了 4.3 年。`,
    moon: (S, phase, pct, sec) => cjk`那晚是${phase}，亮着 ${pct}%。\n月光只走 ${sec} 秒，就落到${S}身上。`,
    planet: (S, look, planet, ancient, lightTime) => cjk`那颗${look}星是${planet}，古称${ancient}。\n${S}看见的，是它 ${lightTime}前的样子。`,
    core: (S) => cjk`${S}面前这道微光，来自银河中心。\n它走了两万六千年，那时还没有文字。`,
    star: (S, star, ly) => (ly ? cjk`${S}面前最亮的那颗是${star}。\n它的光，从 ${ly}外远远走来。` : cjk`${S}面前最亮的那颗星，是${star}。\n那一夜，它就静静亮在那里。`),
    south: (S, dir, count) => cjk`${S}面朝正${dir}。那一刻，一抬头，\n便有 ${count} 颗星落进眼里。`,
    day: (S, dir) => cjk`${S}来的时候是白天，太阳在${dir}方。\n星星一颗也没少，只是被日光遮住了。`,
    twilight: (zh) => `那是${zh}，天边横着一线微光，\n只有最亮的几颗星，疏疏地亮着。`,
    hideSun: '藏起阳光',
    nightOf: '看看那天夜里',
    restoreSun: '放回阳光',
    coreLabel: '银河之心',
  },

  // S6 静止 · 元信息
  meta: {
    own: (p) => fmtWhen(p),
    guest: (p) => fmtWhen(p, { name: nameOr(p) }),
  },

  // one-time hints (hint slot; keys for localStorage birthsky:hints)
  hint: {
    look: '拖动转身，看看四野的星。轻触一颗，听它讲自己的来历。',
    tour: '轻触这行字，那一夜还有话没说完。',
    chromeBack: '轻触夜空，隐去的字会再浮上来。',
    zenith: '这里是天顶——那一夜，你的正上方。',
    gyro: '举起手机，慢慢转身，那一夜便在你四周铺开。',
    ruler: '拖动这把尺，看群星怎样一寸寸走完那一夜。',
    listen: '亮星经过画面中央，便响一声；星越高，音越高。',
    listenDone: '一整圈的星，都听过了。',
    keep: '拖动取景，给锁屏时钟留一角净空。',
    moonNudge: '月亮悄悄挪开一步，把时钟让了出来。',
    groundScrim: '字会落进星空里，已在下面铺一层暗色地面。',
    // 「正在冲印」 was proposed; kept as 绘制 (spec D-19 rejects 冲印 as a gimmick, §8 removed 「正在冲印星空…」)
    drawing: (W, H) => `正在绘制 ${W} × ${H}`,
    pairLine: (nameB) => cjk`那道虚线，是${nameOr(nameB)}来时的地平线。线以上的星，在你们两个人的夜里都亮着。`,
    pairSame: '你们的地平线，几乎叠成了同一条。',
    pairIncoming: (name) => cjk`现在，把${nameOr(name)}那一夜的地平线，\n画进这片天空。`,
  },

  // S7 操作层
  chrome: {
    actions: { listen: '聆听', keep: '留存', pair: '两个人', share: '分享', mine: '我的那晚' },
    culture: { cn: '星官', iau: '星座', none: '无连线' },
    cultureToast: { cn: '古人看的天：三垣二十八宿', iau: '今人看的天：88 星座', none: '只留星光，不着一线' },
    sound: { on: '有声', off: '静音' },
    gyro: '体感',
  },

  // S9 字幕导览 + 凝视标注
  tour: {
    moonUp: (phase, pct, dir) => cjk`${dir}方的天上，悬着一轮${phase}，\n亮着 ${pct}%，正照着那座城。`,
    moonDown: (phase) => cjk`那一刻，${phase}沉在地平线下，\n去照地球另一边的人了。`,
    zenith: (S, con, star, ly) => {
      const where = con ? `${con}的${star}` : star;
      return ly ? cjk`离${S}头顶最近的亮星是${where}，\n光从 ${ly}外垂下来。` : cjk`离${S}头顶最近的亮星，是${where}，\n那一夜，它几乎就在正上方。`;
    },
    planets: (list, S, first, lightTime) => cjk`${list}。\n照着${S}的，是${first} ${lightTime}前的光。`,
    planetAt: (zh, dir) => `${zh}在${dir}方`,
    planetsNone: PLANETS_NONE,
    count: countLine,
    // days = days since the solar term began (0 on the day itself), so the term day is day 1
    date: (lunar, term, days) => (lunar
      ? (days <= 0 ? `那天是${lunar}，\n恰逢${term}，时序刚刚翻过一页。` : `那天是${lunar}，\n${term}的风，已吹到第 ${days + 1} 天。`)
      : (days <= 0 ? `那天恰逢${term}，时序刚刚翻过一页。` : `那天，${term}的风已吹到第 ${days + 1} 天。`)),
    marker: (name, deg) => `${name} · 地平线下 ${deg}°`,
    tagMoon: (phase, pct) => `月亮 · ${phase} ${pct}%`,
    tagPlanet: (zh, lightTime) => `${zh} · ${lightTime}前的光`,
    tagZenith: (zh) => `${zh} · 离天顶最近的亮星`,
    tagLight: (zh, year) => `${zh} · ${year} 年出发的光`,
    // spec §10.4: the extra last step when the poem was chosen for the birthplace (line 1 is the poem)
    poemPlace: (S, place) => cjk`诗里的${place}，正是${S}出生的地方。`,
  },

  // S10 那一夜
  night: {
    title: '那一夜',
    labels: { light: '光年', moon: '月亮', zenith: '头顶', planets: '行星', count: '星数', term: '节气' },
    look: '在天上看',
    // the poem row (chrome.js reads these; it kept fallbacks of its own until they existed here)
    poemLabel: '诗',
    poemNext: '换一首',
    poemPlace: (place) => cjk`这一句诗，正落在${place}。`,
    lightMeta: (zh, con, ly) => [zh, con, ly].filter(Boolean).join(' · '),
    moonUp: (phase, pct, dir) => cjk`一轮${phase}，亮着 ${pct}%，\n静静悬在${dir}方的天上。`,
    moonDown: (phase, pct) => cjk`一轮${phase}，亮着 ${pct}%，\n那一刻，它去照地球另一边的人了。`,
    moonMeta: (lunar, yearName) => [lunar, yearName].filter(Boolean).join(' · '),
    zenith: (S, con, star) => cjk`离${S}头顶最近的亮星，是${con ? `${con}的${star}` : star}，\n那一夜，它几乎就在正上方。`,
    zenithMeta: (fromZenith, ly) => [`偏离天顶 ${fromZenith}`, ly ? `距离地球 ${ly}` : ''].filter(Boolean).join(' · '),
    planets: (list) => `${list}，沿着黄道缓缓地走。`,
    planetsNone: PLANETS_NONE,
    planetMeta: (zh, mag) => `${zh} ${mag} 等`,
    count: countLine,
    countMeta: 'HYG 星表 · 亮于 6.5 等',
    term: (term, days) => (days <= 0 ? `恰逢${term}，时序刚刚翻过一页。` : `${term}的风，已吹到第 ${days + 1} 天。`),
    unknownTime: '时间未知，画的是当晚 22:00 的天空',
    sponsor: (title) => `赞助　${title}`,
    other: '换一个生日',
    close: '关闭',
  },

  // S11 名条
  strip: {
    starMeta: (con, mag, ly) => [con, `${mag} 等`, ly].filter(Boolean).join(' · '),
    lightBefore: (year, S, n) => cjk`这束光 ${year} 年出发，\n走了 ${n} 年，${S}才出生。`,
    lightSame: (year, S) => cjk`这束光 ${year} 年出发，\n那一年，${S}也刚刚来到世上。`,
    lightAfter: (year, S, n) => cjk`${year} 年，${S} ${n} 岁，\n这束光那年出发，今夜才到。`,
    lightPlain: (year) => `这束光 ${year} 年出发，\n地上换了许多代人，它今夜才到。`,
    lightBC: (year) => `这束光公元前 ${year} 年出发，\n越过千年史册，今夜才到。`,
    far: '它太远了，远得量不准。\n这束光走过上千年的夜，才到今夜。',
    dipper: '北斗七星之一。古人仰看斗柄，便知四时：\n斗柄东指，天下皆春；斗柄南指，天下皆夏。',
    planetMeta: (mag, au) => `${mag} 等 · 距离 ${au} 天文单位`,
    planetLight: (S, zh, lightTime) => cjk`那一刻落在${S}身上的，是${zh} ${lightTime}前的光。`,
    moonName: '月亮',
    moonMeta: (phase, pct, km) => `${phase} · 被照亮 ${pct}% · 距离 ${km} 公里`,
    moonStory: (sec, S, lunar) => cjk`月光从月面落到${S}身上，只要 ${sec} 秒。` + (lunar ? `\n那天是${lunar}。` : ''),
    sunName: '太阳',
    sunMeta: (alt, dir) => `高度 ${alt} · ${dir}方`,
    sunStory: (m, s, S) => cjk`阳光要走 ${m} 分 ${s} 秒，\n才能来到${S}的窗前。`,
    below: (name, deg) => cjk`那一刻，${name}沉在地平线下 ${deg}°。`,
    pairBoth: '你们来的那两夜，它都在天上。',
    pairOnly: (name) => cjk`它只照过${nameOr(name)}来的那一夜。`,
  },

  // S12 整夜
  ruler: {
    rel: (minutesFromBirth) => relText(minutesFromBirth),
    sunset: (t) => `日落 ${t}`,
    sunrise: (t) => `日出 ${t}`,
    play: '播放这一夜',
    pause: '暂停',
    back: '回到那一刻',
    done: '完成',
  },

  // S13 聆听
  listen: {
    status: '正在聆听',
    stop: '停',
    muted: '打开声音，再听星',
  },

  // S14 留存 · 取景
  keep: {
    cancel: '取消',
    formats: { wallpaper: '壁纸', card: '便签' },
    size: (W, H) => `${W} × ${H}`,
    desktopSizes: ['1290 × 2796（iPhone）', '1080 × 2400（安卓）', '2880 × 1800（电脑）'],
    styles: { night: '夜色', mono: '黑白', paper: '纸' },
    // 便签: full / date / none; 壁纸 (spec §10.3): poemDate (default) / poem / date / none
    textModes: { full: '文字：日期和一句话', date: '文字：只有日期', none: '文字：不加', poemDate: '文字：诗和日期', poem: '文字：只有诗' },
    lines: { off: '连线：关', on: '连线：开' },
    qr: { on: '二维码：开', off: '二维码：关' },
    write: '写一句',
    limits: { wallpaper: 20, card: 24 },
    // 便签: cycles L3 through [光年之星 sentence, poem 1, poem 2…] (the wallpaper uses 换一首, T.night.poemNext)
    lineNext: '换一句',
    // the viewfinder note under the frame (spec §10.4): 「杜甫《旅夜书怀》　·　遇见这一句的，还有 1,233 人。」
    note: (attribution, count) => [attribution, count].filter(Boolean).join('　·　'),
    noteOriginal: '本站所写',
    notePlace: (place) => cjk`写的正是${place}`,
    // default sentence (壁纸 L2 / placeholder): 织女星的光，2001 年就动身了。
    sentence: (star, year) => cjk`${star}的光，从 ${year} 年一路走来。`,
    go: '就这张',
    clockZone: '锁屏时间区域',
    ghostTime: '9:41',
  },

  // S15 留存 · 成片
  result: {
    back: '返回取景',
    done: '完成',
    wxWallpaper: '长按图片，把那一夜的星存下',
    wxWallpaperIOS: '存好后：照片 › 这张图 › 分享 › 用作墙纸',
    wxWallpaperAndroid: '存好后：相册 › 这张图 › 更多 › 设为壁纸',
    wxCard: '长按图片，存下，或寄给一个人',
    phone: '保存到相册',
    desktop: '下载图片',
    saved: '已收好这一夜',
    fallback1080: '图片太大，已改用 1080 宽重新绘制',
    fileName: (p, kind) => `${BRAND}-${p.date}-${{ wallpaper: '壁纸', card: '便签', pair: '两个人', gift: '贺卡' }[kind] || '便签'}.jpg`,
  },

  // S16 两个人 · 邀请
  pairInvite: {
    title: '两个人的星空',
    body: '把你们来的那两个夜晚，叠成一片天，\n看哪些星，曾照过你们两个人。',
    send: '发给 TA，请 TA 填生日',
    manual: '我知道 TA 的生日',
    cancel: '取消',
  },

  // S17 两个人 · 结果 (hepan.js fills the values)
  pair: {
    name: '两个人',
    title: '两个人的星空',
    where: (name, city) => cjk`${name}的天空 · ${city}`,
    switchTo: (name) => cjk`看${name}的天空`,
    date: (name, p) => `${name}　${fmtWhen(p)}`,
    headline: (n) => `${n} 颗星，在你们两个人的夜里都亮过。`,
    brightest: (names) => `其中最亮的，要数${joinAnd(names)}。`,
    vegaAltairBoth: '织女星与牛郎星隔着银河，\n在你们两个人的天上，都遥遥相望。',
    vegaAltairSplit: (vegaName, altairName) => cjk`那颗织女星亮在${vegaName}来的夜里，\n银河对岸的牛郎星，去照了${altairName}。`,
    moons: (nA, pa, nB, pb) => cjk`${nA}来的那晚是${pa}，\n${nB}那一夜，月亮是另一副模样：${pb}。`,
    moonSame: (phase) => `你们各自来的那一夜，\n同一个月亮，都是${phase}的模样。`,
    planets: (list) => `你们各自来的那一刻，${list.join('、')}都在天上，两回都不曾缺席。`,
    apart: (km, days) => `你们生在相距 ${km} 公里的两处，\n先后隔着 ${days} 个日夜。`,
    apartSameDay: (km) => `你们生在相距 ${km} 公里的两处，\n却在同一天到来。`,
    sameCity: (days) => `同一座城的夜空，先后迎来了你们，\n中间隔着 ${days} 个日夜。`,
    sameCitySameDay: '你们在同一天，来到了同一座城的天底下。',
    lightYears: (years, star, ly) => cjk`若把你们相差的 ${years} 年交给一束光，\n它大约正走到 ${ly}外的${star}。`,
    definition: (score, both, either) => `重合度 ${score}%：两人出生时都在地平线之上的肉眼可见恒星（${both} 颗），占至少一人能看见的恒星（${either} 颗）的比例。`,
    horizon: (name) => cjk`${name}的地平线`,
    actionsOwn: { keep: '留存', send: '发给 TA', again: '再邀请一位', mine: '我的那晚' },
    actionsGuest: { keep: '留存', share: '分享', tryIt: '我也试试', mine: '我的那晚' },
  },

  // S18 朋友的星空
  guest: {
    invite: '你来的那一夜，\n头顶又是怎样一片天？',
    mine: '看看我的那晚',
    together: (name) => {
      const n = nameOr(name);
      return graphemes(n).length > 4 ? '和 TA 一起看' : cjk`和${n}一起看`;
    },
    actions: { mine: '我的那晚', pair: '两个人', listen: '聆听', keep: '留存', share: '分享' },
  },

  // S19 分享
  share: {
    guide1: '点右上角 ···',
    guide2: {
      own: '寄给一个人，或发到朋友圈',
      guest: '把这片星空，递给下一个人',
      result: (nameB) => cjk`把这片星空，也捎给${nameOr(nameB)}`,
      invite: '发给 TA，请 TA 填生日',
    },
    guide: (kind, name) => ['点右上角 ···', kind === 'result' ? T.share.guide2.result(name) : (T.share.guide2[kind] || T.share.guide2.own)],
    copied: '链接已复制',
    copyFailed: '长按地址栏复制链接',
    text: '你来的那一夜，天上亮着哪些星？',
    inviteText: '我们来的那两夜，有多少颗星，曾照过我们两个人？',
  },

  // document.title / og (these keep 出生那晚, so they do not echo the 你来的那晚 suffix)
  titles: {
    base: BRAND,
    description: '写下生日和出生的城，回到你来的那一夜，抬头看那时真实的星空。',
    person: (p, { own = true } = {}) => {
      const n = nameOr(p, '');
      if (n) return cjk`${n}出生那一夜，头顶是这样一片星空｜${BRAND}`;
      return own ? cjk`我出生那一夜，${p.city.name}的星空是这样的｜${BRAND}` : cjk`TA 出生那一夜，${p.city.name}的星空是这样的｜${BRAND}`;
    },
    invite: (a) => cjk`${nameOr(a, '有人')}想把你们来的那两夜，放进同一片天空｜${BRAND}`,
    result: (a, b, both) => {
      const A = nameOr(a, ''), B = nameOr(b, '');
      if (!A && !B) return `${fmtCount(both)} 颗星，曾照过我们两个人｜${BRAND}`;
      return cjk`${A || 'TA'}和${B || 'TA'}：${fmtCount(both)} 颗星，照过我们两个｜${BRAND}`;
    },
  },

  // S20 关于 (also the colophon of S10)
  about: {
    title: '关于',
    intro: '「你来的那晚」依据真实的天文数据推算，把你出生那一刻、那座城市上空的星，一颗一颗放回原处。',
    sections: [
      ['隐私', '所有计算都在你的手机上完成，你的生日、名字和城市不会上传。你分享或送出的链接里，带着填写的日期、时间、城市、名字和署名，只有收到链接的人能看到。'],
      ['赞助与合作', 'wojiaozyh123@gmail.com'],
      ['精度', '日月行星位置误差小于 1 角分；恒星位置为 J2000 历元并计入岁差。为了看得清，月亮画成实际大小的 2.2 倍；星星的大小与颜色经过处理，山脊是示意。'],
    ],
    // appended to 隐私 only while CONFIG.analytics is on (chrome.js)
    analytics: '我们用百度统计了解大致的访问量和使用情况，不包含你的生日、名字和城市。',
    dataLabel: '数据',
    data: [
      ['恒星', 'HYG Database v4.1 · CC BY-SA 4.0'],
      ['星座连线、中文星名、银河轮廓', 'd3-celestial · BSD · J. R. Vieira'],
      ['中国星官', 'Stellarium skycultures'],
      ['日月行星', 'Astronomy Engine · MIT'],
      ['城市', 'GeoNames · CC BY 4.0'],
      ['字体', '思源宋体（Noto Serif SC）子集、Cormorant Garamond · SIL OFL 1.1'],
      ['音乐', '在你的手机上实时合成'],
    ],
    close: '关闭',
  },

  // S21 异常
  fallback: {
    webgl: '这个浏览器，暂时点不亮这片星空。\n换用手机自带的浏览器，或更新微信后再试。',
    catalog: '载入失败，轻触重试',
    cities: '城市列表载入中…',
  },

  // §6 留存 · the text baked into exports
  export: {
    wordmark: BRAND,
    // 壁纸 L1; a guest export prefixes the friend's name
    wallDate: (p, guestName) => fmtWhen(p, { name: guestName || '' }),
    // 便签 L1 「1998.07.14  22:00」 (two spaces); unknown time → time null, night '夜里' (set in text 400)
    cardDate: (p) => `${fmtDot(p)}  ${fmtTime(p)}`,
    cardDateParts: (p) => ({ dot: fmtDot(p), time: p.unknownTime ? null : p.time, night: p.unknownTime ? '夜里' : null }),
    // 便签 L2 「杭州 · 小明来的那晚」 (no name: 「杭州」)
    cardPlace: (p, name) => {
      const n = nameOr(name ?? p.name, '');
      return n ? cjk`${p.city.name} · ${n}来的那一夜` : p.city.name;
    },
    qrCaption: '长按识别',
    // 星空贺卡 QR caption (poster.js giftCardText); the rest of the card's words are in T.gift
    giftQrCaption: GIFT.qrCaption,
    pairTitle: (nA, nB) => cjk`${nameOr(nA)}与${nameOr(nB)}`,
    pairCount: (both) => `${fmtCount(both)} 颗星，在我们两个人的夜里都亮过。`,
    pairVegaAltair: '隔河相望的织女星与牛郎星，也在其中。',
    pairDates: (a, b) => `${fmtDot(a)} ${a.city.name} ／ ${fmtDot(b)} ${b.city.name}`,
    pairWallTitle: (nA, nB, a, b) => `${nameOr(nA)}　${nameOr(nB)} · ${fmtDot(a)} ／ ${fmtDot(b)}`,
    pairWallCount: (both) => `${fmtCount(both)} 颗星，曾照过我们两个`,
    pairHorizon: (name) => cjk`${nameOr(name)}的地平线`,
  },

  // 送一张 · 星空贺卡 (see GIFT above)
  gift: GIFT,
};
