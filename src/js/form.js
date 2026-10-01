// S3 填写 and S3b 选择城市 (spec §4): the birthday form set straight on the dark ground, typed numeric date and
// time fields with auto-advance, validation copy in a reserved line, and the full-screen city page.
//
// Public API
//   new Form(app = {})                   app.me (stored person), app.cities (cities.js module, optional — loaded
//                                        on demand otherwise), app.citiesUrl, app.chrome (optional: scene('form'))
//   form.open(kind = 'self', ctx = {}) → Promise<person | 'back' | null>
//       kind  'self'           你是哪一天来的？ · 出发
//             'hepan-self'     invite, no stored birthday: over-line 「小明想知道你来的那天」 · 出发
//             'hepan-confirm'  invite, stored birthday: 「小明想和你一起抬头」 · 是这一天吗？ · read-only line ·
//                              就用这个 (resolves ctx.me) · 换一个生日 (switches to 'hepan-self' with empty fields)
//             'partner'        TA 是哪一天来的？ · TA 的名字（可不填） · 放在一起看 (never stored)
//       ctx   { inviter: person (for the over-line name), me: person (prefill / confirm), empty: bool
//               (换一个生日: start with empty fields), delay: ms before the fields enter (default 300) }
//       Resolves with the person { name, date: 'YYYY-MM-DD', time: 'HH:MM', unknownTime, city: { name, region,
//       lat, lon, tz } } once the column has left (420 ms), 'back' for 返回, null when superseded by close().
//       'self' and 'hepan-self' also store the person as `me` (localStorage birthsky:me, and app.me).
//   form.close() → Promise               leave without a result (resolves a pending open() with null)
//   form.openCity() → Promise<city | null>   the S3b page on its own
//   form.validate() → { person } | { error }  (the copy of T.form.errors)
//   form.isOpen, form.kind
//   checkBirth(fields, now) → { person } | { error }   pure validation (exported for tests)
//   cityFromResult(cities.js result) → { name, region, lat, lon, tz }
import { $, $$, press } from './ui.js';
import { T, graphemes, fmtWhen, nameOr } from './copy.js';
import { zonedToUtc } from './astro.js';

const E = { enter: 'cubic-bezier(0.22,1,0.36,1)', exit: 'cubic-bezier(0.4,0,1,1)' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const NAME_MAX = 12;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Pure validation (spec S3 order): incomplete → invalid → before 1900 → future → no city. */
export function checkBirth({ y = '', m = '', d = '', hh = '22', mm = '00', unknown = false, city = null, name = '' }, nowDate = new Date()) {
  const errs = T.form.errors;
  if (String(y).length !== 4 || !String(m).length || !String(d).length) return { error: errs.incomplete };
  const Y = +y, M = +m, D = +d;
  const t = new Date(Date.UTC(Y, M - 1, D));
  if (!(M >= 1 && M <= 12 && D >= 1) || t.getUTCFullYear() !== Y || t.getUTCMonth() !== M - 1 || t.getUTCDate() !== D) return { error: errs.invalid };
  if (Y < 1900) return { error: errs.tooEarly };
  const H = unknown ? 22 : Math.min(23, +(String(hh).length ? hh : 22));
  const Mi = unknown ? 0 : Math.min(59, +(String(mm).length ? mm : 0));
  const date = `${Y}-${pad(M)}-${pad(D)}`, time = `${pad(H)}:${pad(Mi)}`;
  if (city?.tz) {
    let at;
    try { at = zonedToUtc(Y, M, D, H, Mi, city.tz); } catch { at = null; }
    if (at && at.getTime() > nowDate.getTime()) return { error: errs.future };
  } else {
    const today = `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;
    if (date > today) return { error: errs.future };
  }
  if (!city) return { error: errs.city };
  return { person: { name: graphemes(String(name).trim()).slice(0, NAME_MAX).join(''), date, time, unknownTime: !!unknown, city } };
}

/** A cities.js result → the stored city object (region = what the row showed after the name). */
export function cityFromResult(c) {
  const parts = String(c.label || '').split(' · ');
  const region = parts.length > 1 && parts[0] === c.name ? parts.slice(1).join(' · ') : (c.region || (c.cc !== 'CN' ? c.country || '' : ''));
  return { name: c.name, region, lat: c.lat, lon: c.lon, tz: c.tz };
}

// digit fields: [id, max length, first digit above which the second is impossible]
const DIGITS = [['f-y', 4, null], ['f-m', 2, 1], ['f-d', 2, 3], ['f-hh', 2, 2], ['f-mm', 2, 5]];

export class Form {
  constructor(app = {}) {
    this.app = app;
    const q = (id) => document.getElementById(id);
    this.el = {
      root: q('form'), col: q('form-col'), back: q('form-back'), over: q('form-over'), title: q('form-title'), edit: q('form-edit'),
      nameLabel: q('f-name-label'), name: q('f-name'), time: q('f-time'), unknown: q('f-unknown'), city: q('f-city'), cityValue: q('f-city-value'),
      confirm: q('form-confirm'), confirmLine: q('f-confirm-line'), err: q('f-err'), go: q('btn-go'), go2: q('btn-go-2'), fine: q('f-fine'),
      page: q('city-page'), q: q('city-q'), cancel: q('city-cancel'), head: q('city-head'), list: q('city-list'), note: q('city-note'), scroll: q('city-scroll'),
    };
    this.f = DIGITS.map(([id, max, first]) => ({ el: q(id), max, first }));
    this.kind = 'self';
    this.ctx = {};
    this.cityVal = null;
    this.isOpen = false;
    this._resolve = null;
    this._cityResolve = null;
    this._items = [];
    this._hl = -1;
    this._bind();
  }

  // ------------------------------------------------------------------------------------ open / close
  open(kind = 'self', ctx = {}) {
    this._resolve?.(null);
    this.kind = kind;
    this.ctx = ctx || {};
    this.isOpen = true;
    this._render(true);
    this.app.chrome?.scene?.('form');
    this._show(this.ctx.delay ?? 300);
    return new Promise((r) => { this._resolve = r; });
  }

  async close(result = null) {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.activeElement?.blur?.();
    const r = this._resolve;
    this._resolve = null;
    await this._hide();
    r?.(result);
  }

  _render(fill) {
    const { el } = this;
    const k = this.kind, F = T.form;
    const inviter = this.ctx.inviter;
    const me = this.ctx.me ?? this.app.me ?? null;
    const confirm = k === 'hepan-confirm' && me;
    const gift = k === 'gift', G = T.gift;
    el.over.hidden = !(k === 'hepan-self' || confirm || gift);
    el.over.textContent = gift ? G.formOver : k === 'hepan-self' ? F.inviteOver(nameOr(inviter, 'TA')) : confirm ? F.confirmOver(nameOr(inviter, 'TA')) : '';
    el.title.textContent = gift ? G.formTitle : k === 'partner' ? F.partnerTitle : confirm ? F.confirmTitle : F.title;
    el.edit.hidden = !!confirm;
    el.confirm.hidden = !confirm;
    if (confirm) el.confirmLine.textContent = F.confirmLine(me);
    el.nameLabel.textContent = gift ? G.toLabel : k === 'partner' ? F.partnerNameLabel : F.nameLabel;
    el.name.placeholder = gift ? G.toPlaceholder : F.namePlaceholder;
    el.go.querySelector('.lbl').textContent = gift ? G.go : k === 'partner' ? F.partnerGo : confirm ? F.confirmGo : F.go;
    if (el.fine) el.fine.textContent = gift ? G.fine : F.fine;
    el.go2.hidden = !confirm;
    el.go2.textContent = F.confirmOther;
    this._error('');
    if (!fill) return;
    let src = null;
    if (!this.ctx.empty) src = k === 'self' || k === 'hepan-confirm' ? me : k === 'hepan-self' ? this.ctx.me || null : null;
    this._fill(src);
  }

  _fill(p) {
    const [y, m, d] = p?.date ? p.date.split('-') : ['', '', ''];
    const [hh, mm] = p?.time ? p.time.split(':') : ['22', '00'];
    this.el.name.value = p?.name || '';
    const vals = [y, m, d, hh, mm];
    this.f.forEach((x, i) => { x.el.value = vals[i] || ''; x.el.classList.toggle('is-empty', !x.el.value); });
    this._setUnknown(!!p?.unknownTime);
    this._setCity(p?.city || null);
  }

  _show(delay) {
    const { root, col } = this.el;
    clearTimeout(root._t);
    root.classList.add('on');
    root.setAttribute('aria-hidden', 'false');
    col.scrollTop = 0;
    col.classList.remove('is-scrolled');
    const kids = $$('.fx', root).filter((k) => !k.hidden && !k.closest('[hidden]'));
    kids.forEach((k) => { k.classList.remove('on'); k.style.removeProperty('--delay'); });
    void root.offsetWidth;
    root._t = setTimeout(() => {
      kids.forEach((k, i) => {
        k.style.setProperty('--delay', `${Math.min(i, 5) * 90}ms`);
        k.style.setProperty('--out', '420ms');
        k.classList.add('on');
      });
    }, delay);
  }

  _hide() {
    const { root } = this.el;
    clearTimeout(root._t);
    $$('.fx', root).forEach((k) => { k.style.setProperty('--delay', '0ms'); k.classList.remove('on'); });
    root.setAttribute('aria-hidden', 'true');
    return new Promise((r) => { root._t = setTimeout(() => { root.classList.remove('on'); r(); }, 420); });
  }

  // ------------------------------------------------------------------------------------ bindings
  _bind() {
    const { el } = this;
    press([el.back, el.go, el.go2, el.unknown, el.city, el.cancel].filter(Boolean));
    el.back?.addEventListener('click', () => this.close('back'));
    el.go?.addEventListener('click', () => this.submit());
    el.go2?.addEventListener('click', () => {
      // 换一个生日 in the confirm version: the same form, fields empty
      this.kind = 'hepan-self';
      this.ctx = { ...this.ctx, empty: true };
      this._render(true);
      this._show(0);
    });
    el.unknown?.addEventListener('click', () => { this._setUnknown(el.unknown.getAttribute('aria-checked') !== 'true'); this._error(''); });
    el.city?.addEventListener('click', async () => {
      const c = await this.openCity();
      if (c) { this._setCity(c); this._error(''); }
    });

    // name: at most 12 characters (graphemes), never cut in the middle of an IME composition
    let composing = false;
    el.name?.addEventListener('compositionstart', () => { composing = true; });
    el.name?.addEventListener('compositionend', () => { composing = false; this._capName(); });
    el.name?.addEventListener('input', () => { if (!composing) this._capName(); this._error(''); });
    el.name?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.f[0].el.focus(); } });

    this.f.forEach((x, i) => {
      const inp = x.el;
      if (!inp) return;
      inp.addEventListener('focus', () => this._reveal(inp));
      // typing into a full field starts it again (instead of select-on-focus, which races the keyboard)
      inp.addEventListener('beforeinput', (e) => {
        if (!/^insert/.test(e.inputType || '') || inp.readOnly) return;
        if (inp.value.length >= x.max && inp.selectionStart === inp.selectionEnd) inp.value = '';
      });
      inp.addEventListener('input', (e) => this._digits(i, !/^delete/.test(e.inputType || '')));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && inp.value === '' && i > 0) {
          const prev = this._prev(i);
          if (prev) { e.preventDefault(); this._focusEnd(prev.el); }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const nx = this._next(i);
          if (nx) nx.el.focus(); else inp.blur();
        }
      });
      inp.addEventListener('blur', () => {
        if (i > 0 && inp.value.length === 1) inp.value = `0${inp.value}`;
        if (i === 3 && +inp.value > 23) inp.value = '23';
        if (i === 4 && +inp.value > 59) inp.value = '59';
      });
      inp.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
        const groups = text.match(/\d+/g);
        if (!groups || groups.length < 2) return;
        e.preventDefault();
        groups.slice(0, this.f.length - i).forEach((g, k) => {
          const f = this.f[i + k];
          if (f && !f.el.readOnly) { f.el.value = g.slice(0, f.max); f.el.classList.toggle('is-empty', !f.el.value); }
        });
        this._error('');
      });
    });

    // S3b
    el.cancel?.addEventListener('click', () => this._closeCity(null));
    el.q?.addEventListener('input', () => this._search());
    el.q?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this._items.length) return;
        this._hl = (this._hl + (e.key === 'ArrowDown' ? 1 : -1) + this._items.length) % this._items.length;
        this._paintHl(true);
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (this._items[this._hl]) this._closeCity(this._items[this._hl]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._closeCity(null);
      }
    });
    el.list?.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) this._closeCity(this._items[+li.dataset.i]);
    });
  }

  _capName() {
    const inp = this.el.name;
    const g = graphemes(inp.value);
    if (g.length > NAME_MAX) inp.value = g.slice(0, NAME_MAX).join('');
  }

  _reveal(inp) {
    const field = inp.closest('.field, .f-row') || inp;
    const go = () => { try { field.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { field.scrollIntoView(false); } };
    setTimeout(go, 60);
    setTimeout(go, 360); // after the keyboard has come up
  }

  _enabled(x) { return x && !x.el.readOnly && !x.el.disabled; }
  _next(i) { for (let k = i + 1; k < this.f.length; k++) if (this._enabled(this.f[k])) return this.f[k]; return null; }
  _prev(i) { for (let k = i - 1; k >= 0; k--) if (this._enabled(this.f[k])) return this.f[k]; return null; }
  _focusEnd(inp) {
    inp.focus();
    setTimeout(() => { try { const n = inp.value.length; inp.setSelectionRange(n, n); } catch { /* ignore */ } }, 0);
  }

  /**
   * Digits only, overflow into the next field, auto-advance at 4/2/2/2/2 or after one digit that makes a second
   * impossible (月 > 1, 日 > 3, 时 > 2, 分 > 5). Deleting never pads or advances.
   */
  _digits(i, typed = true) {
    const x = this.f[i];
    let v = x.el.value.replace(/\D+/g, '');
    let rest = '';
    if (v.length > x.max) { rest = v.slice(x.max); v = v.slice(0, x.max); }
    if (typed && v.length === 1 && x.first !== null && +v > x.first) v = `0${v}`;
    if (x.el.value !== v) x.el.value = v;
    x.el.classList.toggle('is-empty', !v);
    this._error('');
    if (!typed || v.length < x.max) return;
    const nx = this._next(i);
    if (!nx) { if (!rest) x.el.blur(); return; }
    if (rest) {
      nx.el.value = rest;
      nx.el.focus();
      this._digits(this.f.indexOf(nx));
    } else {
      nx.el.focus();
    }
  }

  _setUnknown(on) {
    const { unknown, time } = this.el;
    unknown.setAttribute('aria-checked', on ? 'true' : 'false');
    time.classList.toggle('is-off', on);
    for (const x of this.f.slice(3)) {
      x.el.readOnly = on;
      x.el.tabIndex = on ? -1 : 0;
      x.el.setAttribute('aria-disabled', on ? 'true' : 'false');
    }
    if (on) { this.f[3].el.value = '22'; this.f[4].el.value = '00'; this.f[3].el.classList.remove('is-empty'); this.f[4].el.classList.remove('is-empty'); }
  }

  _setCity(c) {
    this.cityVal = c;
    const v = this.el.cityValue;
    v.textContent = c ? T.form.cityValue(c) : T.form.cityPlaceholder;
    v.classList.toggle('is-empty', !c);
  }

  _error(text) {
    const e = this.el.err;
    if (!e) return;
    if (!text) { e.classList.remove('on'); return; }
    e.textContent = text;
    void e.offsetWidth;
    e.classList.add('on');
  }

  /** Reads the fields; { person } or { error }. */
  validate(nowDate = new Date()) {
    const [y, m, d, hh, mm] = this.f.map((x) => x.el.value.trim());
    return checkBirth({ y, m, d, hh, mm, unknown: this.el.unknown.getAttribute('aria-checked') === 'true', city: this.cityVal, name: this.el.name.value }, nowDate);
  }

  submit() {
    if (!this.isOpen) return;
    if (this.kind === 'hepan-confirm' && !this.el.confirm.hidden) {
      this.close(this.ctx.me ?? this.app.me ?? null);
      return;
    }
    const r = this.validate();
    if (r.error) { this._error(r.error); return; }
    if (this.kind === 'self' || this.kind === 'hepan-self') {
      try { localStorage.setItem('birthsky:me', JSON.stringify(r.person)); } catch { /* private mode */ }
      this.app.me = r.person;
    }
    this.close(r.person);
  }

  // ------------------------------------------------------------------------------------ S3b city page
  async _cities() {
    if (this.app.cities) return this.app.cities;
    const m = await import('./cities.js');
    this.app.cities = m;
    return m;
  }

  openCity() {
    this._cityResolve?.(null);
    const { page, q } = this.el;
    q.value = '';
    clearTimeout(page._t);
    this.el.root?.classList.add('under');
    page.classList.add('on');
    page.setAttribute('aria-hidden', 'false');
    try { q.focus({ preventScroll: true }); } catch { q.focus(); }
    this._search();
    this._cities().then((m) => {
      if (m.citiesReady()) return;
      m.loadCities(this.app.citiesUrl || 'data/cities.json').then(() => { if (page.classList.contains('on')) this._search(); }).catch(() => {});
    }).catch(() => {});
    return new Promise((r) => { this._cityResolve = r; });
  }

  _closeCity(result) {
    const { page, q } = this.el;
    q.blur();
    this.el.root?.classList.remove('under');
    page.classList.remove('on');
    page.setAttribute('aria-hidden', 'true');
    const r = this._cityResolve;
    this._cityResolve = null;
    r?.(result ? cityFromResult(result) : null);
  }

  _search() {
    const { list, head, note, q } = this.el;
    const m = this.app.cities;
    const query = q.value.trim();
    if (!m || !m.citiesReady()) {
      head.hidden = true;
      list.innerHTML = '';
      note.hidden = false;
      note.textContent = T.city.loading;
      this._items = [];
      this._hl = -1;
      if (!m) this._cities().then(() => this._search()).catch(() => {});
      return;
    }
    if (!query) {
      head.hidden = false;
      head.textContent = T.city.common;
      this._items = T.city.commonList.map((n) => {
        const hits = m.searchCities(n, 6);
        return hits.find((c) => c.name === n && c.cc === 'CN') || hits[0];
      }).filter(Boolean);
      this._hl = -1;
    } else {
      head.hidden = true;
      this._items = m.searchCities(query, 20);
      this._hl = this._items.length ? 0 : -1;
    }
    note.hidden = !!this._items.length || !query;
    note.textContent = this._items.length ? '' : T.city.none;
    list.innerHTML = this._items.map((c, i) => {
      const region = String(c.label || '').split(' · ').slice(1).join(' · ');
      return `<li role="option" data-i="${i}" id="city-opt-${i}" aria-selected="${i === this._hl}" class="${i === this._hl ? 'is-hl' : ''}"><span class="cp-name">${esc(c.name)}</span><span class="cp-region">${esc(region)}</span></li>`;
    }).join('');
    this.el.scroll.scrollTop = 0;
  }

  _paintHl(scroll) {
    $$('li', this.el.list).forEach((li, i) => {
      const on = i === this._hl;
      li.classList.toggle('is-hl', on);
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) li.scrollIntoView({ block: 'nearest' });
    });
  }
}
