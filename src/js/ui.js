// Small DOM helpers and the line-icon set.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function show(el, on = true) {
  el = typeof el === 'string' ? $(el) : el;
  el.classList.toggle('is-active', on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}

let toastTimer = 0;
export function toast(text, ms = 2400) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  soundOn: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  soundOff: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  eye: svg('<path d="M2.5 16.5c3-5 6-7.5 9.5-7.5s6.5 2.5 9.5 7.5"/><path d="M2.5 19.5h19"/><circle cx="12" cy="4.5" r="0.6"/><circle cx="6.5" cy="6.5" r="0.5"/><circle cx="17.5" cy="6.5" r="0.5"/>'),
  dome: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="10" cy="9" r="0.6"/><circle cx="14.5" cy="13" r="0.6"/><circle cx="9" cy="14.5" r="0.5"/><path d="M10 9l4.5 4-5.5 1.5"/>'),
  listen: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 12l5.2-6.4"/><circle cx="8.5" cy="9.5" r="0.7"/><circle cx="14.5" cy="15.5" r="0.7"/><circle cx="9.5" cy="15" r="0.5"/>'),
  stop: svg('<circle cx="12" cy="12" r="8.5"/><rect x="9" y="9" width="6" height="6" rx="1"/>'),
  poster: svg('<rect x="5" y="3" width="14" height="18" rx="1.5"/><circle cx="12" cy="10" r="4.2"/><path d="M8.5 17h7"/>'),
  hepan: svg('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
  share: svg('<path d="M12 3.5v12"/><path d="M7.5 8L12 3.5 16.5 8"/><path d="M5 13v6.5h14V13"/>'),
  play: svg('<path d="M8 5.5v13l10-6.5z"/>'),
  pause: svg('<path d="M8.5 5.5v13M15.5 5.5v13"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  moon: svg('<path d="M15.5 3.5a8.5 8.5 0 1 0 5 12.5 7 7 0 0 1-5-12.5z"/>'),
  planet: svg('<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-18 12 12)"/>'),
  star: svg('<path d="M12 2.5l1.6 7.9 7.9 1.6-7.9 1.6-1.6 7.9-1.6-7.9-7.9-1.6 7.9-1.6z"/>'),
  light: svg('<circle cx="5" cy="12" r="1.6"/><path d="M8.5 12h12"/><path d="M17 8.5l3.5 3.5-3.5 3.5"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>'),
  zenith: svg('<path d="M12 21V6"/><path d="M8 10l4-4 4 4"/><path d="M4 21h16"/><circle cx="12" cy="3" r="1"/>'),
  count: svg('<circle cx="6" cy="7" r="0.8"/><circle cx="12" cy="5" r="1.2"/><circle cx="18" cy="8" r="0.8"/><circle cx="8" cy="13" r="1"/><circle cx="16" cy="14" r="1.3"/><circle cx="11" cy="19" r="0.8"/>'),
  leaf: svg('<path d="M5 19c0-8 5-14 14-14 0 9-6 14-14 14z"/><path d="M5 19l8-8"/>'),
};

export function icon(el, name) {
  if (typeof el === 'string') el = $(el);
  if (el) el.innerHTML = ICONS[name] || '';
}

export function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}
