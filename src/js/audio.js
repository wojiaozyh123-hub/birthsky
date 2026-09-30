// Generative "cosmic" score, synthesised live with Web Audio — no audio files, nothing licensed.
// Layers: slow pad chords → shimmer bells → wind; one-shot cues for the time-rewind and the arrival;
// and star notes for the "listen to your sky" sweep.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// D major pentatonic; every chord below sits happily under it
const PENTA = [2, 4, 6, 9, 11];
const CHORDS = [
  { root: 38, notes: [50, 57, 64, 66, 73] },   // Dmaj9
  { root: 35, notes: [47, 54, 61, 62, 69] },   // Bm9
  { root: 43, notes: [55, 62, 66, 69, 73] },   // Gmaj9(#11)
  { root: 45, notes: [52, 57, 62, 64, 71] },   // A6sus
];
const CHORD_SECONDS = 11;

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
    this.timers = [];
    this.listenDuck = 1;
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
      this.master.gain.exponentialRampToValueAtTime(this.muted ? 0.0001 : 0.85, t + 3);
      this.nextChordAt = t + 0.1;
      this.schedule();
      this.ambientBells();
      this.startWind();
    }
  }

  unlockIOS() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
    // Playing an (inaudible) media element moves iOS into the "playback" audio session so Web Audio
    // is heard even with the ring/silent switch on silent.
    if (!this.silentEl) {
      const el = document.createElement('audio');
      el.setAttribute('x-webkit-airplay', 'deny');
      el.setAttribute('playsinline', '');
      el.loop = true;
      el.preload = 'auto';
      el.src = silentWavUrl();
      this.silentEl = el;
    }
    this.silentEl.play().catch(() => {});
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
    lfo.frequency.value = 0.045; lfoAmt.gain.value = 450;
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
      else if (this.running) { this.ctx.resume?.(); this.silentEl?.play().catch(() => {}); }
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
    this.muted = m;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.exponentialRampToValueAtTime(m ? 0.0001 : 0.85, t + (m ? 0.6 : 1.5));
    if (m) this.silentEl?.pause(); else if (this.running) this.silentEl?.play().catch(() => {});
  }

  // ------------------------------------------------------------ pad
  schedule() {
    if (!this.running) return;
    const ctx = this.ctx;
    while (this.nextChordAt < ctx.currentTime + 1.5) {
      this.playChord(CHORDS[this.chordIndex % CHORDS.length], this.nextChordAt, CHORD_SECONDS);
      this.chordIndex++;
      this.nextChordAt += CHORD_SECONDS;
    }
    this.timers.push(setTimeout(() => this.schedule(), 500));
  }

  playChord(chord, t0, dur) {
    const ctx = this.ctx;
    const voices = [...chord.notes.map((m, i) => ({ m, g: 0.045 - i * 0.004, pan: (i / (chord.notes.length - 1)) * 1.2 - 0.6 })),
      { m: chord.root, g: 0.06, pan: 0, sub: true }];
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
  bell(midi, vel, when = 0, { bright = 0.5, pan = 0, decay = 3.6 } = {}) {
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
    p.connect(this.bellBus);
    for (const o of [car, mod, partial]) { o.start(t); o.stop(t + decay + 0.1); }
  }

  ambientBells() {
    if (!this.running) return;
    const wait = 2600 + Math.random() * 5200;
    this.timers.push(setTimeout(() => {
      if (!this.muted && this.listenDuck > 0.5) {
        const base = 10 + Math.floor(Math.random() * 6);
        const count = Math.random() < 0.3 ? 3 : 1;
        for (let i = 0; i < count; i++) {
          this.bell(pentaNote(base + i * 2), 0.28 + Math.random() * 0.2, this.ctx.currentTime + i * 0.23,
            { bright: 0.2 + Math.random() * 0.4, pan: Math.random() * 1.4 - 0.7, decay: 4.5 });
        }
      }
      this.ambientBells();
    }, wait));
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
    g.gain.value = 0.05;
    src.connect(bp).connect(g);
    g.connect(this.master); g.connect(this.revSend);
    src.start(); lfo.start();
    this.wind = g;
  }

  // ------------------------------------------------------------ cues
  /** The whoosh while time runs backwards; lands at `seconds`. */
  rewind(seconds) {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx, t = ctx.currentTime, end = t + seconds;
    this.padBus.gain.cancelScheduledValues(t);
    this.padBus.gain.setTargetAtTime(0.35, t, 0.6);
    this.padBus.gain.setTargetAtTime(1, end + 0.2, 1.5);
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
    g.gain.exponentialRampToValueAtTime(0.09, end - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.08);
    src.connect(hp).connect(g);
    g.connect(this.master); g.connect(this.revSend);
    src.start(t); src.stop(end + 0.3);
    // rising glass arpeggio, accelerating
    const n = 22;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      const when = t + seconds * (1 - Math.pow(1 - k, 1.7)) * 0.96;
      this.bell(pentaNote(6 + Math.round(k * 13)), 0.08 + 0.18 * k, when, { bright: 0.5, pan: Math.sin(i * 1.7) * 0.6, decay: 2.2 });
    }
  }

  /** Arrival: a low bloom and a wide bell chord. */
  arrive() {
    if (!this.ctx || !this.running) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(92, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 1.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8);
    o.connect(g); g.connect(this.master); g.connect(this.revSend);
    o.start(t); o.stop(t + 4);
    [0, 2, 4, 5, 7, 9, 12].forEach((k, i) => {
      this.bell(pentaNote(5 + k), 0.34 - i * 0.025, t + 0.05 + i * 0.07, { bright: 0.35, pan: (i % 2 ? 1 : -1) * i * 0.1, decay: 6 });
    });
    // restart the progression on the home chord so the arrival lands on "I"
    this.chordIndex = 0;
    this.nextChordAt = t + 0.4;
  }

  /** Star note for the listening sweep. alt01: 0 horizon … 1 zenith. */
  star(alt01, mag, bv, pan, when) {
    const idx = Math.round(alt01 * 12) + 2;
    const vel = Math.max(0.12, Math.min(0.62, 0.62 - (mag + 1) * 0.1));
    const bright = Math.max(0, Math.min(1, 0.8 - bv * 0.45));
    this.bell(pentaNote(idx), vel, when, { bright, pan, decay: 2.6 + (3 - Math.min(3, mag)) * 0.6 });
  }

  body(id, alt01, when) {
    const notes = { Moon: 38, Venus: 81, Jupiter: 45, Saturn: 43, Mars: 52, Mercury: 76, Sun: 50 };
    const m = notes[id] ?? 50;
    this.bell(m + (alt01 > 0.5 ? 12 : 0), 0.45, when, { bright: 0.15, pan: 0, decay: 7 });
  }

  duck(on) {
    this.listenDuck = on ? 0.4 : 1;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.padBus.gain.setTargetAtTime(on ? 0.5 : 1, t, 0.8);
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }
}
