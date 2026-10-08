// Démo autonome : on synthétise le début de la « Lettre à Élise » (Beethoven, domaine public)
// en fichier WAV, puis on le fait passer dans le vrai pipeline de transcription.

const STEP = 0.21; // durée d'une double croche, en secondes
const LEAD_IN = 0.4;

// [note MIDI, pas de départ, durée en pas]
const SCORE = [
  [76, 0, 1], [75, 1, 1], [76, 2, 1], [75, 3, 1], [76, 4, 1], [71, 5, 1], [74, 6, 1], [72, 7, 1],
  [69, 8, 2], [45, 8, 2], [52, 9, 2], [57, 10, 2], [60, 11, 1], [64, 12, 1], [69, 13, 1],
  [71, 14, 2], [40, 14, 2], [52, 15, 2], [56, 16, 2], [64, 17, 1], [68, 18, 1], [71, 19, 1],
  [72, 20, 2], [45, 20, 2], [52, 21, 2], [57, 22, 2], [64, 23, 1], [76, 24, 1], [75, 25, 1],
  [76, 26, 1], [75, 27, 1], [76, 28, 1], [71, 29, 1], [74, 30, 1], [72, 31, 1],
  [69, 32, 2], [45, 32, 2], [52, 33, 2], [57, 34, 2], [60, 35, 1], [64, 36, 1], [69, 37, 1],
  [71, 38, 2], [40, 38, 2], [52, 39, 2], [56, 40, 2], [64, 41, 1], [72, 42, 1], [71, 43, 1],
  [69, 44, 4], [45, 44, 3], [52, 45, 2], [57, 46, 2],
];

// Échantillons du Salamander Grand Piano (Alexander Holm, CC-BY 3.0), hébergés par Tone.js :
// un enregistrement toutes les tierces mineures (A0, C1, D#1, F#1…), transposé pour les notes intermédiaires.
const SAMPLES_URL = 'https://tonejs.github.io/audio/salamander/';
const SAMPLE_NAMES = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };

function nearestSample(pitch) {
  const base = Math.min(108, Math.max(21, 21 + Math.round((pitch - 21) / 3) * 3));
  return { base, name: `${SAMPLE_NAMES[base % 12]}${Math.floor(base / 12) - 1}` };
}

async function loadSamples(ctx, pitches) {
  const bases = new Map(pitches.map((p) => [nearestSample(p).base, nearestSample(p).name]));
  const entries = await Promise.all(
    [...bases].map(async ([base, name]) => {
      const res = await fetch(`${SAMPLES_URL}${name}.mp3`);
      if (!res.ok) throw new Error(`échantillon ${name} : HTTP ${res.status}`);
      return [base, await ctx.decodeAudioData(await res.arrayBuffer())];
    }),
  );
  return new Map(entries);
}

function playSample(ctx, out, samples, pitch, start, dur) {
  const { base } = nearestSample(pitch);
  const src = ctx.createBufferSource();
  src.buffer = samples.get(base);
  src.playbackRate.value = 2 ** ((pitch - base) / 12);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(1, start);
  gain.gain.setTargetAtTime(0, start + dur, 0.08); // les étouffoirs retombent au relâchement
  src.connect(gain).connect(out);
  src.start(start);
  src.stop(start + dur + 0.6);
}

// Repli hors ligne : timbre très simplifié, quelques harmoniques qui s'éteignent d'autant plus vite qu'elles sont aiguës.
const HARMONICS = [[1, 1], [2, 0.5], [3, 0.22], [4, 0.12], [5, 0.06]];

function strike(ctx, out, pitch, start, dur) {
  const f0 = 440 * 2 ** ((pitch - 69) / 12);
  const end = start + dur;
  for (const [h, amp] of HARMONICS) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f0 * h;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(amp, start + 0.004);
    gain.gain.setTargetAtTime(0, start + 0.004, 0.9 / h);
    gain.gain.setTargetAtTime(0, end, 0.04); // relâchement de la touche
    osc.connect(gain).connect(out);
    osc.start(start);
    osc.stop(end + 0.4);
  }
}

function encodeWav(buffer) {
  const samples = buffer.getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const writeStr = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return view.buffer;
}

export async function renderDemoFile() {
  const sampleRate = 44100;
  const lastEnd = Math.max(...SCORE.map(([, s, d]) => (s + d) * STEP));
  const ctx = new OfflineAudioContext(1, Math.ceil((LEAD_IN + lastEnd + 1.5) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);

  let samples = null;
  try {
    samples = await loadSamples(ctx, SCORE.map(([pitch]) => pitch));
  } catch (e) {
    console.warn('Échantillons de piano indisponibles, synthèse simplifiée à la place.', e);
  }
  master.gain.value = samples ? 0.6 : 0.3;
  for (const [pitch, s, d] of SCORE) {
    const start = LEAD_IN + s * STEP;
    if (samples) playSample(ctx, master, samples, pitch, start, d * STEP);
    else strike(ctx, master, pitch, start, d * STEP);
  }
  const buffer = await ctx.startRendering();
  return new File([encodeWav(buffer)], 'lettre-a-elise-demo.wav', { type: 'audio/wav' });
}

/** Partition de référence (en secondes), pour mesurer la précision de la transcription de la démo. */
export const DEMO_REFERENCE = SCORE.map(([pitch, s, d]) => ({
  pitch,
  start: LEAD_IN + s * STEP,
  end: LEAD_IN + (s + d) * STEP,
}));
