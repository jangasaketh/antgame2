// ---------------------------------------------------------------------------
// audio.js — the whole soundtrack is synthesised at runtime. No audio files,
// so the game still works offline and the repo stays small.
//
// Everything runs through a generated convolution reverb, which is what makes
// it sound like it is happening inside a hole in the ground.
// ---------------------------------------------------------------------------

const SCALES = {
  // minor pentatonic keeps it modal and unresolved — good for creeping around
  aeolian: [0, 3, 5, 7, 10],
  phrygian: [0, 1, 5, 7, 8],
  dorian: [0, 3, 5, 7, 9],
};

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Audio {
  constructor() {
    this.ready = false;
    this.muted = false;
    this.ctx = null;
    this.intensity = 0;      // 0 exploring .. 1 fighting
    this.targetIntensity = 0;
    this.bpm = 84;
    this.step = 0;
    this.nextNoteTime = 0;
    this.timer = null;
    this.root = 45;          // A2
    this.scale = SCALES.aeolian;
    this.motif = [0, 2, 1, 4, 2, 0, 3, 1];
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 16;
    this.limiter.ratio.value = 9;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.22;

    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // ---- cave reverb ------------------------------------------------------
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.#impulse(2.9, 2.6);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.42;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.master);

    // ---- per-layer buses --------------------------------------------------
    this.bus = {};
    for (const name of ['pad', 'bass', 'perc', 'lead', 'sfx']) {
      const g = ctx.createGain();
      g.gain.value = name === 'sfx' ? 0.9 : 0;
      const send = ctx.createGain();
      send.gain.value = name === 'perc' ? 0.22 : (name === 'sfx' ? 0.3 : 0.6);
      g.connect(this.master);
      g.connect(send);
      send.connect(this.verb);
      this.bus[name] = g;
    }

    this.#buildDrone();

    this.ready = true;
    this.nextNoteTime = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.#schedule(), 25);

    // fade the whole mix in
    this.master.gain.setTargetAtTime(0.85, ctx.currentTime, 1.2);
  }

  #impulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // a few early reflections, then a smooth tail
        let s = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        if (i < rate * 0.05) s *= 0.4;
        d[i] = s;
      }
    }
    return buf;
  }

  /** The always-on drone: two detuned saws under a slow filter sweep. */
  #buildDrone() {
    const ctx = this.ctx;
    this.droneOsc = [];
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 340;
    this.droneFilter.Q.value = 3.5;
    this.droneFilter.connect(this.bus.pad);

    for (const det of [-7, 0, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(this.root - 12);
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = 0.16;
      o.connect(g); g.connect(this.droneFilter);
      o.start();
      this.droneOsc.push({ o, g });
    }

    // slow LFO opening and closing the filter, so the drone breathes
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 190;
    lfo.connect(lfoAmt);
    lfoAmt.connect(this.droneFilter.frequency);
    lfo.start();
    this.droneLfo = lfoAmt;
  }

  /** Switch key per level so each floor has its own colour. */
  setLevel(i) {
    if (!this.ready) return;
    const roots = [45, 43, 41, 44, 40];       // A2, G2, F2, G#2, E2
    const modes = ['aeolian', 'dorian', 'aeolian', 'dorian', 'phrygian'];
    this.root = roots[i % roots.length];
    this.scale = SCALES[modes[i % modes.length]];
    const f = mtof(this.root - 12);
    for (const d of this.droneOsc) {
      d.o.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.9);
    }
  }

  /** 0 = wandering alone, 1 = being hunted. Drives the whole arrangement. */
  setIntensity(v) {
    this.targetIntensity = Math.max(0, Math.min(1, v));
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.08);
  }

  // ------------------------------------------------------------ sequencer --
  #schedule() {
    if (!this.ready || this.ctx.state !== 'running') return;
    const ctx = this.ctx;

    // ease the intensity so the arrangement never jumps
    this.intensity += (this.targetIntensity - this.intensity) * 0.04;
    const I = this.intensity;

    const t = ctx.currentTime;
    this.bus.pad.gain.setTargetAtTime(0.19 + I * 0.1, t, 0.6);
    this.bus.bass.gain.setTargetAtTime(0.1 + I * 0.32, t, 0.5);
    this.bus.perc.gain.setTargetAtTime(Math.max(0, I - 0.16) * 0.55, t, 0.5);
    this.bus.lead.gain.setTargetAtTime(0.14 + I * 0.16, t, 0.6);
    this.droneFilter.frequency.setTargetAtTime(300 + I * 620, t, 0.8);

    const spb = 60 / (this.bpm + I * 16);
    const stepDur = spb / 2;                  // eighth notes

    while (this.nextNoteTime < ctx.currentTime + 0.16) {
      this.#playStep(this.step, this.nextNoteTime, I);
      this.nextNoteTime += stepDur;
      this.step = (this.step + 1) % 32;
    }
  }

  #playStep(s, when, I) {
    const beat = s % 8;

    // ---- bass: root pulse, doubling up when things get hot ---------------
    if (beat === 0 || beat === 6 || (I > 0.5 && beat === 3)) {
      const deg = (s < 16) ? 0 : (s < 24 ? 3 : 2);
      this.#bass(mtof(this.root + this.scale[deg] - 12), when, 0.42 + I * 0.2);
    }

    // ---- percussion: a loose hand-drum pattern ---------------------------
    if (I > 0.16) {
      if (beat === 0 || beat === 4) this.#drum(when, 78, 0.5 + I * 0.4);
      if (beat === 2 || beat === 7) this.#drum(when, 146, 0.24 + I * 0.28);
      if (I > 0.62 && (beat === 5 || beat === 3)) this.#tick(when, 0.2);
    }

    // ---- lead motif: sparse when calm, insistent when hunted -------------
    const gate = I > 0.45 ? 2 : 4;
    if (s % gate === 0) {
      const idx = (s / gate) % this.motif.length;
      const deg = this.motif[idx];
      const oct = (I > 0.6 && idx % 3 === 0) ? 12 : 0;
      this.#pluck(mtof(this.root + 12 + this.scale[deg] + oct), when, 0.3 + I * 0.25);
    }

    // ---- a high shimmer that only appears under real pressure ------------
    if (I > 0.72 && s % 16 === 8) {
      this.#shimmer(mtof(this.root + 24 + this.scale[4]), when);
    }
  }

  // ------------------------------------------------------------- voices ----
  #bass(freq, when, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq * 1.8, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.07);
    f.type = 'lowpass';
    f.frequency.value = 420;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.46);
    o.connect(f); f.connect(g); g.connect(this.bus.bass);
    o.start(when); o.stop(when + 0.5);
  }

  #drum(when, freq, gain) {
    const ctx = this.ctx;
    // pitched thump
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 2.4, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.055);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);
    o.connect(g); g.connect(this.bus.perc);
    o.start(when); o.stop(when + 0.3);

    // skin rattle
    const n = this.#noise(0.07);
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = freq * 6;
    nf.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(gain * 0.4, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
    n.connect(nf); nf.connect(ng); ng.connect(this.bus.perc);
    n.start(when);
  }

  #tick(when, gain) {
    const n = this.#noise(0.04);
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 4200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    n.connect(f); f.connect(g); g.connect(this.bus.perc);
    n.start(when);
  }

  #pluck(freq, when, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    o.type = 'triangle';
    o.frequency.value = freq;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2600, when);
    f.frequency.exponentialRampToValueAtTime(700, when + 0.3);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain * 0.3, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.75);
    o.connect(f); f.connect(g); g.connect(this.bus.lead);
    o.start(when); o.stop(when + 0.8);
  }

  #shimmer(freq, when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, when);
    o.frequency.linearRampToValueAtTime(freq * 1.02, when + 1.4);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.07, when + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 1.6);
    o.connect(g); g.connect(this.bus.lead);
    o.start(when); o.stop(when + 1.7);
  }

  #noise(seconds) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  // -------------------------------------------------------------- effects --
  #blip(freq, dur, type, gain, slide = 0, bus = 'sfx') {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bus[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  #burst(dur, filterType, freq, gain, sweep = 0) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.#noise(dur);
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq + sweep), t + dur);
    f.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(this.bus.sfx);
    n.start(t);
  }

  spit()    { this.#burst(0.14, 'bandpass', 2600, 0.24, -1900); this.#blip(700, 0.09, 'sawtooth', 0.05, -430); }
  bite()    { this.#blip(210, 0.1, 'square', 0.07, -120); this.#burst(0.08, 'lowpass', 1200, 0.2); }
  hit()     { this.#blip(1250, 0.05, 'square', 0.07); }
  crit()    { this.#blip(1750, 0.08, 'square', 0.085, 420); }
  kill()    { this.#blip(400, 0.22, 'square', 0.07, -270); this.#burst(0.18, 'lowpass', 900, 0.18, -600); }
  hurt()    { this.#blip(165, 0.2, 'sawtooth', 0.09, -80); }
  pickup()  { this.#blip(880, 0.07, 'triangle', 0.06, 340); }
  drink()   { this.#blip(300, 0.5, 'sine', 0.06, 260); this.#burst(0.4, 'lowpass', 700, 0.1, 400); }
  gate()    { this.#blip(420, 0.36, 'triangle', 0.08, 300); }
  thud()    { this.#blip(72, 0.36, 'sine', 0.11, -28); this.#burst(0.3, 'lowpass', 400, 0.22, -260); }
  dry()     { this.#blip(150, 0.05, 'square', 0.035); }
  splash()  { this.#burst(0.45, 'bandpass', 1500, 0.2, -1100); }
  call()    { this.#blip(520, 0.45, 'triangle', 0.1, 220); this.#blip(780, 0.4, 'sine', 0.06, 160); }
  greet()   { this.#blip(1050, 0.05, 'triangle', 0.035, 180); }
  rumble()  { this.#blip(58, 0.7, 'sine', 0.12, -20); this.#burst(0.7, 'lowpass', 330, 0.24, -220); }
  power()   { this.#blip(330, 0.6, 'triangle', 0.1, 620); this.#blip(660, 0.5, 'sine', 0.07, 440); }
  descend() { this.#blip(300, 0.8, 'sine', 0.1, -190); }
}
