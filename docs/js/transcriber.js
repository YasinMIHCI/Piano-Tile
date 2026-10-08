// Transcription audio → notes, entièrement dans le navigateur, avec basic-pitch (Spotify) sur TensorFlow.js.

const BASIC_PITCH = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1';
// Même URL que celle importée par basic-pitch : on obtient la même instance de TensorFlow.js.
const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.19.0/+esm';
const TONEJS_MIDI = 'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm';

const SAMPLE_RATE = 22050; // fréquence attendue par le modèle
const FRAMES_PER_SECOND = Math.floor(SAMPLE_RATE / 256); // 86 trames d'annotation par seconde
const PIANO_MIN = 21; // A0
const PIANO_MAX = 108; // C8
export const MAX_DURATION_S = 12 * 60;

let libsPromise = null;

/** Charge basic-pitch, TensorFlow.js et les poids du modèle (≈ 1 Mo), une seule fois. */
export function loadModel() {
  libsPromise ??= (async () => {
    const [bp, tf] = await Promise.all([import(`${BASIC_PITCH}/+esm`), import(TFJS)]);
    const model = new bp.BasicPitch(`${BASIC_PITCH}/model/model.json`);
    await model.model;
    return { bp, tf, model };
  })();
  libsPromise.catch(() => {
    libsPromise = null; // permet de réessayer après une erreur réseau
  });
  return libsPromise;
}

/** Décode n'importe quel format lu par le navigateur, mixé en mono et rééchantillonné à 22 050 Hz. */
export async function decodeAudioFile(file) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buffer.duration > MAX_DURATION_S) {
    throw new Error(`Morceau trop long (${Math.round(buffer.duration / 60)} min, max ${MAX_DURATION_S / 60} min).`);
  }
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

/** Passe l'audio dans le réseau. Renvoie les sorties brutes, réutilisables pour recalculer les notes. */
export async function runModel(samples, onProgress) {
  const { tf, model } = await loadModel();
  const frames = [];
  const onsets = [];
  const contours = [];
  tf.engine().startScope(); // libère tous les tenseurs intermédiaires à la fin
  try {
    await model.evaluateModel(
      samples,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      onProgress,
    );
  } finally {
    tf.engine().endScope();
  }
  return { frames, onsets, contours };
}

const copy2d = (rows) => rows.map((row) => row.slice());

/**
 * Sorties brutes du réseau → liste de notes nettoyées.
 * @param {{frames:number[][], onsets:number[][]}} raw
 * @param {{onsetThreshold:number, frameThreshold:number, minNoteMs:number, removeGhosts:boolean}} settings
 */
export async function decodeNotes(raw, { onsetThreshold, frameThreshold, minNoteMs, removeGhosts }) {
  const { bp } = await loadModel();
  const minNoteFrames = Math.max(1, Math.round((minNoteMs * FRAMES_PER_SECOND) / 1000));
  // outputToNotesPoly modifie ses entrées : on travaille sur des copies pour pouvoir recalculer.
  const events = bp.outputToNotesPoly(
    copy2d(raw.frames),
    copy2d(raw.onsets),
    onsetThreshold,
    frameThreshold,
    minNoteFrames,
    true, // déduire les attaques manquantes à partir des trames
    4186, // fréquence max : C8
    27.5, // fréquence min : A0
    true, // « melodia trick » : supprime les résonances isolées
  );
  const notes = bp.noteFramesToTime(events).map((n) => ({
    pitch: n.pitchMidi,
    start: n.startTimeSeconds,
    end: n.startTimeSeconds + n.durationSeconds,
    velocity: Math.min(127, Math.max(1, Math.round(n.amplitude * 127))),
  }));
  return cleanNotes(notes, { octaveGhostRatio: removeGhosts ? 0.75 : null });
}

/**
 * Supprime les « octaves fantômes » : l'harmonique d'une note réellement jouée, détectée comme une
 * note distincte une octave plus haut (ou plus bas), qui démarre pendant qu'elle sonne et nettement plus faible.
 * Le ratio 0,75 laisse de la marge : sur la démo, les vraies notes commencent à disparaître vers 0,85.
 */
function removeOctaveGhosts(notes, ratio) {
  const byPitch = new Map();
  for (const n of notes) {
    if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []);
    byPitch.get(n.pitch).push(n);
  }
  return notes.filter(
    (n) =>
      ![n.pitch - 12, n.pitch + 12].some((p) =>
        (byPitch.get(p) ?? []).some((m) => m.start <= n.start + 0.03 && m.end > n.start && n.velocity < ratio * m.velocity),
      ),
  );
}

/** Filtre les artefacts typiques : hors tessiture, notes trop courtes, octaves fantômes, chevauchements. */
export function cleanNotes(notes, { minDur = 0.03, minVelocity = 6, octaveGhostRatio = 0.75 } = {}) {
  let kept = notes
    .filter((n) => n.pitch >= PIANO_MIN && n.pitch <= PIANO_MAX)
    .filter((n) => n.end - n.start >= minDur && n.velocity >= minVelocity);
  if (octaveGhostRatio) kept = removeOctaveGhosts(kept, octaveGhostRatio);
  kept.sort((a, b) => a.pitch - b.pitch || a.start - b.start);

  const out = [];
  for (const n of kept) {
    const prev = out.length && out[out.length - 1].pitch === n.pitch ? out[out.length - 1] : null;
    // Une « ré-attaque » collée à la note précédente et nettement plus faible est en général
    // la résonance de la même corde : on fusionne. Une vraie répétition est jouée au moins aussi fort.
    if (prev && n.start - prev.end < 0.012 && n.velocity < prev.velocity * 0.6) {
      prev.end = Math.max(prev.end, n.end);
      continue;
    }
    if (prev && n.start < prev.end) prev.end = n.start; // même touche ré-attaquée
    out.push({ ...n });
  }
  return out
    .map((n) => ({ ...n, hand: n.pitch < 60 ? 'L' : 'R' })) // heuristique simple : coupure au Do central
    .sort((a, b) => a.start - b.start);
}

/** Export MIDI avec une piste par main (importable tel quel dans Synthesia). */
export async function notesToMidiBlob(notes, title) {
  const { Midi } = await import(TONEJS_MIDI);
  const midi = new Midi();
  midi.name = title;
  for (const [hand, name] of [['R', 'Main droite'], ['L', 'Main gauche']]) {
    const track = midi.addTrack();
    track.name = name;
    track.instrument.number = 0; // Acoustic Grand Piano
    for (const n of notes) {
      if (n.hand !== hand) continue;
      track.addNote({ midi: n.pitch, time: n.start, duration: n.end - n.start, velocity: n.velocity / 127 });
    }
  }
  return new Blob([midi.toArray()], { type: 'audio/midi' });
}
