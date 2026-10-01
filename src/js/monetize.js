// Ad/sponsor slots and analytics, both driven by config.js and inert until configured (spec §10.1, §10.2).
//
// Public API
//   slotHtml(place) → html      place: 'night' | 'pair' | 'keep'. '' when the provider is 'none', the
//                               placement is off, or nothing is configured — so the layout keeps no gap.
//       night / pair  <a class="ad-row">: 0.5 px rule on top, optional 44×44 square image, 「赞助」 (11, α.40),
//                     title (15/22, α.88), one line of text (12/18, α.52); the whole row is one link, ≥44 px.
//                     AdSense (if ever enabled) renders its <ins> here only.
//       keep          <a class="ad-line">: one text line 「赞助　{title}」 (12, α.46). Never drawn into exports.
//   activateSlots(root)         after inserting slotHtml() into root: binds track('ad_click', place) on the
//                               links and fills AdSense <ins> (loading its script once).
//   sponsor() → { tag, title, text, image, url } | null     the configured sponsor, for custom layouts
//   initAnalytics()             loads 百度统计 / Umami / 不蒜子 when configured (once)
//   track(event, label = '')    funnel event, never with personal data; see EVENTS (不蒜子 has no events: no-op)
//   EVENTS                      the event names the app sends
//
// The row styles ship with this module (a small <style> prepended to <head>, so main.css can override them
// with rules of equal specificity). Containers: #night-slot, #pair-slot, #keep-slot (shell).
import { CONFIG } from './config.js';
import { escapeHtml } from './ui.js';

export const EVENTS = Object.freeze(['start', 'rewind', 'arrive', 'caption_next', 'plate_open', 'ruler_open', 'listen',
  'keep_open', 'keep_done', 'share', 'pair_invite', 'pair_result', 'guest_mine', 'ad_click', 'gift_open', 'gift_done', 'print_open', 'print_copy', 'print_shop', 'tip_open']);

const PLACES = ['night', 'pair', 'keep'];
const LEGACY = { facts: 'night', hepan: 'pair' }; // pre-v3 names

const safeUrl = (u) => (/^(https?:\/\/|mailto:)/i.test(u || '') ? u : '');

export function sponsor() {
  const ads = CONFIG.ads || {};
  const s = ads.sponsor || {};
  if (ads.provider !== 'sponsor' || !s.title) return null;
  return { tag: s.tag || '赞助', title: s.title, text: s.text || '', image: s.image || '', url: safeUrl(s.url) };
}

function placementOn(place) {
  const p = CONFIG.ads?.placements;
  return !p || p[place] !== false;
}

export function slotHtml(place) {
  place = LEGACY[place] || place;
  const ads = CONFIG.ads || {};
  if (!PLACES.includes(place) || ads.provider === 'none' || !placementOn(place)) return '';
  ensureStyle();

  if (ads.provider === 'sponsor') {
    const s = sponsor();
    if (!s) return '';
    const tag = s.url ? 'a' : 'div';
    const link = s.url ? ` href="${escapeHtml(s.url)}" target="_blank" rel="noopener sponsored"` : '';
    if (place === 'keep') {
      return `<${tag} class="ad-line" data-slot="keep"${link}>${escapeHtml(s.tag)}　${escapeHtml(s.title)}</${tag}>`;
    }
    return `<${tag} class="ad-row" data-slot="${place}"${link}>`
      + (s.image ? `<img class="ad-img" src="${escapeHtml(s.image)}" alt="" width="44" height="44" loading="lazy">` : '')
      + `<span class="ad-body"><span class="ad-tag">${escapeHtml(s.tag)}</span>`
      + `<span class="ad-title">${escapeHtml(s.title)}</span>`
      + (s.text ? `<span class="ad-text">${escapeHtml(s.text)}</span>` : '')
      + `</span></${tag}>`;
  }

  if (ads.provider === 'adsense' && place !== 'keep' && ads.adsense?.client && ads.adsense?.slot) {
    return `<div class="ad-row ad-adsense" data-slot="${place}"><ins class="adsbygoogle" style="display:block;width:100%"`
      + ` data-ad-client="${escapeHtml(ads.adsense.client)}" data-ad-slot="${escapeHtml(ads.adsense.slot)}"`
      + ' data-ad-format="auto" data-full-width-responsive="true"></ins></div>';
  }
  return '';
}

let adsenseLoaded = false;
export function activateSlots(root) {
  if (!root) return;
  const SEL = '.ad-row[data-slot], .ad-line[data-slot]';
  const slots = [...(root.matches?.(SEL) ? [root] : []), ...root.querySelectorAll(SEL)];
  for (const el of slots) {
    if (el.dataset.bound) continue;
    el.dataset.bound = '1';
    el.addEventListener('click', () => track('ad_click', el.dataset.slot));
  }
  const ads = CONFIG.ads || {};
  if (ads.provider !== 'adsense' || !root.querySelector('.adsbygoogle')) return;
  if (!adsenseLoaded) {
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.adsense.client)}`;
    document.head.appendChild(s);
    adsenseLoaded = true;
  }
  root.querySelectorAll('.adsbygoogle:not([data-done])').forEach((el) => {
    el.setAttribute('data-done', '1');
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* blocked */ }
  });
}

// the rows in the v3 visual language: warm-white type on the plate, hairline rule, no radius, no card
const STYLE = `
.ad-row{position:relative;display:flex;align-items:center;gap:12px;min-height:44px;margin:0;padding:16px 0;color:#EFE8DA;text-decoration:none;-webkit-tap-highlight-color:transparent}
.ad-row::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:rgba(239,232,218,.10);transform:scaleY(.5);transform-origin:0 0}
.ad-img{flex:none;width:44px;height:44px;border-radius:0;object-fit:cover}
.ad-body{display:flex;flex-direction:column;min-width:0}
.ad-tag{font-size:11px;line-height:16px;letter-spacing:.04em;color:rgba(239,232,218,.40)}
.ad-title{font-size:15px;line-height:22px;letter-spacing:.02em;color:rgba(239,232,218,.88)}
.ad-text{font-size:12px;line-height:18px;letter-spacing:.02em;color:rgba(239,232,218,.52);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ad-adsense{display:block}
.ad-line{display:inline-block;min-height:44px;line-height:44px;font-size:12px;letter-spacing:.04em;color:rgba(239,232,218,.46);text-decoration:none}
`;
function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('ad-style')) return;
  const el = document.createElement('style');
  el.id = 'ad-style';
  el.textContent = STYLE;
  document.head.prepend(el);
}

let analyticsOn = false;
export function initAnalytics() {
  const a = CONFIG.analytics;
  if (analyticsOn) return;
  if (a.provider === 'busuanzi') {
    // one page view per load; no counter shown, no events; a failure is silent
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js';
    s.onerror = () => s.remove();
    document.head.appendChild(s);
    analyticsOn = true;
  } else if (a.provider === 'baidu' && a.baidu.id) {
    window._hmt = window._hmt || [];
    const s = document.createElement('script');
    s.src = `https://hm.baidu.com/hm.js?${encodeURIComponent(a.baidu.id)}`;
    document.head.appendChild(s);
    analyticsOn = true;
  } else if (a.provider === 'umami' && a.umami.src && a.umami.websiteId) {
    const s = document.createElement('script');
    s.defer = true;
    s.src = a.umami.src;
    s.setAttribute('data-website-id', a.umami.websiteId);
    document.head.appendChild(s);
    analyticsOn = true;
  }
}

/** Funnel events (see EVENTS). No personal data is ever sent: labels are fixed words like 'own' / 'guest'. */
export function track(event, label = '') {
  const a = CONFIG.analytics;
  try {
    if (a.provider === 'baidu' && window._hmt) window._hmt.push(['_trackEvent', 'birthsky', event, label]);
    else if (a.provider === 'umami' && window.umami) window.umami.track(event, label ? { label } : undefined);
  } catch { /* analytics must never break the page */ }
}
