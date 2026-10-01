// The hands on the sky (spec §3b, S6–S8): grab the sky, fling, the anchored pinch, the mouse wheel, the
// arrow / +/− keys, double-tap 回正, single taps routed to the app, and hover names on desktop.
// It owns no state of the scene: every decision about what a touch means is asked of the app.
//
// Public API
//   new Gestures(app, el)          el = #overlay. app provides:
//                                    app.rig, app.cam, app.gyro                (motion.js ViewRig, camera.js Camera)
//                                    app.canTouch() → bool                     any touch at all (false during the spin)
//                                    app.canLook() → bool                      drag / pinch / wheel / keys may move the view
//                                    app.onPointerDown(), app.onDragStart(), app.onDragEnd(), app.onPointerUp()
//                                    app.onTap(x, y), app.onDoubleTap(x, y), app.onHover(x, y | null), app.onKey(name)
//   gestures.dragging              a finger (or the mouse) is moving the view (drag or pinch)
//   gestures.down                  any pointer is down on the sky
//   gestures.releasedAt            performance.now() of the last drag/pinch release
//   gestures.frame(now)            after rig.step(): keeps the grabbed star under a resting finger while the
//                                  fov changes underneath it (look-up widening)
//   gestures.cancel()              forget the current gesture (a mode change took the sky away)
import { grabSolve, FlingTracker, LOOK } from './motion.js';

const SLOP_TOUCH = 8, SLOP_MOUSE = 4;      // px before a press becomes a drag
const TAP_MS = 500;                        // longer presses are not taps
const DOUBLE_MS = 320, DOUBLE_PX = 30;     // double-tap window
const HOVER_MS = 300;                      // desktop: names after resting the mouse
const WHEEL_K = 0.0012;                    // ln fov per wheel pixel (spec §3b)
const KEY_DEG = 5, KEY_ZOOM = 0.15;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const now = () => performance.now();

export class Gestures {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.pts = new Map();         // pointerId → {x, y}
    this.g = null;                // { kind: 'pending' | 'drag' | 'pinch', … }
    this.tracker = new FlingTracker();
    this.lastTap = null;
    this.releasedAt = -1e9;
    this.hoverT = 0;
    this.s0 = [0, 0, 0];
    this.sMid = [0, 0, 0];
    this._bind();
  }

  get dragging() { return !!this.g && (this.g.kind === 'drag' || this.g.kind === 'pinch'); }
  get down() { return this.pts.size > 0; }

  cancel() {
    if (this.g && this.dragging) {
      this.app.rig.release(null);
      this.app.onDragEnd?.();
    }
    this.g = null;
    this.pts.clear();
  }

  // ------------------------------------------------------------------------------------ binding
  _bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e, false));
    el.addEventListener('pointercancel', (e) => this._up(e, true));
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.pts.size) this._hover(null); });
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    // no long-press menu on the sky (WeChat's own long-press belongs to images, D-6)
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', (e) => this._key(e));
  }

  // ------------------------------------------------------------------------------------ pointers
  _down(e) {
    const app = this.app;
    if (!app.canTouch()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._hover(null);
    app.onPointerDown?.();
    const t = now();
    if (this.pts.size === 1) {
      // a finger landing stops a fling where it is (a scripted move is only taken over once the finger drags)
      if (app.rig.flingSt) app.rig.catch();
      this.g = { kind: 'pending', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: t, mouse: e.pointerType === 'mouse' };
    } else if (this.pts.size === 2 && app.canLook()) {
      this._pinchStart(t);
    }
  }

  _move(e) {
    const p = this.pts.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && !e.buttons) this._hoverSoon(e.clientX, e.clientY);
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    const g = this.g;
    if (!g) return;
    const t = now();
    if (g.kind === 'pending') {
      if (e.pointerId !== g.id) return;
      const slop = g.mouse ? SLOP_MOUSE : SLOP_TOUCH;
      if (Math.hypot(p.x - g.x0, p.y - g.y0) > slop && this.app.canLook()) this._dragStart(p.x, p.y, t);
      return;
    }
    if (g.kind === 'drag' && e.pointerId === g.id) this._dragMove(p.x, p.y, t);
    else if (g.kind === 'pinch') this._pinchMove(t);
  }

  _up(e, cancelled) {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const app = this.app, g = this.g, t = now();
    if (g && g.kind === 'pinch') {
      if (this.pts.size === 1) {
        // one finger stays: it carries on as a drag from where it is
        const [id, p] = [...this.pts.entries()][0];
        this.g = { kind: 'drag', id, x0: p.x, y0: p.y, t0: t, mouse: false, lx: p.x, ly: p.y, fov: app.cam.fov };
        app.cam.unproject(p.x, p.y, this.s0);
        this.tracker.reset();
        this.tracker.add(t, app.cam.az, app.cam.alt);
        return;
      }
      if (this.pts.size === 0) this._end(t, false);
      return;
    }
    if (this.pts.size > 0) return;
    if (!g) { app.onPointerUp?.(); return; }
    if (g.kind === 'drag') this._end(t, !cancelled);
    else {
      this.g = null;
      app.onPointerUp?.();
      if (!cancelled && t - g.t0 < TAP_MS) this._tap(e.clientX, e.clientY, t);
    }
  }

  _end(t, fling) {
    const app = this.app;
    const vel = fling && !app.gyro?.on ? this.tracker.velocity(t) : null;
    this.g = null;
    this.releasedAt = t;
    if (app.gyro?.on) app.gyro.dragEnd();
    else app.rig.release(vel);
    app.onDragEnd?.();
    app.onPointerUp?.();
  }

  _tap(x, y, t) {
    const last = this.lastTap;
    if (last && t - last.t < DOUBLE_MS && Math.hypot(last.x - x, last.y - y) < DOUBLE_PX) {
      this.lastTap = null;
      this.app.onDoubleTap?.(x, y);
      return;
    }
    this.lastTap = { x, y, t };
    this.app.onTap?.(x, y);
  }

  // ------------------------------------------------------------------------------------ grab the sky
  _dragStart(x, y, t) {
    const app = this.app, g = this.g;
    g.kind = 'drag';
    g.lx = x; g.ly = y;
    // the finger takes over whatever was moving; the star under it now stays under it
    if (!app.gyro?.on) app.rig.catch();
    app.cam.unproject(x, y, this.s0);
    g.fov = app.cam.fov;
    this.tracker.reset();
    this.tracker.add(t, app.cam.az, app.cam.alt);
    if (app.gyro?.on) app.gyro.dragStart();
    app.onDragStart?.(Math.hypot(x - g.x0, y - g.y0));
  }

  _dragMove(x, y, t) {
    const app = this.app, g = this.g, cam = app.cam;
    g.lx = x; g.ly = y;
    if (app.gyro?.on) {
      app.gyro.dragTo(x - g.x0, y - g.y0);
    } else {
      const v = grabSolve(cam, this.s0, x, y);
      app.rig.drag({ az: v.az, alt: v.alt }, t);
    }
    this.tracker.add(t, cam.az, cam.alt);
    if (Math.hypot(x - g.x0, y - g.y0) > 24) app.onDragFar?.();
  }

  /** While a finger rests and the fov changes under it (look-up widening), keep its star under it. */
  frame(t) {
    const g = this.g, app = this.app;
    if (!g || g.kind !== 'drag' || app.gyro?.on) return;
    if (Math.abs(app.cam.fov - g.fov) < 1e-3) return;
    g.fov = app.cam.fov;
    const v = grabSolve(app.cam, this.s0, g.lx, g.ly);
    app.rig.drag({ az: v.az, alt: v.alt }, t);
  }

  // ------------------------------------------------------------------------------------ pinch
  _pinchStart(t) {
    const app = this.app, [a, b] = [...this.pts.values()];
    const wasDrag = this.dragging;
    if (!app.gyro?.on) app.rig.catch();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    app.cam.unproject(mx, my, this.sMid);
    this.g = { kind: 'pinch', d0: Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)), fov0: app.cam.fov, x0: mx, y0: my, t0: t };
    if (!wasDrag) app.onDragStart?.(0);
  }

  _pinchMove(t) {
    const app = this.app, g = this.g;
    if (this.pts.size < 2) return;
    const [a, b] = [...this.pts.values()];
    const d = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const fov = g.fov0 * g.d0 / d;
    if (app.gyro?.on) {
      app.rig.follow({ fov: clamp(fov, app.rig.limits.fovMin, app.rig.limits.fovMax) });
      return;
    }
    const v = grabSolve(app.cam, this.sMid, mx, my, fov);
    app.rig.drag({ az: v.az, alt: v.alt, fov: v.fov }, t);
  }

  // ------------------------------------------------------------------------------------ wheel, keys
  _wheel(e) {
    const app = this.app;
    if (!app.canTouch() || !app.canLook()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const base = app.rig.target?.fov ?? app.cam.fov;
    const lim = app.rig.limits;
    const fov = clamp(Math.exp(Math.log(base) + e.deltaY * k * WHEEL_K), lim.fovMin, lim.fovMax);
    app.rig.follow({ fov });
  }

  _key(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
    const app = this.app;
    const look = app.canTouch() && app.canLook();
    const tgt = app.rig.target || app.cam.snapshot();
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowRight':
        if (!look || app.gyro?.on) return;
        e.preventDefault();
        app.rig.setTarget({ az: tgt.az + (e.key === 'ArrowRight' ? KEY_DEG : -KEY_DEG) }, LOOK);
        break;
      case 'ArrowUp': case 'ArrowDown': {
        if (!look || app.gyro?.on) return;
        e.preventDefault();
        const alt = clamp(tgt.alt + (e.key === 'ArrowUp' ? KEY_DEG : -KEY_DEG), app.rig.altMin(tgt.fov), 90);
        app.rig.setTarget({ alt }, LOOK);
        break;
      }
      case '+': case '=': case '-': case '_': {
        if (!look) return;
        e.preventDefault();
        const lim = app.rig.limits;
        const fov = clamp((tgt.fov || app.cam.fov) * Math.exp(e.key === '+' || e.key === '=' ? -KEY_ZOOM : KEY_ZOOM), lim.fovMin, lim.fovMax);
        app.rig.follow({ fov });
        break;
      }
      case ' ':
        if (app.onKey?.('space')) e.preventDefault();
        break;
      case 'l': case 'L':
        app.onKey?.('listen');
        break;
      default:
    }
  }

  // ------------------------------------------------------------------------------------ hover (desktop)
  _hoverSoon(x, y) {
    clearTimeout(this.hoverT);
    this.app.onHover?.(null);
    this.hoverT = setTimeout(() => this.app.onHover?.(x, y), HOVER_MS);
  }

  _hover(v) {
    clearTimeout(this.hoverT);
    if (v === null) this.app.onHover?.(null);
  }
}
