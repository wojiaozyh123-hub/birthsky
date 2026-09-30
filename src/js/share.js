// Share links carry everything needed to redraw a sky (no server): the person is packed into the URL.
//   ?p=<A>          someone's birth sky
//   ?h=<A>          an invitation to 星空合盘 with A
//   ?h=<A>&b=<B>    a finished 合盘 of A and B
import { toast } from './ui.js';
import { isValidTz } from './astro.js';

export const isWeChat = /MicroMessenger/i.test(navigator.userAgent);
export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Compact, versioned "1|name|YYYYMMDD|HHMM|unknown|city|region|lat|lon|tz" — short enough that the
// poster's QR code stays scannable after WeChat recompresses the image.
const clean = (s, n) => String(s || '').replace(/\|/g, ' ').slice(0, n);

export function encodePerson(p) {
  const c = p.city;
  return b64urlEncode([
    1, clean(p.name, 12), p.date.replace(/-/g, ''), p.time.replace(':', ''), p.unknownTime ? 1 : 0,
    clean(c.name, 24), clean(c.region, 24), c.lat.toFixed(2), c.lon.toFixed(2), c.tz,
  ].join('|'));
}

export function decodePerson(s) {
  try {
    const f = b64urlDecode(s).split('|');
    if (f[0] !== '1' || f.length < 10) return null;
    const [, name, d, t, u, city, region, la, lo, tz] = f;
    if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return null;
    const lat = +la, lon = +lo;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz) || !isValidTz(tz)) return null;
    return {
      name: name.slice(0, 12), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, time: `${t.slice(0, 2)}:${t.slice(2)}`,
      unknownTime: u === '1', city: { name: city.slice(0, 24), region: region.slice(0, 24), lat, lon, tz },
    };
  } catch {
    return null;
  }
}

export function baseUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function linkFor(kind, a, b) {
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
  if (p) { const A = decodePerson(p); if (A) return { kind: 'person', a: A }; }
  return { kind: null };
}

/** Make the address bar (which WeChat's ··· menu shares) point at `url`, and title the page. */
export function setShareTarget(url, title) {
  try { history.replaceState(null, '', url); } catch { /* file:// etc. */ }
  if (title) document.title = title;
}

let guideTimer = 0;
export function showWeChatGuide(text) {
  const g = document.getElementById('share-guide');
  if (text) document.getElementById('share-guide-text').innerHTML = text;
  g.classList.add('is-active');
  g.setAttribute('aria-hidden', 'false');
  clearTimeout(guideTimer);
  const close = () => { g.classList.remove('is-active'); g.setAttribute('aria-hidden', 'true'); g.removeEventListener('click', close); };
  g.addEventListener('click', close);
  guideTimer = setTimeout(close, 9000);
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
  toast(ok ? '链接已复制，发给朋友吧' : '长按地址栏复制链接');
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
