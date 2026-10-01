// Generative "cosmic" score, synthesised live with Web Audio — no audio files, nothing licensed.
// Layers: slow pad chords → sparse single bells → faint wind; one-shot cues for the rewind and the arrival;
// star notes for selection and 聆听. Spec §9 「静谧」: fewer, softer, more space; no UI sounds, ever.
//
// Public API (class Cosmos; one instance per page)
//   start()                          from a user gesture (the intro tap). Builds the graph, resumes the
//                                    context, fades the master in over 5 s to 0.55 (stays silent if muted)
//   setMuted(m)                      600 ms out / 1500 ms in; no-op when unchanged, so it never cuts the
//                                    5 s start fade. Persisting the flag (birthsky:muted) is the caller's job
//   bell(midi, vel, when = 0, { bright = 0.5, pan = 0, decay = 3.6 })
//                                    one FM bell. Soft cues: 两个人 line done → bell(74, 0.15, 0, { bright: 0.25,
//                                    decay: 4.5 }); ruler birth tick → bell(79, 0.12, 0, { bright: 0.2, decay: 3.2 })
//   star(alt01, mag, bv, pan, when)  a star's note (selection and 聆听); velocity ≤ 0.40
//   body(id, alt01, when)            the Moon's / a planet's note; velocity 0.40
//   rewind(seconds)                  the rewind cue; call it when the spin starts. If arrive() comes early
//                                    (跳过), the rest of the cue fades out instead of ringing on
//   arrive()                         low bloom + 5-note bell chord, and the pad restarts on the home chord
//   duck(on)                         聆听: pad to 0.5, ambient bells pause
//   now() → seconds                  the audio clock (for scheduling notes)
//   available                        false when Web Audio is missing

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const MASTER = 0.55;
const START_FADE = 5;
const MUTE_OUT = 0.6, MUTE_IN = 1.5;

// D major pentatonic; every chord below sits happily under it
const PENTA = [2, 4, 6, 9, 11];
const CHORDS = [
  { root: 38, notes: [50, 57, 64, 66, 73] },   // Dmaj9
  { root: 35, notes: [47, 54, 61, 62, 69] },   // Bm9
  { root: 43, notes: [55, 62, 66, 69, 73] },   // Gmaj9(#11)
  { root: 45, notes: [52, 57, 62, 64, 71] },   // A6sus
];
const CHORD_SECONDS = 16;
const PAD_GAIN = 0.8;              // × the original voice gains
const PAD_LFO_DEPTH = 300;         // Hz
const BELL_WAIT = [9000, 20000];   // ms between ambient bells
const BELL_VEL = [0.14, 0.26];
const WIND_GAIN = 0.028;
const REWIND_SWELL = 0.05;
const REWIND_NOTES = 12;
const REWIND_VEL = [0.06, 0.18];
const ARRIVE_BLOOM = 0.22;
const ARRIVE_STEPS = [0, 2, 4, 5, 7];  // the old 7-note chord minus its two brightest notes
const ARRIVE_VEL = 0.7;                // −30%
const STAR_VEL_MAX = 0.40;
const BODY_VEL = 0.40;

function pentaNote(index) {
  // index 0 → D3, climbs the pentatonic scale
  const oct = Math.floor(index / 5), deg = ((index % 5) + 5) % 5;
  return 50 + oct * 12 + (PENTA[deg] - 2);
}

function silentWavUrl() {
  const n = 4000, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class Cosmos {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.running = false;
    this.chordIndex = 0;
    this.padTimer = 0;
    this.bellTimer = 0;
    this.listenDuck = 1;
    this.cue = null; // the running rewind cue { end, bells, swell }
  }

  get available() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  /** Must be called from a user gesture (tap). */
  start() {
    if (!this.available) return;
    if (!this.ctx) this.build();
    this.unlockIOS();
    this.ctx.resume?.();
    if (!this.running) {
      this.running = true;
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(0.0001, t);
      this.master.gain.exponentialRampToValueAtTime(this.muted ? 0.0001 : MASTER, t + START_FADE);
      this.nextChordAt = t + 0.1;
      this.schedule();
      this.ambientBells();
      this.startWind();
    }
  }

  unlockIOS() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
    // Playing an (inaudible) media element moves iOS into the "playback" audio session so Web Audio
    // is heard even with the ring/silent switch on silent. Only while sound is on: it would otherwise
    // interrupt the listener's own music for nothing.
    if (!this.silentEl) {
      const el = document.createElement('audio');
      el.setAttribute('x-webkit-airplay', 'deny');
      el.setAttribute('playsinline', '');
      el.loop = true;
      el.preload = 'auto';
      el.src = silentWavUrl();
      this.silentEl = el;
    }
    if (!this.muted) this.silentEl.play().catch(() => {});
  }

  build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC({ latencyHint: 'playback' });
    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 14; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.5;
    this.master.connect(comp).connect(ctx.destination);

    // reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(6.5, 2.4);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 1;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.85;
    this.revSend.connect(this.reverb).connect(revOut).connect(this.master);

    // ping-pong delay for bells
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.32;
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2), fb = ctx.createGain(), tone = ctx.createBiquadFilter();
    dl.delayTime.value = 0.46; dr.delayTime.value = 0.69; fb.gain.value = 0.38;
    tone.type = 'lowpass'; tone.frequency.value = 3200;
    const pl = this.panner(-0.7), pr = this.panner(0.7);
    this.delaySend.connect(dl);
    dl.connect(dr); dr.connect(tone).connect(fb).connect(dl);
    dl.connect(pl).connect(this.master); dr.connect(pr).connect(this.master);
    dl.connect(this.revSend);

    // pad bus with a slowly breathing low-pass
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 1;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1100;
    this.padFilter.Q.value = 0.4;
    const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.045; lfoAmt.gain.value = PAD_LFO_DEPTH;
    lfo.connect(lfoAmt).connect(this.padFilter.frequency);
    lfo.start();
    const padDry = ctx.createGain(), padWet = ctx.createGain();
    padDry.gain.value = 0.55; padWet.gain.value = 0.75;
    this.padBus.connect(this.padFilter);
    this.padFilter.connect(padDry).connect(this.master);
    this.padFilter.connect(padWet).connect(this.revSend);

    this.bellBus = ctx.createGain();
    this.bellBus.gain.value = 1;
    const bellDry = ctx.createGain();
    bellDry.gain.value = 0.6;
    this.bellBus.connect(bellDry).connect(this.master);
    this.bellBus.connect(this.revSend);
    this.bellBus.connect(this.delaySend);

    // a soft, choir-ish waveform for the pad
    const N = 14, real = new Float32Array(N), imag = new Float32Array(N);
    for (let k = 1; k < N; k++) imag[k] = (k % 2 ? 1 : 0.55) / Math.pow(k, 1.7);
    this.padWave = ctx.createPeriodicWave(real, imag);

    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) { this.ctx.suspend?.(); this.silentEl?.pause(); }
      else if (this.running) { this.ctx.resume?.(); if (!this.muted) this.silentEl?.play().catch(() => {}); }
    });
  }

  panner(v) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = v; return p; }
    return ctx.createGain();
  }

  impulse(seconds, decay) {
    const ctx = this.ctx, rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45; // darker tail
        d[i] = lp * Math.pow(1 - t, decay) * (i < rate * 0.02 ? i / (rate * 0.02) : 1);
      }
    }
    return buf;
  }

  setMuted(m) {
    m = !!m;
    if (m === this.muted) return;
    this.muted = m;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.exponentialRampToValueAtTime(m ? 0.0001 : MASTER, t + (m ? MUTE_OUT : MUTE_IN));
    if (m) this.silentEl?.pause();
    else if (this.running) this.silentEl?.play().catch(() => {});
  }

  /** false while the page is hidden or the context is suspended: nothing may pile up on a frozen clock */
  audible() {
    const st = this.ctx.state;
    return this.running && !document.hidden && (st === undefined || st === 'running');
  }

  // ------------------------------------------------------------ pad
  schedule() {
    if (!this.running) return;
    const ctx = this.ctx;
    // the clock ran on while our timers were throttled: resync instead of stacking the missed chords at once
    if (this.nextChordAt < ctx.currentTime - 0.5) this.nextChordAt = ctx.currentTime + 0.1;
    while (this.nextChordAt < ctx.currentTime + 1.5) {
      this.playChord(CHORDS[this.chordIndex % CHORDS.length], this.nextChordAt, CHORD_SECONDS);
      this.chordIndex++;
      this.nextChordAt += CHORD_SECONDS;
    }
    clearTimeout(this.padTimer);
    this.padTimer = setTimeout(() => this.schedule(), 500);
  }

  playChord(chord, t0, dur) {
    const ctx = this.ctx;
    const voices = [...chord.notes.map((m, i) => ({ m, g: (0.045 - i * 0.004) * PAD_GAIN, pan: (i / (chord.notes.length - 1)) * 1.2 - 0.6 })),
      { m: chord.root, g: 0.06 * PAD_GAIN, pan: 0, sub: true }];
    for (const v of voices) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(v.g, t0 + 4.2);
      g.gain.setTargetAtTime(0.0001, t0 + dur, 2.2);
      const p = this.panner(v.pan);
      g.connect(p).connect(this.padBus);
      const oscs = v.sub ? [0] : [-7, 6];
      for (const cents of oscs) {
        const o = ctx.createOscillator();
        if (v.sub) o.type = 'sine'; else o.setPeriodicWave(this.padWave);
        o.frequency.value = mtof(v.m);
        o.detune.value = cents;
        o.connect(g);
        o.start(t0);
        o.stop(t0 + dur + 10);
      }
    }
    this.currentChord = chord;
  }

  // ------------------------------------------------------------ bells
  /** One FM bell. `out` (internal) routes it through a cue's own gain instead of straight to the bell bus. */
  bell(midi, vel, when = 0, { bright = 0.5, pan = 0, decay = 3.6, out = null } = {}) {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx, t = Math.max(ctx.currentTime, when || ctx.currentTime);
    const f = mtof(midi);
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), amp = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * 3.5;
    const index = f * (0.6 + bright * 2.4);
    mg.gain.setValueAtTime(index, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, index * 0.05), t + 0.9);
    mod.connect(mg).connect(car.frequency);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel * 0.16), t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const partial = ctx.createOscillator(), pg = ctx.createGain();
    partial.frequency.value = f * 2.001;
    pg.gain.setValueAtTime(0.0001, t);
    pg.gain.exponentialRampToValueAtTime(Math.max(0.0002, vel * 0.035), t + 0.01);
    pg.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.45);
    const p = this.panner(pan);
    car.connect(amp).connect(p);
    partial.connect(pg).connect(p);
    p.connect(out || this.bellBus);
    for (const o of [car, mod, partial]) { o.start(t); o.stop(t + decay + 0.1); }
  }

  /** Sparse ambience: one quiet note every 9–20 s. */
  ambientBells() {
    if (!this.running) return;
    const wait = BELL_WAIT[0] + Math.random() * (BELL_WAIT[1] - BELL_WAIT[0]);
    clearTimeout(this.bellTimer);
    this.bellTimer = setTimeout(() => {
      if (!this.muted && this.listenDuck > 0.5 && this.audible()) {
        const base = 10 + Math.floor(Math.random() * 6);
        const vel = BELL_VEL[0] + Math.random() * (BELL_VEL[1] - BELL_VEL[0]);
        this.bell(pentaNote(base), vel, this.ctx.currentTime,
          { bright: 0.15 + Math.random() * 0.25, pan: Math.random() * 1.4 - 0.7, decay: 4.5 });
      }
      this.ambientBells();
    }, wait);
  }

  // ------------------------------------------------------------ wind
  startWind() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.7;
    const lfo = ctx.createOscillator(), la = ctx.createGain();
    lfo.frequency.value = 0.03; la.gain.value = 380;
    lfo.connect(la).connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.value = WIND_GAIN;
    src.connect(bp).connect(g);
    g.connect(this.master); g.connect(this.revSend);
    src.start(); lfo.start();
    this.wind = g;
  }

  // ------------------------------------------------------------ cues
  /** The whoosh while time runs backwards; lands at `seconds`. Call it when the spin starts. */
  rewind(seconds) {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx, t = ctx.currentTime, end = t + seconds;
    this.fadeCue(t, 0.05); // a rewind that restarts cuts the previous cue short
    this.padBus.gain.cancelScheduledValues(t);
    this.padBus.gain.setTargetAtTime(0.35, t, 0.6);
    this.padBus.gain.setTargetAtTime(this.padLevel(), end + 0.2, 1.5);
    // the cue's own gains, so an early arrival (跳过) can fade what is still to come
    const bells = ctx.createGain(), swell = ctx.createGain();
    bells.connect(this.bellBus);
    swell.connect(this.master); swell.connect(this.revSend);
    this.cue = { end, bells, swell };
    // reverse-cymbal swell
    const len = Math.floor(ctx.sampleRate * (seconds + 0.2));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass'; hp.Q.value = 0.9;
    hp.frequency.setValueAtTime(300, t);
    hp.frequency.exponentialRampToValueAtTime(5200, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(REWIND_SWELL, Math.max(t + 0.01, end - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.08);
    src.connect(hp).connect(g).connect(swell);
    src.start(t); src.stop(end + 0.3);
    // release the cue's gains once the swell has stopped and the last glass note has rung out (audio clock)
    src.onended = () => setTimeout(() => { try { bells.disconnect(); swell.disconnect(); } catch { /* gone */ } }, 2600);
    // rising glass arpeggio, accelerating
    const n = REWIND_NOTES;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      const when = t + seconds * (1 - Math.pow(1 - k, 1.7)) * 0.96;
      this.bell(pentaNote(6 + Math.round(k * 13)), REWIND_VEL[0] + (REWIND_VEL[1] - REWIND_VEL[0]) * k, when,
        { bright: 0.5, pan: Math.sin(i * 1.7) * 0.6, decay: 2.2, out: bells });
    }
  }

  /** Fades what is left of the rewind cue (only if it has not landed yet). */
  fadeCue(t, tau = 0.12) {
    const cue = this.cue;
    if (!cue) return false;
    this.cue = null;
    if (t >= cue.end - 0.25) return false; // landed naturally: let the last notes ring
    for (const g of [cue.bells, cue.swell]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(1, t);
      g.gain.setTargetAtTime(0.0001, t, tau);
    }
    return true;
  }

  /** The pad level outside the rewind: ducked while 聆听 plays. */
  padLevel() {
    return this.listenDuck < 1 ? 0.5 : 1;
  }

  /** Arrival: a low bloom and a soft bell chord; the pad restarts on the home chord. */
  arrive() {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (this.fadeCue(t)) {
      // skipped: bring the pad back now instead of at the old landing time
      this.padBus.gain.cancelScheduledValues(t);
      this.padBus.gain.setTargetAtTime(this.padLevel(), t + 0.2, 1.5);
    }
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(92, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 1.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(ARRIVE_BLOOM, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8);
    o.connect(g); g.connect(this.master); g.connect(this.revSend);
    o.start(t); o.stop(t + 4);
    ARRIVE_STEPS.forEach((k, i) => {
      this.bell(pentaNote(5 + k), (0.34 - i * 0.025) * ARRIVE_VEL, t + 0.05 + i * 0.07,
        { bright: 0.35, pan: (i % 2 ? 1 : -1) * i * 0.1, decay: 6 });
    });
    // restart the progression on the home chord so the arrival lands on "I"
    this.chordIndex = 0;
    this.nextChordAt = t + 0.4;
  }

  /** Star note for selection and 聆听. alt01: 0 horizon … 1 zenith; brighter stars are louder, ≤ 0.40. */
  star(alt01, mag, bv, pan, when) {
    const idx = Math.round(alt01 * 12) + 2;
    const vel = Math.max(0.08, Math.min(STAR_VEL_MAX, STAR_VEL_MAX - (mag + 1) * 0.065));
    const bright = Math.max(0, Math.min(1, 0.8 - bv * 0.45));
    this.bell(pentaNote(idx), vel, when, { bright, pan, decay: 2.6 + (3 - Math.min(3, mag)) * 0.6 });
  }

  body(id, alt01, when) {
    const notes = { Moon: 38, Venus: 81, Jupiter: 45, Saturn: 43, Mars: 52, Mercury: 76, Sun: 50 };
    const m = notes[id] ?? 50;
    this.bell(m + (alt01 > 0.5 ? 12 : 0), BODY_VEL, when, { bright: 0.15, pan: 0, decay: 7 });
  }

  duck(on) {
    this.listenDuck = on ? 0.4 : 1;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.padBus.gain.setTargetAtTime(this.padLevel(), t, 0.8);
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }
}
