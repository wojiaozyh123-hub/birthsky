// 留存 (S14 viewfinder, S15 result), 送一张 (the 星空贺卡 for a friend), 印成明信片 (the print order code) and the
// seller's print page (?print=<code>).
//
// The live sky IS the preview: the canvases stay full screen, the camera's projection centre moves to the
// frame's centre (cam.ox / oy) and its fov is chosen so the frame shows exactly the export's fov (P 0, the
// same rectilinear projection PosterStudio uses). Everything outside the frame is masked by .kf-frame::before.
//
// Public API (main.js wires it)
//   new Keep(app)
//   keep.open({ format = 'wallpaper' | 'card', gift = { to, from } | null })
//   keep.startGift()                 送一张: the friend's birthday → their night → this viewfinder in 贺卡 mode
//   keep.layout(), keep.escape()
//   keep.printPage(code)             the seller's page: render the order's card and offer the download
//   encodeOrder(o) / decodeOrder(code)
import {
  PosterStudio, exportSize, exportFraming, groundScrimFor, clockNudge, exportBlob,
} from './poster.js';
import { altForHorizonAt } from './camera.js';
import { LOOK, GLIDE } from './motion.js';
import { T, nameOr, fmtWhen } from './copy.js';
import { $, $$, toast, hint, clearHint, press } from './ui.js';
import { isWeChat, isMobile, encodePerson, decodePerson, copyText } from './share.js';
import { slotHtml, activateSlots, track } from './monetize.js';
import { poemForPerson, poemById, attribution } from './poems.js';
import { computeFacts } from './facts.js';
import { countLine } from './poemstats.js';
import { skyState } from './astro.js';
import { CONFIG } from './config.js';

const DEG = Math.PI / 180;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const WALL_MODES = ['poem+date', 'poem', 'date', 'none'];
const CARD_MODES = ['full', 'date', 'none'];
const MODE_LABEL = { 'poem+date': T.keep.textModes.poemDate, poem: T.keep.textModes.poem, date: T.keep.textModes.date, none: T.keep.textModes.none, full: T.keep.textModes.full };

// ------------------------------------------------------------------ order code
const b64u = {
  enc(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};
const r1 = (x) => Math.round(x * 10) / 10;

/** 'BS1.' + base64url(JSON): everything needed to redraw the exact card (business/ docs describe it). */
export function encodeOrder(o) {
  const j = {
    v: 1, k: o.kind, p: encodePerson(o.person), st: o.style, l: o.lines ? 1 : 0, c: o.culture, q: o.qr ? 1 : 0,
    tm: o.textMode, vw: [r1(o.view.az), r1(o.view.alt), r1(o.view.fov)],
  };
  if (o.kind === 'gift') { j.to = o.to || ''; j.fr = o.from || ''; j.g = o.greeting ? 1 : 0; }
  if (o.message && typeof o.message === 'object' && o.message.id) j.m = { id: o.message.id };
  else if (typeof o.message === 'string' && o.message.trim()) j.m = { t: o.message.trim() };
  if (o.subjectName && o.subjectName !== '你') j.sn = o.subjectName;
  return `BS1.${b64u.enc(JSON.stringify(j))}`;
}

export function decodeOrder(code) {
  try {
    const s = String(code || '').trim().replace(/\s+/g, '');
    const m = s.match(/BS1\.([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const j = JSON.parse(b64u.dec(m[1]));
    const person = decodePerson(j.p);
    if (!person || !Array.isArray(j.vw)) return null;
    let message = null;
    if (j.m?.id) message = poemById(j.m.id);
    else if (j.m?.t) message = String(j.m.t).slice(0, 80);
    return {
      kind: j.k === 'gift' ? 'gift' : 'card', person, style: ['night', 'mono', 'paper'].includes(j.st) ? j.st : 'night',
      lines: !!j.l, culture: ['cn', 'iau', 'none'].includes(j.c) ? j.c : 'cn', qr: j.q !== 0, textMode: j.tm || 'full',
      view: { az: +j.vw[0], alt: +j.vw[1], fov: +j.vw[2] }, to: j.to || '', from: j.fr || '', greeting: !!j.g, message,
      subjectName: j.sn || '',
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ Keep
export class Keep {
  constructor(app) {
    this.app = app;
    this.isOpen = false;
    this.busy = false;
    this.preset = 0;
    const q = (id) => document.getElementById(id);
    this.el = {
      keep: q('keep'), top: q('kf-top'), cancel: q('kf-cancel'), tabW: q('kf-tab-wallpaper'), tabC: q('kf-tab-card'), res: q('kf-res'),
      frame: q('kf-frame'), text: q('kf-text'), qr: q('kf-qr'), note: q('kf-note'), plate: q('kf-plate'),
      poem: q('kf-poem'), mode: q('kf-textmode'), lines: q('kf-lines'), qrT: q('kf-qr-t'), write: q('kf-write'), sentence: q('kf-sentence'), go: q('kf-go'),
      result: q('keep-result'), back: q('kr-back'), done: q('kr-done'), snap: q('keep-snap'), img: q('keep-img'), tip: q('kr-tip'),
      save: q('kr-save'), how: q('kr-how'), slot: q('keep-slot'), foot: q('kr-foot'),
    };
    this._build();
    this._bind();
  }

  get studio() {
    if (!this.app.studio) this.app.studio = new PosterStudio(this.app.catalog);
    return this.app.studio;
  }

  // ------------------------------------------------------------------ DOM additions (gift row, preview canvas, print UI)
  _build() {
    const el = this.el;
    // 署名 (送一张): sits in the second row, in place of 连线
    const from = document.createElement('label');
    from.className = 'kf-write kf-from';
    from.id = 'kf-from-wrap';
    from.hidden = true;
    from.innerHTML = `<span class="kf-wl">${T.gift.fromLabel}</span><input class="kf-input" id="kf-from" type="text" maxlength="12" autocomplete="off" enterkeyhint="done">`;
    el.qrT.after(from);
    el.fromWrap = from;
    el.from = from.querySelector('input');
    el.from.placeholder = T.gift.fromPlaceholder;
    // the text + QR layer, drawn by PosterStudio.previewText at frame scale
    const pv = document.createElement('canvas');
    pv.className = 'kf-pv';
    pv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
    el.text.appendChild(pv);
    el.pv = pv;
    // the print upsell on the result, and its order sheet
    const up = document.createElement('div');
    up.className = 'kr-print';
    up.innerHTML = '<button class="tbtn primary kr-print-go" id="kr-print-go" type="button"><span class="lbl"></span><i class="uline" aria-hidden="true"></i></button>'
      + '<p class="kr-nudge" id="kr-nudge"></p>';
    el.foot.appendChild(up);
    el.printBox = up;
    el.printGo = up.querySelector('#kr-print-go');
    el.nudge = up.querySelector('#kr-nudge');
    const sheet = document.createElement('section');
    sheet.className = 'kr-order';
    sheet.id = 'kr-order';
    sheet.setAttribute('aria-hidden', 'true');
    sheet.innerHTML = `<div class="ko-in">
      <h2 class="ko-title">${T.print.sheetTitle}</h2>
      <p class="ko-body" id="ko-body"></p>
      <p class="ko-label">${T.print.codeLabel}</p>
      <textarea class="ko-code" id="ko-code" readonly rows="3"></textarea>
      <p class="ko-step" id="ko-step"></p>
      <div class="ko-acts">
        <button class="tbtn primary" id="ko-copy" type="button"><span class="lbl">${T.print.copy}</span><i class="uline" aria-hidden="true"></i></button>
        <button class="tbtn secondary" id="ko-shop" type="button" hidden>${T.print.go}</button>
        <button class="tbtn secondary" id="ko-close" type="button">${T.print.close}</button>
      </div>
      <p class="ko-fine">${T.print.custom}</p>
    </div>`;
    el.result.appendChild(sheet);
    el.order = sheet;
  }

  _bind() {
    const el = this.el;
    press([el.cancel, el.tabW, el.tabC, el.res, el.poem, el.mode, el.lines, el.qrT, el.go, el.back, el.done, el.save, el.printGo,
      ...$$('.kf-styles .kf-opt', el.keep), ...$$('.ko-acts .tbtn', el.order)]);
    el.cancel.addEventListener('click', () => this.close());
    el.tabW.addEventListener('click', () => this.setFormat('wallpaper'));
    el.tabC.addEventListener('click', () => this.setFormat('card'));
    el.res.addEventListener('click', () => {
      if (this.format !== 'wallpaper' || !this.desktop) return;
      this.preset = (this.preset + 1) % 2;
      this._sizeLabel();
      this.layout();
      this.frameTo();
    });
    for (const b of $$('.kf-styles .kf-opt', el.keep)) b.addEventListener('click', () => this.setStyle(b.dataset.style));
    el.poem.addEventListener('click', () => {
      if (this.gift || this.format === 'wallpaper') this.o.poemStep++;
      else this.o.lineStep++;
      this.o.sentence = ''; el.sentence.value = '';
      this.refresh();
    });
    el.mode.addEventListener('click', () => {
      if (this.gift) this.o.greeting = !this.o.greeting;
      else {
        const modes = this.format === 'card' ? CARD_MODES : WALL_MODES;
        this.o.textMode = modes[(modes.indexOf(this.o.textMode) + 1) % modes.length];
      }
      this.refresh();
    });
    el.lines.addEventListener('click', () => { this.o.lines = !this.o.lines; this.refresh(); });
    el.qrT.addEventListener('click', () => { this.o.qr = !this.o.qr; this.refresh(); });
    el.sentence.addEventListener('input', () => { this.o.sentence = el.sentence.value; this.refresh(); });
    el.from.addEventListener('input', () => { this.o.from = el.from.value; this.refresh(); });
    for (const inp of [el.sentence, el.from]) {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('focus', () => { this.app.chrome.layout(); });
    }
    el.go.addEventListener('click', () => this.go());
    el.back.addEventListener('click', () => this.backToFrame());
    el.done.addEventListener('click', () => this.close({ fromResult: true }));
    el.save.addEventListener('click', () => this.save());
    el.printGo.addEventListener('click', () => this.printOffer());
    el.order.querySelector('#ko-copy').addEventListener('click', async () => {
      const ok = await copyText(this.orderCode || '');
      toast(ok ? T.print.copied : T.share.copyFailed);
      track('print_copy');
    });
    el.order.querySelector('#ko-shop').addEventListener('click', () => {
      track('print_shop');
      copyText(this.orderCode || '');
      const url = CONFIG.print.shopUrl;
      if (url) location.href = url;
    });
    el.order.querySelector('#ko-close').addEventListener('click', () => this.orderSheet(false));
  }

  // ------------------------------------------------------------------ 送一张
  async startGift() {
    const app = this.app;
    track('gift_open');
    const friend = await app.askBirthday('gift');
    if (!friend) return;
    app.goNight(friend, { own: false, gift: { to: friend.name || '', from: app.me?.name || '' } });
  }

  // ------------------------------------------------------------------ S14 open / close
  async open({ format = 'wallpaper', gift = null } = {}) {
    const app = this.app;
    if (this.isOpen || !app.sky || !app.viewing) return;
    track('keep_open', gift ? 'gift' : format);
    app.closeStrip();
    app.listen.on && app.listen.stop({ now: true });
    if (app.ruler.isOpen) app.ruler.close('keep');
    this.isOpen = true;
    this.gift = gift;
    this.format = gift ? 'card' : format;
    this.desktop = app.chrome.W >= 960 || app.chrome.W > app.chrome.H;
    this.prev = { mode: app.mode === 'gift' ? 'sky' : app.mode, view: app.cam.snapshot(), chrome: app.chrome.chromeOn, limits: { ...app.rig.limits } };
    const pair = app.pairView?.result || null;
    this.o = {
      style: 'night', textMode: this.format === 'card' ? 'full' : 'poem+date', lines: false, qr: true, sentence: '',
      poemStep: app.poemStep || 0, lineStep: 0, greeting: true, from: gift?.from || app.me?.name || '', pair,
    };
    this.el.sentence.value = '';
    this.el.from.value = this.o.from;
    app.chrome.clearCaption(200);
    app.chrome.hideChrome('keep');
    clearHint();
    window.scrollTo(0, 0);
    app.tween(app.vis, 'compass', 0, 300);
    app.reticle = null; app.heroTag = null; app.marker = null;
    app.mode = 'keep';
    app.chrome.scene('keep');
    app.cam.Pfixed = 0;
    this._controls();
    this.layout();
    app.chrome.layer('keep', true);
    await this.frameTo(true);
    hint(gift ? null : 'keep', gift ? T.gift.keepHint : T.hint.keep);
  }

  /** The camera framing for the current format, converted into the full-screen camera. */
  async frameTo(first = false) {
    const app = this.app, o = this.o, size = this.size();
    let v;
    if (this.gift) {
      const az = this.studio.bestAzimuth(app.sky) ?? app.cam.az;
      v = exportFraming('card', az, { style: o.style, W: size.W, H: size.H });
      if (o.style !== 'paper') v = { ...v, alt: altForHorizonAt(0.66, v.fov) };
    } else {
      const pr = o.pair;
      v = exportFraming(this.format, app.cam.az, {
        style: o.style, pair: !!pr, W: size.W, H: size.H, zB: pr?.zB, nearlySame: pr?.nearlySame, targets: pr?.targets,
      });
    }
    const t = { az: v.az, alt: v.alt, fov: this.canvasFov(v.fov) };
    if (first) app.rig.setTarget(t, LOOK);
    else await app.rig.setTarget(t, LOOK);
    this.refresh();
  }

  close({ fromResult = false } = {}) {
    const app = this.app;
    if (!this.isOpen) return;
    this.isOpen = false;
    this.busy = false;
    clearHint();
    this.orderSheet(false);
    app.paused = false;
    if (fromResult) { app.chrome.layer('keep-result', false); this._releaseImg(); }
    app.chrome.layer('keep', false);
    app.studio?.release();
    const cam = app.cam;
    cam.ox = 0; cam.oy = 0; cam.Pfixed = null;
    app.rig.limits.fovMin = this.prev.limits.fovMin;
    app.rig.limits.fovMax = this.prev.limits.fovMax;
    const v = this.prev.view;
    app.rig.set({ az: cam.az, alt: cam.alt, fov: clamp(this.exportFov(cam.fov), 20, 100) });
    app.rig.setTarget(v, GLIDE);
    const wasGift = !!this.gift;
    this.gift = null;
    app.mode = this.prev.mode;
    app.chrome.scene(app.mode === 'pair' ? 'pair' : 'sky');
    app.tween(app.vis, 'compass', 1, 600);
    if (wasGift) app.afterGift?.();
    else if (this.prev.chrome || app.mode === 'pair') app.chrome.showChrome();
  }

  escape() {
    if (this.el.order.classList.contains('on')) { this.orderSheet(false); return; }
    if (this.app.mode === 'result') { this.backToFrame(); return; }
    this.close();
  }

  // ------------------------------------------------------------------ frame geometry
  size() {
    if (this.format === 'card') return { W: 1080, H: 1440 };
    const desktop = this.desktop;
    return exportSize('wallpaper', {
      screenW: screen.width, screenH: screen.height, dpr: devicePixelRatio || 2, desktop, preset: this.preset,
    });
  }

  layout() {
    if (!this.isOpen) return;
    const app = this.app, cam = app.cam, size = this.size();
    const W = app.chrome.W, H = app.chrome.H;
    const r = this.rect = app.chrome.keepFrame(this.format, size.W / size.H);
    // the projection centre at the frame's centre; the fov so the frame spans the export's fov
    cam.ox = r.x + r.w / 2 - W / 2;
    cam.oy = r.y + r.h / 2 - H / 2;
    this.k = H / r.h;
    app.rig.limits.fovMin = this.canvasFov(40);
    app.rig.limits.fovMax = this.canvasFov(100);
    cam.update();
    const dpr = Math.min(3, devicePixelRatio || 1);
    this.el.pv.width = Math.round(r.w * dpr);
    this.el.pv.height = Math.round(r.h * dpr);
    this._sizeLabel();
    this.refresh();
  }

  canvasFov(fe) { return 2 * Math.atan(Math.tan((fe / 2) * DEG) * (this.k || 1)) / DEG; }
  exportFov(fc) { return 2 * Math.atan(Math.tan((fc / 2) * DEG) / (this.k || 1)) / DEG; }
  view() { const c = this.app.cam; return { az: c.az, alt: c.alt, fov: this.exportFov(c.fov) }; }

  _sizeLabel() {
    const s = this.size();
    this.el.res.textContent = this.gift ? '' : T.keep.size(s.W, s.H);
  }

  // ------------------------------------------------------------------ controls
  setFormat(f) {
    if (this.gift || f === this.format || this.busy) return;
    this.format = f;
    this.o.textMode = f === 'card' ? 'full' : 'poem+date';
    if (f === 'wallpaper' && this.o.style === 'paper') this.o.style = 'night';
    this._controls();
    this.layout();
    this.frameTo();
  }

  setStyle(s) {
    if (this.busy) return;
    if (s === 'paper' && this.format !== 'card') return;
    const was = this.o.style;
    this.o.style = s;
    this._controls();
    if ((was === 'paper') !== (s === 'paper')) this.frameTo();
    else this.refresh();
  }

  _controls() {
    const el = this.el, o = this.o, card = this.format === 'card', gift = !!this.gift;
    el.keep.dataset.format = this.format;
    el.keep.dataset.qr = 'off'; // the QR is drawn by previewText
    el.tabW.hidden = gift;
    el.tabC.textContent = gift ? T.gift.tab : T.keep.formats.card;
    el.tabW.classList.toggle('is-active', !card);
    el.tabC.classList.toggle('is-active', card);
    el.tabW.setAttribute('aria-selected', String(!card));
    el.tabC.setAttribute('aria-selected', String(card));
    for (const b of $$('.kf-styles .kf-opt', el.keep)) {
      if (b.dataset.style === 'paper') b.hidden = !card;
      const on = b.dataset.style === o.style;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    }
    el.poem.textContent = gift ? T.gift.poemNext : card ? T.keep.lineNext : T.night.poemNext;
    el.mode.textContent = gift ? (o.greeting ? T.gift.greetingOn : T.gift.greetingOff) : MODE_LABEL[o.textMode];
    el.lines.hidden = gift;
    el.lines.textContent = o.lines ? T.keep.lines.on : T.keep.lines.off;
    el.qrT.hidden = !card || gift;
    el.qrT.textContent = o.qr ? T.keep.qr.on : T.keep.qr.off;
    el.fromWrap.hidden = !gift;
    const wl = el.write.querySelector('.kf-wl');
    if (wl) wl.textContent = gift ? T.gift.ownWords : T.keep.write;
    el.sentence.maxLength = gift ? 48 : card ? T.keep.limits.card : T.keep.limits.wallpaper;
    const textOn = gift || (card ? o.textMode === 'full' : o.textMode === 'poem+date' || o.textMode === 'poem');
    el.write.style.visibility = textOn ? '' : 'hidden';
  }

  /** The person, poem and sentence the export will use. */
  content() {
    const app = this.app, o = this.o, person = this.person();
    const pair = o.pair;
    if (this.gift) {
      const own = (o.sentence || '').trim();
      const pr = poemForPerson(person, o.poemStep);
      return { person, message: own || pr.poem, poem: pr.poem, regional: pr.regional, place: pr.place };
    }
    if (this.format === 'wallpaper') {
      const pr = poemForPerson(pair ? pair.a : person, o.poemStep, { pair: !!pair, partner: pair ? pair.b : null });
      return { person, poem: pr.poem, regional: pr.regional, place: pr.place, sentence: (o.sentence || '').trim() || undefined };
    }
    // card: L3 cycles [光年之星 sentence, poem 1, poem 2, …]; 写一句 overrides
    const own = (o.sentence || '').trim();
    if (own) return { person, sentence: own };
    if (o.lineStep === 0 || pair) return { person, sentence: undefined };
    const pr = poemForPerson(person, o.lineStep - 1);
    return { person, sentence: pr.poem, poem: pr.poem, regional: pr.regional, place: pr.place };
  }

  person() { return this.o.pair ? this.o.pair.a : this.app.viewing; }

  renderOpts(extra = {}) {
    const app = this.app, o = this.o, c = this.content();
    const base = {
      format: this.format, style: o.style, textMode: o.textMode, lines: o.lines, culture: app.culture, qr: o.qr,
      view: this.view(), size: this.size(), screenCSSW: app.chrome.W, person: c.person, sky: app.sky, facts: app.facts,
      subjectName: app.own ? '你' : nameOr(c.person), pair: o.pair || undefined, dayMask: app.vis.dayMask, terrainH: app.vis.terrainH,
    };
    if (this.gift) {
      base.gift = { to: this.gift.to || c.person.name || '', from: (o.from || '').trim(), greeting: o.greeting ? T.gift.greetingDefault : '', message: c.message };
      base.subjectName = nameOr(c.person, 'TA');
    } else if (this.format === 'wallpaper') {
      base.poem = c.poem;
      if (c.sentence) base.sentence = c.sentence;
    } else if (c.sentence !== undefined) {
      base.sentence = c.sentence;
    }
    return { ...base, ...extra };
  }

  /** Text preview in the frame + the note line, debounced. */
  refresh() {
    if (!this.isOpen) return;
    this._controls();
    clearTimeout(this._rt);
    this._rt = setTimeout(() => this._preview(), 90);
    const c = this.content();
    const note = this.el.note;
    let text = '';
    const poem = c.poem && (this.gift ? !(this.o.sentence || '').trim() : !c.sentence || typeof c.sentence === 'object');
    if (poem && this.format === 'wallpaper' ? this.o.textMode !== 'date' && this.o.textMode !== 'none' : poem) {
      const count = this.o.poemStep === 0 && this.app.own && this.app.poemCount ? countLine(this.app.poemCount) : '';
      text = T.keep.note(attribution(c.poem) || T.keep.noteOriginal, count);
      if (c.regional && c.place) text += `　${T.keep.notePlace(c.place)}`;
    }
    note.textContent = text;
    note.classList.toggle('on', !!text);
    // ground scrim notice (text over a high horizon)
    const s = this.size();
    if (!this.gift && groundScrimFor(this.format, this.view(), { pair: !!this.o.pair, style: this.o.style, textMode: this.o.textMode, W: s.W, H: s.H }) > 0) {
      hint('groundScrim', T.hint.groundScrim);
    }
  }

  async _preview() {
    if (!this.isOpen || !this.rect) return;
    const pv = this.el.pv, ctx = pv.getContext('2d');
    const s = this.size();
    const seq = (this._pseq = (this._pseq || 0) + 1);
    try {
      const off = document.createElement('canvas');
      off.width = pv.width; off.height = pv.height;
      const octx = off.getContext('2d');
      octx.setTransform(pv.width / s.W, 0, 0, pv.height / s.H, 0, 0);
      await this.studio.previewText(octx, this.renderOpts());
      if (seq !== this._pseq) return;
      ctx.clearRect(0, 0, pv.width, pv.height);
      ctx.drawImage(off, 0, 0);
    } catch (e) {
      console.warn('preview', e);
    }
  }

  // ------------------------------------------------------------------ 就这张 → S15
  async go() {
    const app = this.app, el = this.el;
    if (this.busy || !this.isOpen) return;
    this.busy = true;
    document.activeElement?.blur?.();
    if (this.format === 'wallpaper' && !this.gift) {
      const s = this.size();
      const n = clockNudge(this.view(), app.sky, s);
      if (n) {
        await Promise.race([app.rig.setTarget({ az: n.az, alt: n.alt, fov: this.canvasFov(n.fov) }, LOOK), wait(1600)]);
        hint('moonNudge', T.hint.moonNudge);
      }
    }
    const opts = this.renderOpts();
    const s = opts.size;
    hint(null, T.hint.drawing(s.W, s.H), { hold: true });
    el.go.classList.add('is-loading');
    el.go.style.setProperty('--p', '0');
    const snap = this._snapshot();
    app.paused = true;
    let res;
    try {
      res = await this.studio.render({ ...opts, onProgress: (p) => el.go.style.setProperty('--p', String(p)) });
    } catch (e) {
      console.error(e);
      clearHint();
      el.go.classList.remove('is-loading');
      app.paused = false;
      this.busy = false;
      toast(T.result.fallback1080);
      return;
    }
    clearHint();
    el.go.classList.remove('is-loading');
    this.lastOpts = opts;
    this.lastRes = res;
    this.orderCode = (this.format === 'card') ? encodeOrder({
      kind: this.gift ? 'gift' : 'card', person: opts.person, style: opts.style, lines: opts.lines, culture: opts.culture, qr: opts.qr,
      textMode: opts.textMode, view: opts.view, to: opts.gift?.to, from: opts.gift?.from, greeting: !!opts.gift?.greeting,
      message: this.gift ? opts.gift.message : opts.sentence, subjectName: opts.subjectName,
    }) : '';
    this.showResult(snap, res);
    if (res.fallback) toast(T.result.fallback1080);
    track(this.gift ? 'gift_done' : 'keep_done', this.format);
  }

  _snapshot() {
    try {
      const app = this.app, r = this.rect, dpr = app.dpr || 1;
      const c = document.createElement('canvas');
      c.width = Math.round(r.w * dpr / 2); c.height = Math.round(r.h * dpr / 2);
      const ctx = c.getContext('2d');
      // the WebGL buffer is only valid right after a draw: draw a fresh frame first
      if (app._glState) app.renderer.render(app._glState());
      for (const cv of [document.getElementById('sky'), document.getElementById('overlay')]) {
        ctx.drawImage(cv, r.x * dpr, r.y * dpr, r.w * dpr, r.h * dpr, 0, 0, c.width, c.height);
      }
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return ''; }
  }

  showResult(snap, res) {
    const app = this.app, el = this.el;
    app.mode = 'result';
    app.chrome.scene('result');
    app.chrome.layer('keep', false);
    el.snap.src = snap || '';
    el.snap.classList.toggle('on', !!snap);
    el.img.classList.remove('on');
    app.chrome.layer('keep-result', true);
    const img = el.img;
    img.onload = () => { img.classList.add('on'); setTimeout(() => el.snap.classList.remove('on'), 600); };
    img.src = res.dataUrl;
    const card = this.format === 'card';
    // instructions
    let tip = '', how = '';
    if (isWeChat) {
      if (this.gift) { tip = T.gift.resultTip; how = T.gift.resultHow; }
      else if (card) tip = T.result.wxCard;
      else {
        tip = T.result.wxWallpaper;
        how = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? T.result.wxWallpaperIOS : T.result.wxWallpaperAndroid;
      }
    } else if (this.gift) how = T.gift.resultHow;
    el.tip.textContent = tip;
    el.tip.hidden = !tip;
    el.how.textContent = how;
    el.save.hidden = isWeChat;
    el.save.querySelector('.lbl').textContent = isMobile ? T.result.phone : T.result.desktop;
    // 印成明信片
    const pc = CONFIG.print;
    // 印成明信片 is paused (CONFIG.print.enabled); the gentle share line stays
    el.printBox.hidden = false;
    el.printGo.hidden = !pc?.enabled;
    if (pc?.enabled) el.printGo.querySelector('.lbl').textContent = card ? T.print.upsell(pc.price) : T.print.upsellWall(pc.price);
    el.nudge.textContent = T.print.shareNudge;
    el.slot.innerHTML = slotHtml('keep');
    activateSlots(el.slot);
    app.chrome.layout();
  }

  backToFrame() {
    const app = this.app, el = this.el;
    this.orderSheet(false);
    app.chrome.layer('keep-result', false);
    this._releaseImg();
    app.paused = false;
    app.mode = 'keep';
    app.chrome.scene('keep');
    app.chrome.layer('keep', true);
    this.busy = false;
    el.go.style.setProperty('--p', '0');
    this.refresh();
  }

  _releaseImg() {
    const el = this.el;
    setTimeout(() => { if (this.app.mode !== 'result') { el.img.removeAttribute('src'); el.snap.removeAttribute('src'); } }, 600);
  }

  async save() {
    const res = this.lastRes, p = this.person();
    if (!res) return;
    const kind = this.gift ? 'gift' : this.o.pair ? 'pair' : this.format;
    const name = T.result.fileName(p, kind);
    try {
      const blob = exportBlob(res.dataUrl);
      const file = new File([blob], name, { type: 'image/jpeg' });
      if (isMobile && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      }
      toast(T.result.saved);
    } catch (e) {
      if (e?.name !== 'AbortError') console.warn(e);
    }
  }

  // ------------------------------------------------------------------ 印成明信片
  printOffer() {
    track('print_open', this.format);
    if (this.format !== 'card') {
      // a wallpaper is a phone shape: go back and take the card framing of the same sky
      this.backToFrame();
      this.setFormat('card');
      hint(null, T.print.wallSwitch, { ms: 3600 });
      return;
    }
    this.orderSheet(true);
  }

  orderSheet(on) {
    const el = this.el, sheet = el.order;
    if (!on) { sheet.classList.remove('on'); sheet.setAttribute('aria-hidden', 'true'); return; }
    const pc = CONFIG.print;
    sheet.querySelector('#ko-body').textContent = T.print.sheetBody;
    sheet.querySelector('#ko-code').value = this.orderCode;
    const shop = sheet.querySelector('#ko-shop');
    shop.hidden = !pc.shopUrl;
    sheet.querySelector('#ko-step').textContent = pc.shopUrl ? T.print.stepShop : T.print.stepContact(pc.contact || pc.email);
    sheet.classList.add('on');
    sheet.setAttribute('aria-hidden', 'false');
  }

  // ------------------------------------------------------------------ the seller's page (?print=CODE)
  async printPage(code) {
    const app = this.app, el = this.el;
    const o = decodeOrder(code);
    app.mode = 'result';
    app.chrome.scene('result');
    app.paused = true;
    el.back.hidden = true;
    el.done.hidden = true;
    el.printBox.hidden = true;
    el.slot.innerHTML = '';
    el.save.hidden = false;
    el.save.querySelector('.lbl').textContent = T.print.download;
    app.chrome.layer('keep-result', true);
    if (!o) { el.tip.hidden = false; el.tip.textContent = T.print.bad; el.save.hidden = true; return; }
    el.tip.hidden = false;
    el.tip.textContent = T.print.drawing;
    const p = o.person;
    const sky = skyState(app.momentOf(p), p.city.lat, p.city.lon);
    const facts = computeFacts(app.catalog, p, app.momentOf(p), sky);
    const opts = {
      format: 'card', style: o.style, textMode: o.textMode, lines: o.lines, culture: o.culture, qr: o.qr, view: o.view,
      size: { W: 1080, H: 1440 }, screenCSSW: 390, person: p, sky, facts, subjectName: o.subjectName || (o.kind === 'gift' ? nameOr(p, 'TA') : '你'),
    };
    if (o.kind === 'gift') {
      opts.gift = { to: o.to || p.name || '', from: o.from, greeting: o.greeting ? T.gift.greetingDefault : '', message: o.message ?? poemForPerson(p).poem };
    } else if (o.message) opts.sentence = o.message;
    try {
      const res = await this.studio.render(opts);
      this.lastRes = res;
      this.format = 'card';
      this.o = { pair: null };
      this.gift = o.kind === 'gift' ? { to: o.to } : null;
      this._printPerson = p;
      this.person = () => p;
      el.img.onload = () => el.img.classList.add('on');
      el.img.src = res.dataUrl;
      const msg = typeof o.message === 'string' ? o.message : o.message ? `${o.message.lines.join('')}（${attribution(o.message) || T.keep.noteOriginal}）` : '';
      el.tip.textContent = `${T.print.pageTitle}　${fmtWhen(p, { name: nameOr(p, '') || undefined })}`;
      el.how.textContent = [o.kind === 'gift' ? `给 ${o.to || p.name || ''}　${o.from ? `${o.from} 赠` : ''}` : '', msg, T.print.spec].filter(Boolean).join('\n');
      el.how.style.whiteSpace = 'pre-line';
    } catch (e) {
      console.error(e);
      el.tip.textContent = T.print.bad;
      el.save.hidden = true;
    }
  }
}

