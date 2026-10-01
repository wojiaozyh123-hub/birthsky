// Small DOM helpers, the toast, the one-time hint slot and the press feedback (spec §2.4, S6).
//
// Public API
//   $(sel, root = document)            querySelector
//   $$(sel, root = document)           querySelectorAll as an array
//   show(el, on = true)                toggles .is-active and aria-hidden on an element or selector
//   escapeHtml(s)                      escapes & < > " '
//   fmtNum(n)                          rounded, comma thousands: 4267 → '4,267'
//
//   toast(text, ms = 1600)             one caption-style line in #toast (no box): in 320 ms (enter curve),
//                                      holds `ms`, out 420 ms (exit curve). A new toast replaces the
//                                      current one. Created if #toast does not exist.
//
//   hint(key, text, { force, ms, hold }) → Promise<boolean>
//                                      A line in the hint slot (#hint-slot). Hints queue and play one at a
//                                      time: in 620 ms (opacity + 6 px rise), dwell, out 500 ms (opacity),
//                                      then ≥600 ms of silence before the next one.
//                                      dwell = hintDwell(text) = clamp(1.6 s + 0.16 s × characters, 3.2 s, 9 s),
//                                      or `ms` when given (e.g. 2000 for 「这一圈天，听完了。」).
//                                      `key` makes it a once-only hint: it is skipped when localStorage
//                                      `birthsky:hints` already has the key (unless `force`), and the key is
//                                      stored when the hint actually appears. key null = not remembered.
//                                      `hold: true` keeps it up until clearHint() (「正在绘制 1179 × 2556」).
//                                      Resolves true once it was shown and has gone, false if it was skipped
//                                      or cleared before it appeared.
//   clearHint()                        fades the current hint out now and drops the queue
//   hintSeen(key) → boolean            whether a once-only hint has been shown (or marked)
//   markHint(key)                      marks a once-only hint as done without showing it
//   hintDwell(text) → ms
//
//   press(target) → unbind()           press feedback for an element, a selector or a list: opacity .45
//                                      in 80 ms on pointerdown, back in 240 ms on release. No scale.
//                                      Adds .is-pressed while held.
//
// DOM/CSS contract: the text goes into an inline-block <span class="toast-text"> / <span class="hint-text">
// inside #toast / #hint-slot, and only that span is animated (inline opacity/transform). The stylesheet is
// free to position and style #toast and #hint-slot (font, colour alpha: toast α.90, hint α.62, subtitle
// shadow, z-index), including with transforms. #toast / #hint-slot get .is-on while showing; #hint-slot's
// parent gets .has-hint (the summary line shares that slot), and window receives a 'birthsky:hint'
// CustomEvent { key, text, on }. Text goes through noWidow(), so .nw { white-space: nowrap } must exist.

import { noWidow } from './copy.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function show(el, on = true) {
  el = typeof el === 'string' ? $(el) : el;
  if (!el) return;
  el.classList.toggle('is-active', on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

// ------------------------------------------------------------------------------------ motion tokens
const EASE_ENTER = 'cubic-bezier(0.22,1,0.36,1)';
const EASE_EXIT = 'cubic-bezier(0.4,0,1,1)';
const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Puts `text` into el as one animated span and returns the span. */
function textSpan(el, cls, text) {
  el.innerHTML = `<span class="${cls}" style="display:inline-block;max-width:100%;opacity:0">${noWidow(text)}</span>`;
  return el.firstElementChild;
}

function fadeIn(el, ms, rise) {
  const moving = rise && !reduced();
  el.style.transition = 'none';
  el.style.opacity = '0';
  el.style.transform = moving ? `translateY(${rise}px)` : 'none';
  void el.offsetWidth; // commit the start state so the transition runs
  el.style.transition = `opacity ${ms}ms ${EASE_ENTER}` + (moving ? `, transform ${ms}ms ${EASE_ENTER}` : '');
  el.style.opacity = '1';
  el.style.transform = 'none';
}

function fadeOut(el, ms) {
  el.style.transition = `opacity ${ms}ms ${EASE_EXIT}`;
  el.style.opacity = '0';
}

// ------------------------------------------------------------------------------------------- toast
const TOAST_IN = 320, TOAST_OUT = 420;
let toastTimer = 0, toastClear = 0;

function toastEl() {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  return el;
}

export function toast(text, ms = 1600) {
  const el = toastEl();
  clearTimeout(toastTimer);
  clearTimeout(toastClear);
  const span = textSpan(el, 'toast-text', text);
  el.classList.add('is-on');
  fadeIn(span, TOAST_IN, 6);
  toastTimer = setTimeout(() => {
    fadeOut(span, TOAST_OUT);
    el.classList.remove('is-on');
    toastClear = setTimeout(() => { el.textContent = ''; }, TOAST_OUT);
  }, TOAST_IN + ms);
}

// -------------------------------------------------------------------------------------------- hint
const HINT_IN = 620, HINT_OUT = 500, HINT_GAP = 600;
const HINTS_KEY = 'birthsky:hints';
let seenMem = null;          // mirror of localStorage, also the fallback when storage is unavailable
const queue = [];
let current = null;          // { key, text, resolve, timer }
let busyUntil = 0;           // end of the current hint's out-fade + silence (performance.now ms)
let pumpTimer = 0;

function seenSet() {
  if (seenMem) return seenMem;
  seenMem = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(HINTS_KEY) || '{}');
    for (const k of Array.isArray(raw) ? raw : Object.keys(raw)) seenMem.add(k);
  } catch { /* private mode or corrupt value: start empty */ }
  return seenMem;
}

export function markHint(key) {
  if (!key) return;
  const s = seenSet();
  s.add(key);
  try { localStorage.setItem(HINTS_KEY, JSON.stringify(Object.fromEntries([...s].map((k) => [k, 1])))); } catch { /* ignore */ }
}

export function hintSeen(key) {
  return !!key && seenSet().has(key);
}

const countChars = (text) => Array.from(String(text)).filter((c) => c.trim()).length;
export function hintDwell(text) {
  return Math.min(9000, Math.max(3200, 1600 + 160 * countChars(text)));
}

export function hint(key, text, { force = false, ms, hold = false } = {}) {
  if (key && !force && hintSeen(key)) return Promise.resolve(false);
  if (key && (current?.key === key || queue.some((q) => q.key === key))) return Promise.resolve(false);
  if (!document.getElementById('hint-slot')) return Promise.resolve(false);
  return new Promise((resolve) => {
    queue.push({ key, text, ms, hold, resolve });
    pump();
  });
}

function pump() {
  clearTimeout(pumpTimer);
  if (current || !queue.length) return;
  const wait = busyUntil - performance.now();
  if (wait > 0) { pumpTimer = setTimeout(pump, wait); return; }
  const el = document.getElementById('hint-slot');
  if (!el) { while (queue.length) queue.shift().resolve(false); return; }
  const h = current = queue.shift();
  if (h.key) markHint(h.key);
  h.span = textSpan(el, 'hint-text', h.text);
  el.classList.add('is-on');
  el.parentElement?.classList.add('has-hint');
  fadeIn(h.span, HINT_IN, 6);
  dispatch(h, true);
  if (!h.hold) h.timer = setTimeout(() => endHint(h), HINT_IN + (h.ms ?? hintDwell(h.text)));
}

function endHint(h) {
  if (current !== h) return;
  clearTimeout(h.timer);
  const el = document.getElementById('hint-slot');
  current = null;
  busyUntil = performance.now() + HINT_OUT + HINT_GAP;
  if (el) {
    if (h.span) fadeOut(h.span, HINT_OUT);
    el.classList.remove('is-on');
    setTimeout(() => {
      if (current) return; // a newer hint already took the slot
      el.textContent = '';
      el.parentElement?.classList.remove('has-hint');
    }, HINT_OUT);
  }
  dispatch(h, false);
  h.resolve(true);
  pump();
}

export function clearHint() {
  while (queue.length) queue.shift().resolve(false);
  if (current) endHint(current);
}

function dispatch(h, on) {
  try { window.dispatchEvent(new CustomEvent('birthsky:hint', { detail: { key: h.key, text: h.text, on } })); } catch { /* old WebViews */ }
}

// ------------------------------------------------------------------------------------------- press
const PRESS_DOWN = 80, PRESS_UP = 240;

function bindPress(el) {
  if (el.__pressOff) return el.__pressOff;
  let held = false, timer = 0;
  const down = (e) => {
    if ((e.button ?? 0) > 0 || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    held = true;
    clearTimeout(timer);
    el.classList.add('is-pressed');
    el.style.transition = `opacity ${PRESS_DOWN}ms ${EASE_EXIT}`;
    el.style.opacity = '0.45';
  };
  const up = () => {
    if (!held) return;
    held = false;
    el.classList.remove('is-pressed');
    el.style.transition = `opacity ${PRESS_UP}ms ${EASE_ENTER}`;
    el.style.opacity = '';
    timer = setTimeout(() => { if (!held) el.style.transition = ''; }, PRESS_UP + 20);
  };
  const evs = [['pointerdown', down], ['pointerup', up], ['pointercancel', up], ['pointerleave', up], ['blur', up]];
  for (const [t, f] of evs) el.addEventListener(t, f, { passive: true });
  el.__pressOff = () => {
    for (const [t, f] of evs) el.removeEventListener(t, f);
    clearTimeout(timer);
    el.classList.remove('is-pressed');
    el.style.opacity = '';
    el.style.transition = '';
    delete el.__pressOff;
  };
  return el.__pressOff;
}

export function press(target) {
  const els = typeof target === 'string' ? $$(target)
    : !target ? []
    : target.nodeType === 1 ? [target]
    : [...target];
  const offs = els.map(bindPress);
  return () => offs.forEach((off) => off());
}
