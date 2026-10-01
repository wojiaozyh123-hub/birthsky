// Dev check for audio.js (spec §9) in headless Chromium with autoplay allowed. We cannot listen, so this
// reads the graph: master gain over the 5 s fade-in, the rewind cue fading on an early arrival (跳过) but
// ringing on a natural one, pad ducking, mute ramps, star velocities, ambient bell spacing, chord scheduling,
// node counts and page errors.   node tools/dev/platform-audio.mjs   (~40 s)
import { startServer, launch, watch, sleep } from './platform-harness.mjs';

const { server, base } = await startServer();
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const errors = [];
const results = [];
const expect = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? `  ${info}` : ''}`); };

try {
  const page = await browser.newPage();
  watch(page, errors);
  await page.goto(base + 'dev/platform-audio.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });

  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const out = { log: [] };
    const a = window.a = new Cosmos();
    out.api = ['start', 'setMuted', 'bell', 'star', 'body', 'rewind', 'arrive', 'duck', 'now'].every((k) => typeof a[k] === 'function');
    // spy on bells: ambient ones are the only calls with decay 4.5 and no cue bus
    const bells = [];
    const bell = a.bell.bind(a);
    a.bell = (midi, vel, when = 0, o = {}) => { bells.push({ midi, vel, when, t: a.now(), decay: o.decay, cue: !!o.out }); return bell(midi, vel, when, o); };

    a.setMuted(false);            // unchanged → no-op before start
    // headless Chromium's fake audio device races the clock ~25 s ahead right after a context is created;
    // build first and let it settle so the fade-in is measured in real time
    a.build();
    await wait(1500);
    out.jump = a.ctx.currentTime;
    a.start();
    const an = a.ctx.createAnalyser();
    an.fftSize = 2048;
    a.master.connect(an);
    const buf = new Float32Array(an.fftSize);
    const rms = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
    const t0 = a.now();
    out.state = a.ctx.state;
    await wait(1000);
    out.g1 = a.master.gain.value;
    a.setMuted(false);            // must not cut the 5 s fade
    await wait(1500);
    out.g25 = a.master.gain.value;
    await wait(2900);
    out.g54 = a.master.gain.value;
    out.rmsOn = rms();
    out.chord0 = a.chordIndex;

    // rewind, then 跳过 after 1 s of 3 s
    a.rewind(3);
    const cue1 = a.cue;
    await wait(1000);
    a.arrive();
    out.skipCleared = a.cue === null;
    await wait(700);
    out.skipBells = cue1.bells.gain.value;
    out.skipSwell = cue1.swell.gain.value;
    out.padAfterSkip = a.padBus.gain.value;
    out.chordAfterArrive = a.currentChord.root;
    await wait(1600);
    out.padLater = a.padBus.gain.value;

    // rewind that lands naturally
    a.rewind(1.5);
    const cue2 = a.cue;
    await wait(1560);
    a.arrive();
    await wait(300);
    out.naturalBells = cue2.bells.gain.value;
    out.arriveBells = bells.filter((b) => b.decay === 6).length;
    out.cueBells = bells.filter((b) => b.cue).length;
    out.cueVel = bells.filter((b) => b.cue).map((b) => +b.vel.toFixed(3));

    // notes
    const before = bells.length;
    a.star(0.5, -1.46, 0.0, -0.3, a.now() + 0.05);
    a.star(0.2, 3.4, 1.2, 0.3, a.now() + 0.2);
    a.body('Moon', 0.3, 0);
    a.bell(74, 0.15, 0, { bright: 0.25, decay: 4.5 });
    out.noteVel = bells.slice(before).map((b) => +b.vel.toFixed(3));

    // listen duck
    a.duck(true);
    await wait(2500);
    out.padDucked = a.padBus.gain.value;
    a.duck(false);

    // mute / unmute
    a.setMuted(true);
    await wait(800);
    out.gMuted = a.master.gain.value;
    await wait(300);
    out.rmsMuted = rms();
    a.setMuted(true);             // no-op
    a.setMuted(false);
    await wait(1700);
    out.gUnmuted = a.master.gain.value;

    // keep running for the chord and ambient-bell schedule
    await wait(13000);
    out.chordLater = a.chordIndex;
    out.elapsed = a.now() - t0;
    out.ambient = bells.filter((b) => b.decay === 4.5 && !b.cue && b.vel < 0.27 && b.vel !== 0.15).map((b) => +(b.t - t0).toFixed(2));
    out.ambientVel = bells.filter((b) => b.decay === 4.5 && !b.cue && b.vel !== 0.15).map((b) => +b.vel.toFixed(3));
    out.timers = [typeof a.padTimer, typeof a.bellTimer, 'timers' in a];
    out.audibleVisible = a.audible();
    await a.ctx.suspend();
    out.audibleSuspended = a.audible();
    await a.ctx.resume();
    out.nodes = window.__nodes;
    return out;
  });

  const near = (x, y, tol) => Math.abs(x - y) <= tol;
  expect('API unchanged', r.api);
  expect('context running', r.state === 'running', r.state);
  expect('master fades in over 5 s to 0.55 (exponential)', r.g1 < 0.01 && r.g25 < 0.08 && near(r.g54, 0.55, 0.01), `1 s ${r.g1.toFixed(4)}, 2.5 s ${r.g25.toFixed(4)}, 5.4 s ${r.g54.toFixed(4)}`);
  expect('sound reaches the output', r.rmsOn > 1e-4, `rms ${r.rmsOn.toExponential(2)}`);
  expect('跳过: cue fades, pad returns', r.skipCleared && r.skipBells < 0.01 && r.skipSwell < 0.01 && r.padLater > r.padAfterSkip && r.padLater > 0.6,
    `bells ${r.skipBells.toExponential(1)}, pad ${r.padAfterSkip.toFixed(2)} → ${r.padLater.toFixed(2)}`);
  expect('natural landing: cue keeps ringing', near(r.naturalBells, 1, 1e-6), String(r.naturalBells));
  expect('arrive: 5 bell notes at −30%, pad back to the home chord', r.arriveBells === 10 && r.chordAfterArrive === 38, `${r.arriveBells} arrival bells over 2 arrivals, chord root ${r.chordAfterArrive}`);
  expect('rewind: 12 glass notes at 0.06–0.18', r.cueBells === 24 && Math.min(...r.cueVel) === 0.06 && Math.max(...r.cueVel) === 0.18, r.cueVel.slice(0, 12).join(' '));
  expect('star velocity ≤ 0.40, body 0.40, soft bell as given', r.noteVel[0] === 0.4 && r.noteVel[1] > 0.1 && r.noteVel[1] < 0.13 && r.noteVel[2] === 0.4 && r.noteVel[3] === 0.15, r.noteVel.join(' '));
  expect('聆听 ducks the pad to 0.5', near(r.padDucked, 0.5, 0.06), r.padDucked.toFixed(3));
  expect('mute ramps out in 600 ms, back in 1.5 s', r.gMuted < 0.001 && r.rmsMuted < 1e-4 && near(r.gUnmuted, 0.55, 0.01), `muted ${r.gMuted.toExponential(1)} rms ${r.rmsMuted.toExponential(1)}, unmuted ${r.gUnmuted.toFixed(3)}`);
  expect('chords every 16 s, no stacking after the clock jump', r.chordLater === 2 && r.chord0 === 1, `chordIndex ${r.chord0} at 5 s, ${r.chordLater} at ${r.elapsed.toFixed(1)} s (clock was at ${r.jump.toFixed(1)} s before start)`);
  const gaps = r.ambient.map((t, i) => t - (i ? r.ambient[i - 1] : 0));
  expect('ambient bells: single notes 9–20 s apart, velocity 0.14–0.26', gaps.every((g) => g >= 8.9) && r.ambientVel.every((v) => v >= 0.14 && v <= 0.26), `at ${r.ambient.join(', ')} s`);
  expect('single timers, no growing array', r.timers[0] === 'number' && r.timers[1] === 'number' && r.timers[2] === false);
  expect('no ambient scheduling on a suspended clock', r.audibleVisible && !r.audibleSuspended);
  console.log('nodes created:', JSON.stringify(r.nodes));
} finally {
  await browser.close();
  server.close();
}
if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
process.exit(errors.length || results.some((ok) => !ok) ? 1 : 0);
