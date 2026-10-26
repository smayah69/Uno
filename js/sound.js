// Synthesized sound effects (Web Audio, no files). Everything goes through a
// small mixer: a compressor for punch and a generated room reverb for depth.
// Muting is remembered.
let ctx = null;
let bus = null; // { dry, wet } inputs of the mixer
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem('uno.muted') === '1'; } catch { /* storage blocked */ }

function audio() {
  // Browsers only allow sound after the first click or key press.
  if (muted || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    comp.connect(master).connect(ctx.destination);
    // Room reverb: decaying stereo noise as the impulse response.
    const len = Math.floor(ctx.sampleRate * 1.6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.28;
    wet.connect(verb).connect(comp);
    bus = { dry: comp, wet };
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const n = noiseBuf.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function out(node, reverb) {
  node.connect(bus.dry);
  if (reverb) node.connect(bus.wet);
}

// A tone with an attack/decay envelope, optional pitch glide and vibrato.
function tone(freq, at, dur, { type = 'sine', gain = 0.2, to = null, attack = 0.005, verb = true, vib = 0, cutoff = null } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  if (vib) {
    const lfo = a.createOscillator();
    const depth = a.createGain();
    lfo.frequency.value = 6;
    depth.gain.value = vib;
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let last = o.connect(g);
  if (cutoff) {
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff / 4), t + dur);
    last = g.connect(f);
  }
  out(last, verb);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// Bell / marimba: a sine with a couple of inharmonic partials.
function bell(freq, at, dur = 0.6, gain = 0.12) {
  tone(freq, at, dur, { gain, attack: 0.002 });
  if (freq * 2.76 < 16000) tone(freq * 2.76, at, dur * 0.4, { gain: gain * 0.35, attack: 0.002 });
  if (freq * 5.4 < 16000) tone(freq * 5.4, at, dur * 0.2, { gain: gain * 0.15, attack: 0.002 });
}

// Filtered noise burst, optionally sweeping (card slides, whooshes, riffles).
function noise(at, dur, { gain = 0.3, type = 'bandpass', freq = 2000, to = null, q = 1, verb = false } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = a.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  out(src.connect(f).connect(g), verb);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12); // MIDI note -> Hz

export const sound = {
  get muted() { return muted; },
  toggle() {
    muted = !muted;
    try { localStorage.setItem('uno.muted', muted ? '1' : '0'); } catch { /* storage blocked */ }
    return muted;
  },
  // A card slapped onto the pile: air, snap, and a soft thump on the table.
  card() {
    noise(0, 0.06, { freq: 3500, to: 1500, gain: 0.18 });
    noise(0.045, 0.05, { freq: 1200, q: 2, gain: 0.45, verb: true });
    tone(150, 0.045, 0.12, { to: 60, gain: 0.35, verb: false });
  },
  // Sliding a card off the deck.
  draw() {
    noise(0, 0.16, { freq: 900, to: 4200, q: 0.8, gain: 0.16 });
    tone(520, 0.08, 0.08, { type: 'triangle', gain: 0.04, to: 780 });
  },
  // A riffle: fast clicks that speed up, then the bridge.
  shuffle() {
    let t = 0;
    for (let i = 0; i < 18; i++) {
      noise(t, 0.025, { freq: 2500 + Math.random() * 2500, q: 3, gain: 0.22 });
      t += 0.045 - i * 0.0012;
    }
    noise(t + 0.05, 0.25, { freq: 1500, to: 600, gain: 0.2, verb: true });
  },
  // Your turn: two soft bells.
  turn() { bell(NOTE(84), 0, 0.7, 0.1); bell(NOTE(88), 0.12, 0.9, 0.09); },
  // Pressing UNO: quick bright blip, confirmation that it's armed.
  armed() { bell(NOTE(91), 0, 0.3, 0.08); bell(NOTE(96), 0.06, 0.4, 0.07); },
  // Someone goes down to one card having said UNO: a brass "ta-da!" and sparkles.
  uno() {
    for (const n of [60, 64, 67, 72]) tone(NOTE(n), 0, 0.18, { type: 'sawtooth', gain: 0.07, cutoff: 3500 });
    for (const n of [65, 69, 72, 77]) tone(NOTE(n), 0.16, 0.55, { type: 'sawtooth', gain: 0.07, cutoff: 4500, vib: 3 });
    [96, 100, 103, 108].forEach((n, i) => bell(NOTE(n), 0.2 + i * 0.05, 0.4, 0.05));
  },
  // Contre-UNO! A referee whistle, then the buzzer for whoever got caught.
  caught() {
    tone(2600, 0, 0.12, { type: 'sine', gain: 0.1, vib: 60, verb: false });
    tone(2600, 0.16, 0.3, { type: 'sine', gain: 0.1, vib: 80, verb: false });
    sound.forgot(0.42);
  },
  // Game-show buzzer.
  forgot(at = 0) {
    for (const t of [at, at + 0.22]) {
      tone(110, t, 0.18, { type: 'square', gain: 0.12, cutoff: 1500, verb: false });
      tone(116, t, 0.18, { type: 'sawtooth', gain: 0.08, cutoff: 1500, verb: false });
    }
  },
  // Skip: a cartoon "bonk".
  skip() {
    tone(700, 0, 0.18, { to: 140, gain: 0.25, verb: false });
    noise(0, 0.03, { freq: 3000, gain: 0.2 });
    bell(NOTE(67), 0.12, 0.3, 0.06);
  },
  // Reverse: whoosh up, whoosh down.
  reverse() {
    noise(0, 0.22, { freq: 500, to: 3500, q: 1.5, gain: 0.25, verb: true });
    noise(0.2, 0.22, { freq: 3500, to: 500, q: 1.5, gain: 0.25, verb: true });
    tone(NOTE(72), 0, 0.2, { type: 'triangle', gain: 0.06, to: NOTE(79) });
    tone(NOTE(79), 0.2, 0.22, { type: 'triangle', gain: 0.06, to: NOTE(72) });
  },
  // Someone has to draw a pile of cards: sad trombone.
  penalty(n = 2) {
    const steps = n >= 4 ? [58, 57, 56, 55] : [58, 55];
    steps.forEach((m, i) => tone(NOTE(m - 12), i * 0.2, i === steps.length - 1 ? 0.55 : 0.2, { type: 'sawtooth', gain: 0.1, cutoff: 1400, vib: i === steps.length - 1 ? 4 : 0 }));
  },
  // Wild card: a magic glissando.
  wild() { [72, 76, 79, 83, 86, 88].forEach((n, i) => bell(NOTE(n), i * 0.04, 0.5, 0.05)); },
  // Saute mouton: a fast rising zip and a ding.
  jump() {
    tone(400, 0, 0.16, { type: 'square', gain: 0.05, to: 2400, cutoff: 6000 });
    noise(0, 0.16, { freq: 1000, to: 6000, q: 2, gain: 0.15 });
    bell(NOTE(93), 0.15, 0.6, 0.1);
  },
  chat() { bell(NOTE(86), 0, 0.25, 0.05); },
  // Round won: fanfare.
  win() {
    const seq = [[67, 0], [72, 0.13], [76, 0.26], [79, 0.39]];
    for (const [n, at] of seq) tone(NOTE(n), at, 0.16, { type: 'sawtooth', gain: 0.08, cutoff: 4000 });
    for (const n of [72, 76, 79, 84]) tone(NOTE(n), 0.55, 1.1, { type: 'sawtooth', gain: 0.07, cutoff: 5000, vib: 3 });
    [96, 100, 103, 108, 103, 108].forEach((n, i) => bell(NOTE(n), 0.6 + i * 0.07, 0.6, 0.05));
  },
  // Round lost: a gentle "aww".
  lose() { [67, 64, 60].forEach((n, i) => tone(NOTE(n), i * 0.18, 0.4, { type: 'triangle', gain: 0.1, vib: i === 2 ? 3 : 0 })); },
  click() { tone(1800, 0, 0.03, { type: 'triangle', gain: 0.05, verb: false }); },
};
