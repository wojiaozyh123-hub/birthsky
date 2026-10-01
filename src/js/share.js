// Share links carry everything needed to redraw a sky (no server): the person is packed into the URL.
//   ?p=<A>          someone's birth sky
//   ?h=<A>          an invitation to 两个人 with A
//   ?h=<A>&b=<B>    a finished 两个人 of A and B
//
// Payload v2 (spec §6), written by encodePerson: '2' + base64url(bytes)
//   u16 days since 1900-01-01 · u16 minutes of day | 0x8000 when the time is unknown ·
//   i16 lat×100 · i16 lon×100 · UTF-8 "tz 0x1F city 0x1F name" (trailing empty fields dropped)
//   big-endian. The region is not carried (decoded region is '').
// Payload v1 ('1|name|YYYYMMDD|HHMM|unknown|city|region|lat|lon|tz', base64url; always starts with 'M')
// keeps decoding forever.
//
// Public API
//   isWeChat, isMobile
//   encodePerson(p) → string (v2; v1 only for dates outside 1900-01-01…2079-06-06)
//   decodePerson(s) → person | null (v1 or v2)
//   encodePersonV1(p) → string (legacy format, for tests)
//   baseUrl(), linkFor('person'|'invite'|'result', a, b), parseLink() → { kind, a, b }
//   setShareTarget(url, title)
//   shareFor('own'|'guest'|'invite'|'result', { person, a, b, both, nameB }) → { url, title, text, guide }
//   shareLink({ url, title, text, guide: [line1, line2] }) → 'wechat'|'native'|'cancel'|'copied'|'failed'
//   showWeChatGuide([line1, line2]) → close()   two plain-text lines; tap anywhere / 6 s / Esc closes
//   copyText(text) → Promise<boolean>
import { toast } from './ui.js';
import { isValidTz } from './astro.js';
import { T, graphemes } from './copy.js';

const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
export const isWeChat = /MicroMessenger/i.test(ua);
export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

const NAME_MAX = 12, CITY_MAX = 24;
const EPOCH = Date.UTC(1900, 0, 1);
const DAY_MS = 86400000;
const SEP = '\x1F';
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/;

// ---------------------------------------------------------------- base64url
function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad payload');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Trim, drop control characters, cap at n user-visible characters (never splits an emoji). */
const clean = (s, n) => graphemes(String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim()).slice(0, n).join('').trim();

const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- v2
export function encodePerson(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
  if (!(days >= 0 && days <= 0xffff)) return encodePersonV1(p);
  const [hh, mm] = p.time.split(':').map(Number);
  const mins = ((hh * 60 + mm) % 1440) | (p.unknownTime ? 0x8000 : 0);
  const c = p.city;
  const fields = [c.tz, clean(c.name, CITY_MAX), clean(p.name, NAME_MAX)];
  while (fields.length > 1 && !fields[fields.length - 1]) fields.pop();
  const text = new TextEncoder().encode(fields.join(SEP));
  const buf = new Uint8Array(8 + text.length);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, days);
  dv.setUint16(2, mins);
  dv.setInt16(4, Math.round(c.lat * 100));
  dv.setInt16(6, Math.round(c.lon * 100));
  buf.set(text, 8);
  return `2${bytesToB64url(buf)}`;
}

function decodeV2(s) {
  const bytes = b64urlToBytes(s);
  if (bytes.length < 9) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const days = dv.getUint16(0);
  const raw = dv.getUint16(2);
  const unknownTime = (raw & 0x8000) !== 0;
  const mins = raw & 0x7fff;
  if (mins >= 1440) return null;
  const lat = dv.getInt16(4) / 100, lon = dv.getInt16(6) / 100;
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
  const [tz = '', city = '', name = ''] = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8)).split(SEP);
  if (!TZ_RE.test(tz) || !isValidTz(tz)) return null;
  const dt = new Date(EPOCH + days * DAY_MS);
  return {
    name: clean(name, NAME_MAX),
    date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`,
    time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`,
    unknownTime,
    city: { name: clean(city, CITY_MAX), region: '', lat, lon, tz },
  };
}

// ---------------------------------------------------------------- v1 (legacy)
const cleanV1 = (s, n) => clean(String(s || '').replace(/\|/g, ' '), n);

export function encodePersonV1(p) {
  const c = p.city;
  const raw = [1, cleanV1(p.name, NAME_MAX), p.date.replace(/-/g, ''), p.time.replace(':', ''), p.unknownTime ? 1 : 0,
    cleanV1(c.name, CITY_MAX), cleanV1(c.region, CITY_MAX), c.lat.toFixed(2), c.lon.toFixed(2), c.tz].join('|');
  return bytesToB64url(new TextEncoder().encode(raw));
}

function decodeV1(s) {
  const f = new TextDecoder().decode(b64urlToBytes(s)).split('|');
  if (f[0] !== '1' || f.length < 10) return null;
  const [, name, d, t, u, city, region, la, lo, tz] = f;
  if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return null;
  const lat = +la, lon = +lo;
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !TZ_RE.test(tz) || !isValidTz(tz)) return null;
  return {
    name: clean(name, NAME_MAX), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, time: `${t.slice(0, 2)}:${t.slice(2)}`,
    unknownTime: u === '1', city: { name: clean(city, CITY_MAX), region: clean(region, CITY_MAX), lat, lon, tz },
  };
}

export function decodePerson(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    return s[0] === '2' ? decodeV2(s.slice(1)) : decodeV1(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- links
export function baseUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** A gift card's sender name, carried as &f= so the receiver's intro can say who sent the sky. */
function encodeFrom(name) {
  const n = clean(name, NAME_MAX);
  return n ? bytesToB64url(new TextEncoder().encode(n)) : '';
}
function decodeFrom(s) {
  try { return s ? clean(new TextDecoder().decode(b64urlToBytes(s)), NAME_MAX) : ''; } catch { return ''; }
}

/**
 * kind 'person' | 'invite' | 'result' | 'gift'. A gift link is a person link for the friend (a) plus the
 * sender's name: linkFor('gift', friend, null, { from: '小明' }).
 */
export function linkFor(kind, a, b, { from = '' } = {}) {
  if (kind === 'gift') {
    const f = encodeFrom(from);
    return `${baseUrl()}?p=${encodePerson(a)}${f ? `&f=${f}` : ''}`;
  }
  if (kind === 'person') return `${baseUrl()}?p=${encodePerson(a)}`;
  if (kind === 'invite') return `${baseUrl()}?h=${encodePerson(a)}`;
  if (kind === 'result') return `${baseUrl()}?h=${encodePerson(a)}&b=${encodePerson(b)}`;
  return baseUrl();
}

export function parseLink() {
  const q = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const get = (k) => q.get(k) || hash.get(k);
  const p = get('p'), h = get('h'), b = get('b');
  if (h && b) {
    const A = decodePerson(h), B = decodePerson(b);
    if (A && B) return { kind: 'result', a: A, b: B };
  }
  if (h) { const A = decodePerson(h); if (A) return { kind: 'invite', a: A }; }
  if (p) {
    const A = decodePerson(p);
    if (A) {
      const from = decodeFrom(get('f'));
      return from ? { kind: 'gift', a: A, from } : { kind: 'person', a: A };
    }
  }
  return { kind: null };
}

/** Make the address bar (which WeChat's ··· menu shares) point at `url`, and title the page. */
export function setShareTarget(url, title) {
  try { history.replaceState(null, '', url); } catch { /* file:// etc. */ }
  if (title) document.title = title;
}

/** Everything shareLink() needs for one of the four share kinds (S19 copy). */
export function shareFor(kind, { person, a, b, both = 0, nameB } = {}) {
  if (kind === 'invite') {
    const A = a || person;
    return { url: linkFor('invite', A), title: T.titles.invite(A), text: T.share.inviteText, guide: T.share.guide('invite') };
  }
  if (kind === 'result') {
    return { url: linkFor('result', a, b), title: T.titles.result(a, b, both), text: T.share.inviteText,
      guide: T.share.guide('result', nameB || b?.name) };
  }
  const own = kind !== 'guest';
  return { url: linkFor('person', person), title: T.titles.person(person, { own }), text: T.share.text, guide: T.share.guide(own ? 'own' : 'guest') };
}

// ---------------------------------------------------------------- WeChat guide
let guideTimer = 0;
let guideClose = null;

function guideLines(g) {
  let l1 = g.querySelector('#share-guide-l1'), l2 = g.querySelector('#share-guide-l2');
  if (l1 && l2) return [l1, l2];
  // older markup: replace the single #share-guide-text with two paragraphs
  g.querySelector('#share-guide-text')?.remove();
  l1 = document.createElement('p'); l1.id = 'share-guide-l1'; l1.className = 'l1';
  l2 = document.createElement('p'); l2.id = 'share-guide-l2'; l2.className = 'l2';
  g.append(l1, l2);
  return [l1, l2];
}

export function showWeChatGuide(lines) {
  const g = document.getElementById('share-guide');
  if (!g) return () => {};
  if (!Array.isArray(lines)) lines = lines ? [T.share.guide1, String(lines)] : T.share.guide('own');
  const [e1, e2] = guideLines(g);
  e1.textContent = lines[0] || T.share.guide1;
  e2.textContent = lines[1] || '';
  guideClose?.();
  // restart the one-shot arc drawing
  g.classList.remove('is-active');
  void g.offsetWidth;
  g.classList.add('is-active');
  g.setAttribute('aria-hidden', 'false');
  const close = () => {
    clearTimeout(guideTimer);
    g.classList.remove('is-active');
    g.setAttribute('aria-hidden', 'true');
    document.removeEventListener('pointerdown', close, true);
    document.removeEventListener('keydown', onKey, true);
    if (guideClose === close) guideClose = null;
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('pointerdown', close, true);
  document.addEventListener('keydown', onKey, true);
  guideTimer = setTimeout(close, 6000);
  guideClose = close;
  return close;
}

/**
 * Share a link the way the current browser allows: WeChat → point the page at the link and show the
 * "tap ··· top-right" guide; phones → native share sheet; desktop → copy to clipboard.
 */
export async function shareLink({ url, title, text, guide }) {
  setShareTarget(url, title);
  if (isWeChat) {
    showWeChatGuide(guide);
    return 'wechat';
  }
  if (navigator.share && isMobile) {
    try {
      await navigator.share({ title, text, url });
      return 'native';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancel';
    }
  }
  const ok = await copyText(url);
  toast(ok ? T.share.copied : T.share.copyFailed);
  return ok ? 'copied' : 'failed';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
