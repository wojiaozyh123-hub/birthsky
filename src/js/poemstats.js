// How many people received the same poem. A tiny counter service (server/README.md) keeps one number
// per poem id — nothing else: no birthday, name, city or device id is ever sent. Off until
// CONFIG.poemStats.url is set; while off (or offline) every function resolves to null and the UI shows
// nothing, so a count is never invented.
//
// API
//   statsEnabled() → boolean
//   recordPoem(id, personKey) → Promise<number|null>   counts this person once per browser for that poem
//   poemCountFor(id) → Promise<number|null>            cached for 5 minutes
//   countLine(n) → ''                                  no count
//                → '你是第一个遇见这一句的人。'          n ≤ 1
//                → '遇见这一句的，还有 1,233 人。'       n > 1 (the others, not counting you)
import { CONFIG } from './config.js';

const ID = /^p\d{3,4}$/;
const HITS_KEY = 'birthsky:poem-hits';
const TTL = 5 * 60 * 1000;
const cache = new Map(); // id → { n, t }

function cfg() {
  const c = CONFIG.poemStats || {};
  return { url: String(c.url || '').replace(/\/+$/, ''), provider: c.provider || (c.url ? 'http' : 'none') };
}

export function statsEnabled() {
  const c = cfg();
  return c.provider !== 'none' && /^https:\/\//.test(c.url);
}

async function call(path, init) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(cfg().url + path, { ...init, signal: ctl?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const j = await r.json();
    return Number.isFinite(j?.count) ? j.count : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hits() {
  try { return JSON.parse(localStorage.getItem(HITS_KEY) || '{}') || {}; } catch { return {}; }
}

export async function recordPoem(id, personKey) {
  if (!statsEnabled() || !ID.test(id)) return null;
  const key = `${id}|${personKey || ''}`;
  const h = hits();
  if (h[key]) return poemCountFor(id);
  const n = await call('/hit', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ id }) });
  if (n !== null) {
    h[key] = 1;
    try { localStorage.setItem(HITS_KEY, JSON.stringify(h)); } catch { /* private mode: may count again next visit */ }
    cache.set(id, { n, t: Date.now() });
  }
  return n;
}

export async function poemCountFor(id) {
  if (!statsEnabled() || !ID.test(id)) return null;
  const c = cache.get(id);
  if (c && Date.now() - c.t < TTL) return c.n;
  const n = await call(`/count?id=${encodeURIComponent(id)}`);
  if (n !== null) cache.set(id, { n, t: Date.now() });
  return n;
}

export function countLine(n) {
  if (!Number.isFinite(n) || n < 1) return '';
  if (n <= 1) return '你是第一个与这一句相逢的人。';
  return `还有 ${(n - 1).toLocaleString('en-US')} 人，也与这一句相逢过。`;
}
