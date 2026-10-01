// Unit tests for src/js/motion.js (spec §3b): exact springs, retargeting, paths, caps, fling, drag
// limits, cruise, filters and grab-the-sky. Pure Node, no browser.
//   node tools/dev/test-motion.mjs
import { Camera, angDiff, altForHorizonAt } from '../../src/js/camera.js';
import { Spring, ViewRig, GLIDE, LOOK, FOLLOW, SNAP, FlingTracker, OneEuro, deadzone, grabSolve } from '../../src/js/motion.js';

let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const DEG = Math.PI / 180;
const f3 = (x) => x.toFixed(3);

function makeRig(view = { az: 180, alt: 25, fov: 72 }, w = 390, h = 844) {
  const cam = new Camera();
  cam.setSize(w, h);
  Object.assign(cam, view);
  cam.update();
  const rig = new ViewRig(cam);
  rig.set(view);
  return { cam, rig };
}
/** Run the rig at a fixed frame rate; returns per-frame samples. */
function run(rig, seconds, fps = 60, onFrame) {
  const dt = 1 / fps, out = [];
  for (let i = 0, n = Math.round(seconds * fps); i < n; i++) {
    onFrame?.(i * dt);
    rig.step(dt);
    out.push({ t: (i + 1) * dt, az: rig.az.x, alt: rig.alt.x, fov: Math.exp(rig.lnFov.x), vaz: rig.az.v, valt: rig.alt.v, vln: rig.lnFov.v, speed: rig.speed(), settled: rig.settled() });
  }
  return out;
}
/** Largest on-screen speed (px/s) of a 3×3 probe grid between consecutive frames. */
function maxScreenSpeed(cam0, frames, fps, w = 390, h = 844) {
  const a = new Camera(), b = new Camera();
  a.setSize(w, h); b.setSize(w, h);
  let best = 0;
  for (let i = 1; i < frames.length; i++) {
    Object.assign(a, { az: frames[i - 1].az, alt: frames[i - 1].alt, fov: frames[i - 1].fov }); a.update();
    Object.assign(b, { az: frames[i].az, alt: frames[i].alt, fov: frames[i].fov }); b.update();
    for (const gx of [-0.45, 0, 0.45]) for (const gy of [-0.45, 0, 0.45]) {
      const n = a.unproject(w / 2 + gx * w, h / 2 + gy * h);
      const p = a.project(n, {}), q = b.project(n, {});
      if (p && q) best = Math.max(best, Math.hypot(q.x - p.x, q.y - p.y) * fps);
    }
  }
  return best;
}

console.log('Spring');
{
  // exactness: a fixed-goal spring stepped at any dt lands on the analytic solution
  const w = 3.2, x0 = 10, v0 = -4;
  const exact = (t) => { const d = x0, k = v0 + w * d; return { x: (d + k * t) * Math.exp(-w * t), v: (v0 - w * k * t) * Math.exp(-w * t) }; };
  let worst = 0;
  for (const dt of [1 / 240, 1 / 60, 1 / 30, 1 / 20]) {
    const s = new Spring(x0, { omega: w, tau: 0 }); s.v = v0; s.target(0);
    const n = Math.round(1.5 / dt);
    for (let i = 0; i < n; i++) s.step(dt);
    const e = exact(n * dt);
    worst = Math.max(worst, Math.abs(s.x - e.x), Math.abs(s.v - e.v));
  }
  check('exact step matches the analytic critically damped solution at any dt', worst < 1e-9, `max err ${worst.toExponential(1)}`);

  // from rest, with the prefilter: monotone, no overshoot, starts at zero acceleration
  for (const tau of [0, 0.18, 0.35]) {
    const s = new Spring(0, { omega: 1.9, tau }); s.target(50);
    let prev = 0, mono = true, over = false, a0 = null;
    for (let i = 0; i < 600; i++) {
      const v0 = s.v;
      s.step(1 / 60);
      if (i === 0) a0 = (s.v - v0) * 60;
      if (s.x < prev - 1e-12) mono = false;
      if (s.x > 50 + 1e-9) over = true;
      prev = s.x;
    }
    check(`settles without overshoot (τ ${tau})`, mono && !over, `x=${f3(s.x)}, first-frame accel ${f3(a0)}°/s²`);
  }
  {
    const s = new Spring(0, { omega: 1.9, tau: 0.35 }); s.target(50);
    s.step(1 / 60);
    const s2 = new Spring(0, { omega: 1.9, tau: 0 }); s2.target(50);
    s2.step(1 / 60);
    check('prefilter: a move starts gently (first-frame velocity ≪ unfiltered)', s.v < 0.1 * s2.v, `${f3(s.v)} vs ${f3(s2.v)} °/s`);
  }
  // retarget keeps x and v
  {
    const s = new Spring(0, { omega: 3.2, tau: 0.18 }); s.target(40);
    for (let i = 0; i < 30; i++) s.step(1 / 60);
    const x = s.x, v = s.v;
    const aBefore = (() => { const t = new Spring(0); Object.assign(t, s); t.step(1 / 60); return (t.v - v) * 60; })();
    s.target(-20, { omega: 3.2 });
    check('retarget keeps position and velocity', s.x === x && s.v === v, `v=${f3(v)}°/s`);
    s.step(1 / 60);
    const aAfter = (s.v - v) * 60;
    check('retarget: the acceleration changes by < 10% of an unfiltered retarget (prefilter)', Math.abs(aAfter - aBefore) < 0.1 * 3.2 * 3.2 * 60,
      `accel ${f3(aBefore)} → ${f3(aAfter)}°/s² (unfiltered it would jump by ${f3(3.2 * 3.2 * 60)})`);
  }
}

console.log('ViewRig: GLIDE / LOOK / settle / caps');
{
  const { cam, rig } = makeRig();
  let resolved = null;
  rig.setTarget({ az: 220, alt: 30, fov: 72 }, GLIDE).then((r) => { resolved = r; });
  check('a fresh target is not "settled" at v = 0', !rig.settled());
  const fr = run(rig, 8);
  await Promise.resolve();
  const over = fr.some((f) => f.az > 220 + 1e-6 || f.alt > 30 + 1e-6);
  const tSettle = fr.find((f) => f.settled)?.t;
  check('GLIDE reaches the target without overshoot', !over && Math.abs(rig.az.x - 220) < 0.1 && Math.abs(rig.alt.x - 30) < 0.1, `settled at ${tSettle?.toFixed(2)} s`);
  check('setTarget promise resolves true on settle', resolved === true);
  check('camera follows the rig', cam.az === rig.az.x && Math.abs(cam.fov - 72) < 1e-9);
  let maxDv = 0;
  for (let i = 1; i < fr.length; i++) maxDv = Math.max(maxDv, Math.abs(fr[i].vaz - fr[i - 1].vaz));
  check('GLIDE velocity is continuous', maxDv < 1.5, `max Δv/frame ${f3(maxDv)}°/s`);
}
{
  // a big LOOK hits the pan cap: horizontal sky speed ≤ 36°/s, no star over 540 px/s
  const { cam, rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  rig.setTarget({ az: 65, alt: 25 }, LOOK);
  const fr = run(rig, 6);
  const peak = Math.max(...fr.map((f) => Math.abs(f.vaz) * Math.cos(f.alt * DEG)));
  const px = maxScreenSpeed(cam, fr, 60);
  check('LOOK Δaz 65°: pan cap 36°/s binds', peak <= 36.01, `peak ${f3(peak)}°/s`);
  check('LOOK Δaz 65°: every probe ≤ 540 px/s', px <= 545, `peak ${px.toFixed(1)} px/s`);
  check('LOOK still arrives', Math.abs(rig.az.x - 65) < 0.1 && rig.settled());
}
{
  // zoom cap: a SNAP of the fov from 100° to 30°
  const { cam, rig } = makeRig({ az: 0, alt: 40, fov: 100 });
  rig.setTarget({ fov: 30 }, SNAP);
  const fr = run(rig, 3);
  const px = maxScreenSpeed(cam, fr, 60);
  check('fov SNAP 100→30: every probe ≤ 540 px/s', px <= 560, `peak ${px.toFixed(1)} px/s`);
}
{
  // FOLLOW is not capped (the gyro must keep up with the hand)
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  const fr = run(rig, 1, 60, (t) => rig.follow({ az: t * 120, alt: 25 }));
  const peak = Math.max(...fr.map((f) => Math.abs(f.vaz)));
  check('FOLLOW tracks a 120°/s turn uncapped', peak > 100, `peak ${f3(peak)}°/s, lag ${f3(120 - rig.az.x)}°`);
}
{
  // GLIDE with |Δaz| > 70° becomes a path; {path:false} keeps a spring
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  rig.setTarget({ az: 150 }, GLIDE);
  check('GLIDE with |Δaz| > 70° routes through a path', !!rig.pathSt);
  rig.setTarget({ az: 150 }, GLIDE, { path: false });
  check('{path:false} keeps it a spring', !rig.pathSt);
}
{
  // a fov-only target leaves a dragging finger in charge of az/alt (look-up widening)
  const { rig } = makeRig({ az: 0, alt: 70, fov: 72 });
  rig.catch();
  rig.drag({ az: 0, alt: 74 }, 0);
  rig.setTarget({ fov: 100 }, GLIDE);
  check('fov-only target during a drag keeps the drag', rig.dragging);
  run(rig, 3);
  check('…and widens the fov meanwhile', Math.exp(rig.lnFov.x) > 95, `fov ${f3(Math.exp(rig.lnFov.x))}°`);
}

console.log('Paths');
{
  const stand = altForHorizonAt(0.82, 72);
  const { cam, rig } = makeRig({ az: 0, alt: 28.3, fov: 84 });
  let res = null;
  rig.path({ az: 180, alt: stand, fov: 72 }, { kind: 'arrival' }).then((r) => { res = r; });
  const st = rig.pathSt;
  const fr = run(rig, 7);
  await Promise.resolve();
  const end = fr[fr.length - 1];
  const done = fr.find((f) => f.speed === 0)?.t ?? null;
  check('arrival path T = clamp(2.6 + |Δaz|/90, 2.6, 4.5)', Math.abs(st.T - 4.5) < 1e-9, `T ${st.T}s, L ${st.L}°, fov lift ${st.F}°`);
  check('path lands exactly on the target', Math.abs(angDiff(end.az, 180)) < 1e-9 && Math.abs(end.alt - stand) < 1e-9 && Math.abs(end.fov - 72) < 1e-9);
  check('path resolves true', res === true, `finished at ${done?.toFixed(2)} s (speed caps may stretch it)`);
  const peakAlt = Math.max(...fr.map((f) => f.alt));
  check('lift L = min(30, 62 − max(alt0, alt1)) raises the middle', peakAlt > 28.3 + 20 && peakAlt < 62, `peak alt ${f3(peakAlt)}°`);
  const peakFov = Math.max(...fr.map((f) => f.fov));
  check('fov lifts by ≤12° mid-turn', peakFov > 84 && peakFov < 84 + 12.1, `peak fov ${f3(peakFov)}°`);
  // derivatives: zero at both ends
  const first = fr[0], lastMoving = fr.filter((f) => f.speed > 0).pop();
  check('starts at rest (min-jerk: zero velocity and acceleration)', Math.abs(first.vaz) < 0.05, `v(1st frame) ${f3(first.vaz)}°/s`);
  check('ends at rest', Math.abs(lastMoving?.vaz ?? 0) < 0.05 && end.speed === 0, `v(last moving frame) ${f3(lastMoving?.vaz ?? 0)}°/s`);
  let maxDv = 0;
  for (let i = 1; i < fr.length; i++) maxDv = Math.max(maxDv, Math.abs(fr[i].vaz - fr[i - 1].vaz), Math.abs(fr[i].valt - fr[i - 1].valt));
  check('path velocity is continuous', maxDv < 3, `max Δv/frame ${f3(maxDv)}°/s`);
  const pan = Math.max(...fr.map((f) => Math.abs(f.vaz) * Math.cos(f.alt * DEG)));
  check('path respects the pan cap (time dilation)', pan <= 36.01, `peak ${f3(pan)}°/s`);
  const px = maxScreenSpeed(cam, fr, 60);
  check('path: every probe ≤ 540 px/s', px <= 545, `peak ${px.toFixed(1)} px/s`);
}
{
  // small turn: 6° lift, move T = clamp(1.8 + |Δaz|/90, 1.8, 4)
  const { rig } = makeRig({ az: 100, alt: 25, fov: 72 });
  rig.path({ az: 130, alt: 25 }, { kind: 'move' });
  const st = rig.pathSt;
  const fr = run(rig, 4);
  const peakAlt = Math.max(...fr.map((f) => f.alt));
  check('small path: T and 6° lift', Math.abs(st.T - (1.8 + 30 / 90)) < 1e-9 && Math.abs(peakAlt - 31) < 0.05, `T ${st.T.toFixed(3)}s, peak alt ${f3(peakAlt)}°`);
}
{
  // interrupting a path with setTarget keeps its velocity
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  let res = null;
  rig.path({ az: 160, alt: 25 }).then((r) => { res = r; });
  run(rig, 1.2);
  const v = { az: rig.az.v, alt: rig.alt.v };
  rig.setTarget({ az: 60, alt: 25 }, LOOK, { path: false });
  await Promise.resolve();
  check('superseded path resolves false', res === false);
  check('setTarget inherits the path velocity', rig.az.v === v.az && rig.alt.v === v.alt, `v ${f3(v.az)}°/s`);
  const fr = run(rig, 5);
  let maxDv = Math.abs(fr[0].vaz - v.az);
  for (let i = 1; i < fr.length; i++) maxDv = Math.max(maxDv, Math.abs(fr[i].vaz - fr[i - 1].vaz));
  check('…and bends without a jump', maxDv < 6, `max Δv/frame ${f3(maxDv)}°/s`);
}
{
  // chaining: a path started while moving absorbs the old velocity
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  rig.fling(40, 0);
  run(rig, 0.2);
  const v0 = rig.az.v;
  rig.path({ az: 150, alt: 25 });
  const fr = run(rig, 8);
  check('path started while moving keeps the old velocity at t = 0', Math.abs(fr[0].vaz - v0) < 1, `v ${f3(v0)} → ${f3(fr[0].vaz)}°/s`);
  let maxDv = 0, maxJerk = 0;
  for (let i = 1; i < fr.length; i++) maxDv = Math.max(maxDv, Math.abs(fr[i].vaz - fr[i - 1].vaz));
  for (let i = 2; i < fr.length; i++) maxJerk = Math.max(maxJerk, Math.abs(fr[i].vaz - 2 * fr[i - 1].vaz + fr[i - 2].vaz));
  check('…and blends into the path without a jolt (acceleration continuous)', maxDv < 2 && maxJerk < 0.3, `max Δv/frame ${f3(maxDv)}°/s, max Δ²v ${f3(maxJerk)}`);
  check('…and still lands on target', Math.abs(angDiff(rig.az.x, 150)) < 1e-6);
}

{
  // a path issued the instant after a fling (no step in between) must not inherit a spurious acceleration
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  rig.fling(120, 0);
  rig.step(1 / 60);
  rig.path({ az: 60, alt: 25 });
  const fr = run(rig, 5);
  const over = Math.max(...fr.map((f) => angDiff(60, f.az)));
  check('path right after a fling: bounded overshoot, lands on target', over < 12 && Math.abs(angDiff(rig.az.x, 60)) < 1e-6, `max past target ${f3(over)}°`);
}

console.log('catch / drag / release / fling');
{
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  let res = null;
  rig.path({ az: 150, alt: 25 }).then((r) => { res = r; });
  run(rig, 1);
  const v = rig.catch();
  await Promise.resolve();
  check('catch stops a path and hands back its velocity', !rig.pathSt && res === false && Math.abs(v.az) > 5 && rig.az.v === 0, `path v ${f3(v.az)}°/s`);
  const x = rig.az.x;
  run(rig, 1);
  check('caught rig stays put', Math.abs(rig.az.x - x) < 1e-9 && rig.settled());
}
{
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  rig.fling(300, 0);
  check('fling clamps to 180°/s (horizontal sky speed)', Math.abs(rig.az.v * Math.cos(25 * DEG) - 180) < 1e-6);
  const v0 = rig.az.v;
  run(rig, 0.5);
  check('fling decays as e^(−t/0.5)', Math.abs(rig.az.v / v0 - Math.exp(-1)) < 0.01, `ratio ${f3(rig.az.v / v0)}`);
  const fr = run(rig, 6);
  const stop = fr.find((f) => f.vaz === 0);
  check('fling stops below 0.5°/s', !!stop && !rig.flingSt, `stopped at +${stop?.t.toFixed(2)} s`);
}
{
  const { rig } = makeRig({ az: 0, alt: 25, fov: 72 });
  const lo = rig.altMin(72);
  rig.catch();
  rig.drag({ az: 0, alt: 10 }, 0);
  rig.drag({ az: 0, alt: -10 }, 16);
  check('drag below the limit is a rubber band (×0.35)', Math.abs(rig.alt.x - (lo + (-10 - lo) * 0.35)) < 1e-9, `limit ${f3(lo)}°, shown ${f3(rig.alt.x)}°`);
  rig.release(null);
  const fr = run(rig, 2);
  check('release SNAPs back to the limit', Math.abs(rig.alt.x - lo) < 0.01 && rig.settled(), `alt ${f3(rig.alt.x)}°, settled at ${fr.find((f) => f.settled)?.t.toFixed(2)} s`);
  check('horizon limit is 0.55H', Math.abs(lo - altForHorizonAt(0.55, 72)) < 1e-9);
}
{
  // pinch: fov rubber band and SNAP back
  const { rig } = makeRig({ az: 0, alt: 40, fov: 72 });
  rig.catch();
  rig.drag({ az: 0, alt: 40, fov: 140 }, 0);
  const shown = Math.exp(rig.lnFov.x);
  rig.release(null);
  run(rig, 2);
  check('pinch past 100° rubber-bands and SNAPs back', shown > 100 && shown < 140 && Math.abs(Math.exp(rig.lnFov.x) - 100) < 0.05, `shown ${f3(shown)}°, rest ${f3(Math.exp(rig.lnFov.x))}°`);
}

console.log('cruise (listen)');
{
  const { rig } = makeRig({ az: 0, alt: 35, fov: 84 });
  rig.cruise(7.5);
  const fr = run(rig, 10);
  const at15 = fr.find((f) => f.t >= 1.5 - 1e-9);
  check('cruise ramps to 7.5°/s over 1.5 s', Math.abs(at15.vaz - 7.5) < 0.05 && Math.abs(fr[0].vaz) < 0.1, `v(1.5 s) ${f3(at15.vaz)}°/s`);
  let stopped = null;
  rig.cruiseStop().then((r) => { stopped = r; });
  const fr2 = run(rig, 3);
  await Promise.resolve();
  const at2 = fr2.find((f) => f.t >= 2 - 1e-9);
  check('cruiseStop eases to rest over 2 s', stopped === true && Math.abs(at2.vaz) < 1e-9 && rig.settled());
  let maxDv = 0;
  const all = fr.concat(fr2);
  for (let i = 1; i < all.length; i++) maxDv = Math.max(maxDv, Math.abs(all[i].vaz - all[i - 1].vaz));
  check('cruise velocity continuous', maxDv < 0.2, `max Δv/frame ${f3(maxDv)}°/s`);
}

console.log('FlingTracker / OneEuro / deadzone');
{
  const tr = new FlingTracker();
  for (let i = 0; i <= 10; i++) tr.add(1000 + i * 16, 10 + 0.8 * i, 30 - 0.16 * i);
  const v = tr.velocity(1000 + 160 + 5);
  check('LSQ velocity of a steady drag', Math.abs(v.az - 50) < 1e-6 && Math.abs(v.alt + 10) < 1e-6, `${f3(v.az)}, ${f3(v.alt)} °/s`);
  const stale = tr.velocity(1000 + 160 + 61);
  check('0 when the last sample is older than 60 ms', stale.az === 0 && stale.alt === 0);
  tr.reset(); tr.add(0, 0, 0); tr.add(16, 1, 0);
  check('0 with fewer than 3 samples', tr.velocity(20).az === 0);
  tr.reset();
  for (let i = 0; i <= 20; i++) tr.add(i * 16, i < 12 ? 0 : (i - 12) * 2, 0); // late flick: only the last 80 ms count
  const late = tr.velocity(20 * 16);
  check('uses only the last 80 ms', Math.abs(late.az - 125) < 1e-6, `${f3(late.az)}°/s`);
}
{
  const f = new OneEuro();
  let rnd = 1;
  const noise = () => { rnd = (rnd * 16807) % 2147483647; return (rnd / 2147483647 - 0.5) * 2; };
  let errIn = 0, errOut = 0, x;
  for (let i = 0; i < 600; i++) { const t = i / 60; const raw = 30 + 0.8 * noise(); x = f.filter(raw, t); if (i > 60) { errIn += (raw - 30) ** 2; errOut += (x - 30) ** 2; } }
  check('One-Euro removes jitter at rest', errOut < errIn * 0.1, `rms ${Math.sqrt(errIn / 539).toFixed(3)} → ${Math.sqrt(errOut / 539).toFixed(3)}°`);
  let lag = 0;
  for (let i = 600; i < 720; i++) { const t = i / 60; const raw = 30 + (t - 10) * 60; x = f.filter(raw, t); lag = raw - x; }
  check('One-Euro keeps lag small while turning', lag < 6, `lag at 60°/s ${f3(lag)}°`);
  check('deadzone holds inside ±0.35°', deadzone(10, 10.3) === 10 && deadzone(10, 9.7) === 10);
  check('deadzone follows outside, continuously', Math.abs(deadzone(10, 11) - 10.65) < 1e-12 && Math.abs(deadzone(10, 9) - 9.35) < 1e-12);
}

console.log('grabSolve');
{
  const cam = new Camera();
  cam.setSize(390, 844);
  let rnd = 7;
  const r = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const err = (sol, s0, x, y) => {
    const c2 = new Camera(); c2.setSize(390, 844); Object.assign(c2, { az: sol.az, alt: sol.alt, fov: sol.fov }); c2.update();
    const p = c2.project(s0, {});
    return p ? Math.hypot(p.x - x, p.y - y) : Infinity;
  };
  let worst = 0, n = 0, out = 0;
  for (let trial = 0; trial < 2000; trial++) {
    Object.assign(cam, { az: r() * 360, alt: trial % 2 ? 85 + r() * 5 : 2 + r() * 83, fov: 20 + r() * 80, Pfixed: null });
    cam.update();
    const x0 = 10 + r() * 370, y0 = 10 + r() * 824;
    const s0 = cam.unproject(x0, y0);
    const x1 = x0 + (r() - 0.5) * 160, y1 = y0 + (r() - 0.5) * 160;
    const sol = grabSolve(cam, s0, x1, y1);
    if (!sol.exact || sol.alt > 90) { out++; continue; } // unreachable without roll, or past the zenith (rubber band)
    worst = Math.max(worst, err(sol, s0, x1, y1)); n++;
  }
  check('grabbed star lands exactly under the finger (alt 2–90°, fov 20–100°, 80 px jumps)', worst < 0.01, `${n} drags, worst ${worst.toExponential(2)} px (${out} unreachable or past the zenith)`);

  // a slow drag straight up through the zenith's screen point and back: continuous, never flips
  const { rig, cam: c } = makeRig({ az: 180, alt: 70, fov: 72 });
  const s1 = c.unproject(195, 260);
  rig.catch();
  let maxStep = 0, prev = rig.view, worstE = 0, maxAlt = 0;
  const ys = [];
  for (let i = 0; i <= 120; i++) ys.push(260 + i * 4);
  for (let i = 119; i >= 0; i--) ys.push(260 + i * 4);
  ys.forEach((y, i) => {
    const sol = grabSolve(c, s1, 195 + 30 * Math.sin(i / 20), y);
    rig.drag(sol, i * 16);
    const v = rig.view;
    maxStep = Math.max(maxStep, Math.abs(angDiff(prev.az, v.az)) * Math.cos(Math.min(89.9, v.alt) * DEG), Math.abs(v.alt - prev.alt));
    if (sol.exact && sol.alt <= 90) worstE = Math.max(worstE, err(sol, s1, 195 + 30 * Math.sin(i / 20), y));
    maxAlt = Math.max(maxAlt, v.alt);
    prev = v;
  });
  check('drag up to and past the zenith and back is continuous', maxStep < 1.5, `max per-move step ${f3(maxStep)}° (on the sky), peak alt ${f3(maxAlt)}° (rubber band)`);
  check('…with the star under the finger wherever reachable', worstE < 0.01, `worst ${worstE.toExponential(2)} px`);
  rig.release(null);
  run(rig, 2);
  check('…and SNAPs back to 90° when released past it', Math.abs(rig.alt.x - Math.min(90, maxAlt)) < 0.05 || rig.alt.x <= 90.01, `alt ${f3(rig.alt.x)}°`);

  // near the zenith a sideways drag turns the sky the way the finger goes (no flip)
  Object.assign(cam, { az: 30, alt: 88, fov: 100, Pfixed: null }); cam.update();
  const s2 = cam.unproject(300, 422);
  let a = cam.az, mono = true;
  for (let i = 1; i <= 30; i++) {
    const sol = grabSolve(cam, s2, 300, 422 + i * 6);
    if (angDiff(a, sol.az) < -1e-9) mono = false;
    a = sol.az;
    Object.assign(cam, { az: sol.az, alt: sol.alt }); cam.update();
  }
  check('at alt 88° a drag around the zenith turns az one way only', mono, `az 30° → ${f3(a)}°`);

  // pinch: the midpoint's sky point stays put while the fov changes
  Object.assign(cam, { az: 150, alt: 30, fov: 72 }); cam.update();
  const sm = cam.unproject(250, 500);
  const sol = grabSolve(cam, sm, 250, 500, 40);
  check('pinch anchor stays under the fingers', err(sol, sm, 250, 500) < 0.01, `err ${err(sol, sm, 250, 500).toExponential(2)} px`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
