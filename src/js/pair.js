// 两个人 (S16 invite, S17 result): A's first-person sky with B's birth-moment horizon drawn across it. Stars that
// were up for A only dim (seed-staggered), the Moon and planets not up for both dim, the count rolls, the lines
// enter one by one, one soft bell when the horizon line completes. 看小红的天空 cuts to B's place and moment.
//
// Public API (main.js wires it)
//   new Pair(app)
//   pair.invite()                 S16 from your own sky
//   pair.onInvite('send' | 'manual' | 'cancel')
//   pair.together(friend)         from a friend's sky (S18): straight to S17 when `me` is stored, otherwise the form
//   pair.show(a, b, { guest, incoming })   S17 on A's sky (the caller has already put the sky at A)
//   pair.switchSides()            看 B 的天空
//   pair.tryIt()                  我也试试 (a result someone else sent)
//   pair.leave({ quiet })
import { computeHepan } from './hepan.js';
import { exportFraming } from './poster.js';
import { GLIDE } from './motion.js';
import { T } from './copy.js';
import { hint } from './ui.js';
import { shareFor, setShareTarget } from './share.js';
import { track } from './monetize.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class Pair {
  constructor(app) {
    this.app = app;
    this.result = null;
    this.guest = false;
    this.side = 'a';
  }

  // ------------------------------------------------------------------ S16
  invite() {
    const app = this.app;
    track('pair_invite');
    app.closeStrip();
    app.listen.on && app.listen.stop({ now: true });
    this.prevMode = app.mode;
    app.mode = 'pair-invite';
    app.chrome.hideChrome('pair');
    app.chrome.clearCaption(200);
    app.chrome.pairInvite(true);
  }

  async onInvite(k) {
    const app = this.app;
    app.chrome.pairInvite(false);
    if (k === 'send') {
      app.mode = 'sky';
      app.chrome.scene('sky');
      app.chrome.showChrome();
      app.share('invite');
      return;
    }
    if (k === 'manual') {
      const b = await app.askBirthday('partner');
      if (!b) { app.mode = 'sky'; app.chrome.scene('sky'); app.chrome.showChrome(); return; }
      const a = app.viewing;
      // the form lowered the gaze; the sky is still A's
      this.show(a, b, { guest: false });
      return;
    }
    app.mode = 'sky';
    app.chrome.scene('sky');
    app.chrome.showChrome();
  }

  /** From a friend's sky: me × the friend, on my sky. */
  async together(friend) {
    const app = this.app;
    if (app.me) {
      app.goNight(app.me, { own: true, then: () => this.show(app.me, friend, { incoming: true }) });
      return;
    }
    const p = await app.askBirthday('hepan-self', { inviter: friend });
    if (p) app.goNight(p, { own: true, then: () => this.show(p, friend, { incoming: true }) });
  }

  tryIt() {
    const app = this.app, r = this.result;
    if (!r) return;
    const inviter = r.a;
    app.askBirthday('hepan-self', { inviter }).then((p) => {
      if (p) app.goNight(p, { own: true, then: () => this.show(p, inviter, { incoming: true }) });
    });
  }

  // ------------------------------------------------------------------ S17
  async show(a, b, { guest = false, incoming = false } = {}) {
    const app = this.app;
    track('pair_result', guest ? 'guest' : 'own');
    this.a = a; this.b = b; this.guest = guest; this.side = 'a';
    const r = this.result = computeHepan(app.catalog, a, b, app.momentOf, { me: app.me });
    if (!app.samePerson(app.viewing, a)) {
      app.setPlace(a);
      app.enterSky(a, { own: app.samePerson(a, app.me) });
    }
    if (incoming) {
      app.chrome.caption(T.hint.pairIncoming(r.nameB), { key: 'pair-in', transient: true, ms: 2600 });
      await wait(1800);
    }
    this._enter(r, { animate: true });
    const s = shareFor('result', { a, b, both: r.both, nameB: r.nameB });
    setShareTarget(s.url, s.title);
  }

  async _enter(r, { animate }) {
    const app = this.app, v = app.vis;
    app.closeStrip();
    app.chrome.clearCaption(200);
    app.reticle = null; app.heroTag = null; app.marker = null;
    const bodyDim = {};
    for (const [id, both] of Object.entries(r.bodyShared || {})) bodyDim[id] = both ? 1 : 0.4;
    app.pairView = { result: r, zB: r.zB, nearlySame: r.nearlySame, label: r.horizonLabel, bodyDim };
    app.mode = 'pair';
    app.chrome.scene('pair');
    app.chrome.actions(this.guest ? 'pair-guest' : 'pair-own');
    v.sharedDim = 0.25;
    v.sharedT = 0; v.horizon = 0;
    app.tween(v, 'sharedT', 1, animate ? 2400 : 10);
    // the framing: B's line across the frame at 25–45 % of the height, the shared targets in view
    const view = exportFraming('card', app.cam.az, {
      pair: true, zB: r.zB, nearlySame: r.nearlySame, targets: r.targets, W: app.chrome.W, H: app.chrome.H,
    });
    app.needRest = true;
    app.rig.setTarget(view, GLIDE);
    app.lines = { mode: app.culture === 'none' ? 'off' : 'focus', focusIds: [], selId: null, origin: null, labels: true };
    if (!r.nearlySame) {
      app.tween(v, 'horizon', 1, animate ? 1600 : 10).then(() => {
        if (animate) app.audio.bell(74, 0.15, 0, { bright: 0.25, decay: 4.5 });
      });
    }
    await app.chrome.pairText({
      where: r.where, switchLabel: r.switchLabel, dates: r.dates, headline: r.headline, count: r.both,
      lines: r.lines, definition: r.definition, animate,
    });
    app.chrome.showChrome();
    if (animate) hint(r.nearlySame ? null : 'pairLine', r.hint);
    app.overlay.setUIRects(app.chrome.uiRects());
  }

  /** 看小红的天空: a cut to B's place and moment with A's horizon. */
  async switchSides() {
    const app = this.app;
    if (!this.result) return;
    const toB = this.side === 'a';
    const [x, y] = toB ? [this.b, this.a] : [this.a, this.b];
    const r = computeHepan(app.catalog, x, y, app.momentOf, { me: app.me });
    await app.chrome.cut(() => {
      app.setPlace(x);
      app.enterSky(x, { own: app.samePerson(x, app.me) });
      this.side = toB ? 'b' : 'a';
      this.result = r;
      app.chrome.pairClear();
      app.vis.horizon = 1;
      return this._enter(r, { animate: false });
    }, app.reduced() ? { out: 300, hold: 0, in: 300 } : undefined);
  }

  leave({ quiet = false } = {}) {
    const app = this.app;
    if (!app.pairView) return;
    app.pairView = null;
    app.vis.sharedDim = 1; app.vis.sharedT = 0; app.vis.horizon = 0;
    app.chrome.pairClear();
    if (!quiet) {
      app.mode = 'sky';
      app.chrome.scene('sky');
      app.chrome.actions(app.own ? 'own' : 'guest');
    }
  }
}
