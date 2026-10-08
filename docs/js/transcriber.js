// Transcription audio → notes, entièrement dans le navigateur, avec basic-pitch (Spotify) sur TensorFlow.js.

import { assignHands } from './hands.js';

const BASIC_PITCH = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1';
// Même URL que celle importée par basic-pitch : on obtient la même instance de TensorFlow.js.
const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.19.0/+esm';
const TONEJS_MIDI = 'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm';

const SAMPLE_RATE = 22050; // fréquence attendue par le modèle
const FRAMES_PER_SECOND = Math.floor(SAMPLE_RATE / 256); // 86 trames d'annotation par seconde
const N_KEYS = 88;
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
  let buffer;
  try {
    // marche aussi pour les vidéos (MP4, MOV, WebM) : seule la piste son est décodée
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('impossible de lire le son de ce fichier (format non pris en charge par ce navigateur, ou vidéo sans son).');
  }
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

/**
 * Sorties brutes d'un modèle, compactées pour être gardées dans la bibliothèque (≈ 1 Mo par minute) :
 * probabilités de tenue (« frames ») et d'attaque (« onsets »), n trames × 88 touches, quantifiées sur un octet.
 * kind : 'basic-pitch' (navigateur) ou 'bytedance' (serveur, 100 trames/s).
 * @typedef {{kind: string, fps: number, n: number, frames: Uint8Array, onsets: Uint8Array}} RawOutput
 */
function pack2d(rows) {
  const out = new Uint8Array(rows.length * N_KEYS);
  rows.forEach((row, i) => {
    for (let k = 0; k < N_KEYS; k++) out[i * N_KEYS + k] = Math.round(Math.min(1, Math.max(0, row[k])) * 255);
  });
  return out;
}

function unpack2d(bytes, n) {
  return Array.from({ length: n }, (_, i) => Array.from(bytes.subarray(i * N_KEYS, (i + 1) * N_KEYS), (v) => v / 255));
}

/** Probabilités renvoyées par le serveur (GET /api/jobs/{id}/probs) → RawOutput. */
export function rawFromServer(buffer, { fps, frames: n }) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length !== 2 * n * N_KEYS) throw new Error('probabilités du serveur incomplètes');
  return { kind: 'bytedance', fps, n, frames: bytes.slice(0, n * N_KEYS), onsets: bytes.slice(n * N_KEYS) };
}

/** Passe l'audio dans le réseau. Renvoie les sorties brutes, réutilisables pour recalculer les notes. */
export async function runModel(samples, onProgress) {
  const { tf, model } = await loadModel();
  const frames = [];
  const onsets = [];
  tf.engine().startScope(); // libère tous les tenseurs intermédiaires à la fin
  try {
    await model.evaluateModel(
      samples,
      (f, o) => {
        // les contours de hauteur (3e sortie) ne servent pas au décodage des notes
        frames.push(...f);
        onsets.push(...o);
      },
      onProgress,
    );
  } finally {
    tf.engine().endScope();
  }
  return { kind: 'basic-pitch', fps: FRAMES_PER_SECOND, n: frames.length, frames: pack2d(frames), onsets: pack2d(onsets) };
}

/**
 * Sorties brutes du réseau → liste de notes nettoyées.
 * @param {RawOutput} raw
 * @param {{onsetThreshold:number, frameThreshold:number, minNoteMs:number, removeGhosts:boolean}} settings
 */
export async function decodeNotes(raw, { onsetThreshold, frameThreshold, minNoteMs, removeGhosts }) {
  const { bp } = await loadModel();
  const minNoteFrames = Math.max(1, Math.round((minNoteMs * raw.fps) / 1000));
  // outputToNotesPoly modifie ses entrées : on décompacte des copies neuves à chaque recalcul.
  const events = bp.outputToNotesPoly(
    unpack2d(raw.frames, raw.n),
    unpack2d(raw.onsets, raw.n),
    onsetThreshold,
    frameThreshold,
    minNoteFrames,
    true, // déduire les attaques manquantes à partir des trames
    4186, // fréquence max : C8
    27.5, // fréquence min : A0
    true, // « melodia trick » : supprime les résonances isolées
    Math.round((11 * raw.fps) / FRAMES_PER_SECOND), // tolérance de ≈ 0,13 s, quel que soit le modèle
  );
  const velocity = (amplitude) => Math.min(127, Math.max(1, Math.round(amplitude * 127)));
  // basic-pitch a sa propre conversion trames → secondes (décalage par fenêtre de 2 s) ;
  // pour le modèle du serveur, la trame i est simplement à i / fps secondes.
  const notes =
    raw.kind === 'basic-pitch'
      ? bp.noteFramesToTime(events).map((n) => ({
          pitch: n.pitchMidi,
          start: n.startTimeSeconds,
          end: n.startTimeSeconds + n.durationSeconds,
          velocity: velocity(n.amplitude),
        }))
      : events.map((e) => ({
          pitch: e.pitchMidi,
          start: e.startFrame / raw.fps,
          end: (e.startFrame + e.durationFrames) / raw.fps,
          velocity: velocity(e.amplitude),
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
  return assignHands(out);
}

/** Échantillons mono → fichier WAV 16 bits (pour garder seulement le son d'une vidéo). */
export function samplesToWavBlob(samples, sampleRate = SAMPLE_RATE) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // octets par seconde
  view.setUint16(32, 2, true); // octets par échantillon
  view.setUint16(34, 16, true); // bits par échantillon
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  }
  return new Blob([view], { type: 'audio/wav' });
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
