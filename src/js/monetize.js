// Ad/sponsor slots and analytics, both driven by config.js and inert until configured.
import { CONFIG } from './config.js';
import { escapeHtml } from './ui.js';

export function slotHtml(place) {
  const ads = CONFIG.ads;
  if (ads.provider === 'sponsor' && ads.sponsor.title) {
    const s = ads.sponsor;
    const safeUrl = /^https?:\/\//.test(s.url) ? s.url : '#';
    return `<a class="slot" data-slot="${place}" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener sponsored">
      ${s.image ? `<img src="${escapeHtml(s.image)}" alt="">` : '<span></span>'}
      <span><span class="slot-tag">${escapeHtml(s.tag || '赞助')}</span><h5>${escapeHtml(s.title)}</h5><p>${escapeHtml(s.text)}</p></span>
    </a>`;
  }
  if (ads.provider === 'adsense' && ads.adsense.client && ads.adsense.slot) {
    return `<div class="slot slot-adsense" data-slot="${place}"><ins class="adsbygoogle" style="display:block;width:100%" data-ad-client="${escapeHtml(ads.adsense.client)}" data-ad-slot="${escapeHtml(ads.adsense.slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
  }
  return '';
}

let adsenseLoaded = false;
export function activateSlots(root) {
  const ads = CONFIG.ads;
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

export function initAnalytics() {
  const a = CONFIG.analytics;
  if (a.provider === 'baidu' && a.baidu.id) {
    window._hmt = window._hmt || [];
    const s = document.createElement('script');
    s.src = `https://hm.baidu.com/hm.js?${encodeURIComponent(a.baidu.id)}`;
    document.head.appendChild(s);
  } else if (a.provider === 'umami' && a.umami.src && a.umami.websiteId) {
    const s = document.createElement('script');
    s.defer = true;
    s.src = a.umami.src;
    s.setAttribute('data-website-id', a.umami.websiteId);
    document.head.appendChild(s);
  }
}

/** Funnel events (start, arrive, poster, share, invite, hepan). No personal data is ever sent. */
export function track(event, label = '') {
  const a = CONFIG.analytics;
  try {
    if (a.provider === 'baidu' && window._hmt) window._hmt.push(['_trackEvent', 'birthsky', event, label]);
    else if (a.provider === 'umami' && window.umami) window.umami.track(event, label ? { label } : undefined);
  } catch { /* analytics must never break the page */ }
}
