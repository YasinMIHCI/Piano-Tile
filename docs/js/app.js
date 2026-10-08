import { DEMO_REFERENCE, renderDemoFile } from './demo.js';
import { deleteTrack, listTracks, loadTrack, saveTrack, updateNotes } from './library.js';
import { FallingNotesRenderer } from './player.js';
import {
  decodeAudioFile,
  decodeNotes,
  loadModel,
  notesToMidiBlob,
  rawFromServer,
  runModel,
  samplesToWavBlob,
} from './transcriber.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'),
  dropzone: $('dropzone'),
  ytForm: $('yt-form'),
  ytUrl: $('yt-url'),
  ytHint: $('yt-hint'),
  demo: $('demo'),
  settings: $('settings'),
  onset: $('onset'),
  frame: $('frame'),
  minLen: $('min-len'),
  ghosts: $('ghosts'),
  apiUrl: $('api-url'),
  engine: $('engine'),
  recompute: $('recompute'),
  status: $('status'),
  statusMsg: $('status-msg'),
  statusBar: $('status-bar'),
  player: $('player'),
  canvas: $('canvas'),
  audio: $('audio'),
  play: $('play'),
  time: $('time'),
  seek: $('seek'),
  speed: $('speed'),
  latency: $('latency'),
  latencyOut: $('latency-out'),
  names: $('names'),
  download: $('download'),
  summary: $('summary'),
  library: $('library'),
  libraryList: $('library-list'),
};

const SETTINGS_KEY = 'piano-tile:settings';
const SERVER_STEPS = {
  queued: 'En attente sur le serveur…',
  downloading: "Téléchargement de l'audio…",
  transcribing: 'Transcription IA sur le serveur…',
};

const state = { busy: false, raw: null, notes: [], title: 'transcription', objectUrl: null, isDemo: false, trackId: null };

// ---------- horloge : l'audio est la référence, lissée entre deux mises à jour de currentTime ----------
let lastMedia = 0;
let lastWall = 0;
function audioClock() {
  const media = els.audio.currentTime;
  const now = performance.now();
  if (els.audio.paused || media !== lastMedia) {
    lastMedia = media;
    lastWall = now;
    return media;
  }
  return media + Math.min(((now - lastWall) / 1000) * els.audio.playbackRate, 0.25);
}
const renderer = new FallingNotesRenderer(els.canvas, audioClock);

// ---------- réglages (mémorisés localement, facultatif) ----------
function readSettings() {
  return {
    onsetThreshold: Number(els.onset.value),
    frameThreshold: Number(els.frame.value),
    minNoteMs: Number(els.minLen.value),
    removeGhosts: els.ghosts.checked,
    apiUrl: els.apiUrl.value.trim().replace(/\/+$/, ''),
    engine: els.engine.value,
  };
}

function restoreSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    /* stockage indisponible : valeurs par défaut */
  }
  if (saved.onsetThreshold) els.onset.value = saved.onsetThreshold;
  if (saved.frameThreshold) els.frame.value = saved.frameThreshold;
  if (saved.minNoteMs) els.minLen.value = saved.minNoteMs;
  if (typeof saved.removeGhosts === 'boolean') els.ghosts.checked = saved.removeGhosts;
  if (saved.apiUrl) els.apiUrl.value = saved.apiUrl;
  if (saved.engine) els.engine.value = saved.engine;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
  } catch {
    /* pas grave */
  }
}

function syncSettingsUi() {
  const s = readSettings();
  for (const input of [els.onset, els.frame, els.minLen]) {
    input.nextElementSibling.textContent = input === els.minLen ? `${input.value} ms` : input.value;
  }
  const hasServer = Boolean(s.apiUrl);
  els.engine.disabled = !hasServer;
  els.ytHint.hidden = hasServer;
  els.recompute.disabled = state.busy || !state.raw;
}

// ---------- état de l'interface ----------
function setStatus(message, { progress = null, error = false } = {}) {
  els.status.hidden = false;
  els.status.classList.toggle('error', error);
  els.statusMsg.textContent = message;
  els.statusBar.classList.toggle('indeterminate', progress === null && state.busy);
  els.statusBar.firstElementChild.style.width = progress === null ? '' : `${Math.round(progress * 100)}%`;
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle('busy', busy);
  for (const el of [els.file, els.demo, els.ytUrl, els.ytForm.querySelector('button')]) el.disabled = busy;
  els.recompute.disabled = busy || !state.raw;
}

// laisse le navigateur afficher le statut avant un calcul bloquant (pas de rAF : suspendu si l'onglet est masqué)
const nextPaint = () => new Promise((r) => setTimeout(r, 30));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function run(task) {
  if (state.busy) return;
  setBusy(true);
  try {
    await task();
  } catch (e) {
    console.error(e);
    const offline = e instanceof TypeError && /fetch/i.test(e.message);
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(readSettings().apiUrl);
    setStatus(
      offline && local
        ? 'Serveur local injoignable : lance backend\\start.cmd et garde sa fenêtre ouverte. Si Chrome a demandé l’accès au réseau local, il faut l’autoriser (icône à gauche de l’adresse).'
        : offline
          ? 'Serveur injoignable : vérifie son URL, et qu’il est bien en HTTPS avec le CORS autorisé pour ce site.'
          : `Erreur : ${e.message}`,
      { error: true },
    );
  } finally {
    setBusy(false);
    els.statusBar.classList.remove('indeterminate');
  }
}

// ---------- pipelines ----------
async function transcribeInBrowser(file) {
  setStatus('Décodage de l’audio…', { progress: 0 });
  const samples = await decodeAudioFile(file);
  setStatus('Chargement du modèle d’IA…', { progress: 0 });
  await loadModel();
  const raw = await runModel(samples, (p) => setStatus(`Analyse des notes… ${Math.round(p * 100)} %`, { progress: p }));
  setStatus('Extraction des notes…', { progress: 1 });
  await nextPaint();
  state.raw = raw;
  return { notes: await decodeNotes(raw, readSettings()), samples };
}

async function transcribeOnServer(apiUrl, { file, youtubeUrl }) {
  const body = new FormData();
  if (file) body.append('file', file);
  if (youtubeUrl) body.append('youtube_url', youtubeUrl);
  setStatus('Envoi au serveur…');
  const res = await fetch(`${apiUrl}/api/jobs`, { method: 'POST', body });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
  const { job_id: jobId } = await res.json();

  for (;;) {
    await sleep(2000);
    const r = await fetch(`${apiUrl}/api/jobs/${jobId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const job = await r.json();
    if (job.status === 'done') {
      return {
        notes: job.notes,
        title: job.title,
        audioUrl: `${apiUrl}/api/jobs/${jobId}/audio`,
        raw: await fetchServerRaw(apiUrl, jobId, job.probs),
      };
    }
    if (job.status === 'error') throw new Error(job.error);
    setStatus(SERVER_STEPS[job.status] ?? job.status);
  }
}

/** Probabilités brutes du serveur, pour « Recalculer » plus tard ; absentes avec un ancien serveur. */
async function fetchServerRaw(apiUrl, jobId, probs) {
  if (!probs) return null;
  try {
    const res = await fetch(`${apiUrl}/api/jobs/${jobId}/probs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return rawFromServer(await res.arrayBuffer(), probs);
  } catch (e) {
    console.warn('Probabilités indisponibles : « Recalculer » sera désactivé pour ce morceau.', e);
    return null;
  }
}

const isVideo = (file) => file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|3gp)$/i.test(file.name);

async function processFile(file, { demo = false } = {}) {
  const s = readSettings();
  const useServer = !demo && s.apiUrl && s.engine === 'server';
  state.raw = null;
  let notes;
  // Pour une vidéo (capture d'écran du téléphone), on ne garde que le son : bien plus léger dans « Mes morceaux ».
  let audio = file;
  if (useServer) {
    const result = await transcribeOnServer(s.apiUrl, { file });
    ({ notes } = result);
    state.raw = result.raw;
    if (isVideo(file)) audio = await (await fetch(result.audioUrl)).blob();
  } else {
    const result = await transcribeInBrowser(file);
    ({ notes } = result);
    if (isVideo(file)) audio = samplesToWavBlob(result.samples);
  }
  const title = demo ? 'Lettre à Élise (démo)' : file.name.replace(/\.[^.]+$/, '');
  state.isDemo = demo;
  state.trackId = null;
  showResult(notes, setAudioBlob(audio), title);
  if (!demo) await remember({ title, source: isVideo(file) ? 'video' : 'file', notes, audio, raw: state.raw });
}

function setAudioBlob(blob) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);
  return state.objectUrl;
}

/** Garde le morceau dans la bibliothèque du navigateur ; un échec (quota…) ne bloque pas la lecture. */
async function remember(track) {
  try {
    state.trackId = await saveTrack(track);
    await renderLibrary();
  } catch (e) {
    console.error(e);
    setStatus(`Prêt, mais le morceau n’a pas pu être enregistré dans « Mes morceaux » : ${e.message}`, { error: true });
  }
}

const handleFile = (file) => run(() => processFile(file));

function handleYoutube(url) {
  return run(async () => {
    const { apiUrl } = readSettings();
    if (!apiUrl) {
      els.settings.open = true;
      els.apiUrl.focus();
      throw new Error('renseigne d’abord l’URL du serveur de transcription (Paramètres) : un site statique ne peut pas télécharger depuis YouTube.');
    }
    state.raw = null;
    state.isDemo = false;
    const result = await transcribeOnServer(apiUrl, { youtubeUrl: url });
    setStatus('Récupération de l’audio…');
    const audioRes = await fetch(result.audioUrl);
    if (!audioRes.ok) throw new Error(`audio : HTTP ${audioRes.status}`);
    const audio = await audioRes.blob(); // copie locale : rejouable ensuite sans serveur
    const title = result.title || 'youtube';
    state.trackId = null;
    state.raw = result.raw;
    showResult(result.notes, setAudioBlob(audio), title);
    await remember({ title, source: 'youtube', url, notes: result.notes, audio, raw: result.raw });
  });
}

// ---------- résultat ----------
function demoAccuracy(notes) {
  const unmatched = [...notes];
  let found = 0;
  for (const ref of DEMO_REFERENCE) {
    const i = unmatched.findIndex((n) => n.pitch === ref.pitch && Math.abs(n.start - ref.start) < 0.06);
    if (i >= 0) {
      found++;
      unmatched.splice(i, 1);
    }
  }
  return ` Sur la démo, ${found}/${DEMO_REFERENCE.length} notes de la partition sont retrouvées, avec ${unmatched.length} note(s) en trop.`;
}

function showResult(notes, audioUrl, title) {
  state.notes = notes;
  state.title = title;
  renderer.setNotes(notes);
  els.audio.src = audioUrl;
  els.audio.playbackRate = Number(els.speed.value);
  els.player.hidden = false;
  els.recompute.disabled = !state.raw;
  updateSummary();
  setStatus(`Prêt : ${notes.length} notes détectées. Appuie sur Lecture (ou Espace).`, { progress: 1 });
  els.player.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateSummary() {
  const { notes } = state;
  const left = notes.filter((n) => n.hand === 'L').length;
  const duration = notes.reduce((m, n) => Math.max(m, n.end), 0);
  els.summary.textContent =
    `${state.title} · ${notes.length} notes (${notes.length - left} main droite, ${left} main gauche) · ${fmtTime(duration)}.` +
    (state.isDemo ? demoAccuracy(notes) : '');
}

function recompute() {
  return run(async () => {
    setStatus('Recalcul des notes…', { progress: 1 });
    await nextPaint();
    const notes = await decodeNotes(state.raw, readSettings());
    state.notes = notes;
    renderer.setNotes(notes);
    updateSummary();
    if (state.trackId) {
      await updateNotes(state.trackId, notes);
      await renderLibrary();
    }
    setStatus(`Recalculé : ${notes.length} notes.`, { progress: 1 });
  });
}

// ---------- bibliothèque (« Mes morceaux ») ----------
const fmtDate = (ms) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtSize = (bytes) => `${(bytes / 1048576).toFixed(1).replace('.', ',')} Mo`;

async function renderLibrary() {
  let tracks;
  try {
    tracks = await listTracks();
  } catch (e) {
    console.error(e); // IndexedDB indisponible (navigation privée stricte…) : pas de bibliothèque
    els.library.hidden = true;
    return;
  }
  els.library.hidden = tracks.length === 0;
  els.libraryList.replaceChildren(
    ...tracks.map((t) => {
      const li = document.createElement('li');
      li.classList.toggle('current', t.id === state.trackId);
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'track';
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';
      const info = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = t.title;
      const sub = document.createElement('small');
      sub.textContent = `${fmtTime(t.duration)} · ${t.noteCount} notes · ${{ youtube: 'YouTube', video: 'vidéo' }[t.source] ?? 'fichier'} · ${fmtDate(t.createdAt)} · ${fmtSize(t.size)}`;
      info.append(name, sub);
      play.append(info);
      play.title = `Jouer « ${t.title} »`;
      play.addEventListener('click', () => playFromLibrary(t));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary remove';
      del.innerHTML = '<span>Supprimer</span>'; // remplacé par une croix sur téléphone (style.css)
      del.setAttribute('aria-label', `Supprimer « ${t.title} »`);
      del.addEventListener('click', async () => {
        if (!confirm(`Supprimer « ${t.title} » de tes morceaux ?`)) return;
        await deleteTrack(t.id);
        if (state.trackId === t.id) state.trackId = null;
        renderLibrary();
      });
      li.append(play, del);
      return li;
    }),
  );
}

function playFromLibrary(meta) {
  return run(async () => {
    setStatus('Chargement du morceau…');
    const track = await loadTrack(meta.id);
    if (!track) throw new Error('morceau introuvable (supprimé ?)');
    state.raw = track.raw ?? null; // absent pour les morceaux enregistrés avant l'ajout du recalcul
    state.isDemo = false;
    state.trackId = meta.id;
    showResult(track.notes, setAudioBlob(track.audio), meta.title);
    renderLibrary();
    els.audio.play().catch(() => {}); // lecture immédiate ; sinon Espace / bouton Lecture
  });
}

// ---------- lecteur ----------
function totalDuration() {
  const d = els.audio.duration;
  return Number.isFinite(d) && d > 0 ? d : state.notes.reduce((m, n) => Math.max(m, n.end), 0);
}

let seeking = false;
function updateTimeUi() {
  const t = els.audio.currentTime;
  const total = totalDuration();
  els.time.textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
  if (!seeking && total > 0) els.seek.value = String(Math.round((t / total) * 1000));
  requestAnimationFrame(updateTimeUi);
}
requestAnimationFrame(updateTimeUi);

function togglePlay() {
  if (els.player.hidden) return;
  if (els.audio.paused) els.audio.play();
  else els.audio.pause();
}

els.audio.addEventListener('play', () => els.play.classList.add('playing'));
els.audio.addEventListener('pause', () => els.play.classList.remove('playing'));
els.play.addEventListener('click', togglePlay);
els.seek.addEventListener('input', () => {
  seeking = true;
  els.audio.currentTime = (Number(els.seek.value) / 1000) * totalDuration();
});
els.seek.addEventListener('change', () => {
  seeking = false;
});
els.speed.addEventListener('change', () => {
  els.audio.playbackRate = Number(els.speed.value);
});
els.latency.addEventListener('input', () => {
  renderer.latency = Number(els.latency.value) / 1000;
  els.latencyOut.textContent = `${els.latency.value} ms`;
});
els.names.addEventListener('change', () => {
  renderer.showNames = els.names.checked;
});
els.download.addEventListener('click', async () => {
  const blob = await notesToMidiBlob(state.notes, state.title);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.title}.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, button, summary')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const delta = e.code === 'ArrowLeft' ? -5 : 5;
    els.audio.currentTime = Math.max(0, Math.min(totalDuration(), els.audio.currentTime + delta));
  }
});

// ---------- entrées ----------
els.file.addEventListener('change', () => {
  const [file] = els.file.files;
  if (file) handleFile(file);
  els.file.value = '';
});
els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('over');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('over'));
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('over');
  const [file] = e.dataTransfer.files;
  if (file) handleFile(file);
});
els.ytForm.addEventListener('submit', (e) => {
  e.preventDefault();
  handleYoutube(els.ytUrl.value.trim());
});
els.demo.addEventListener('click', () =>
  run(async () => {
    setStatus('Synthèse de la démo…');
    await processFile(await renderDemoFile(), { demo: true });
  }),
);
els.recompute.addEventListener('click', recompute);
for (const el of [els.onset, els.frame, els.minLen, els.ghosts, els.apiUrl, els.engine]) {
  el.addEventListener('input', () => {
    saveSettings();
    syncSettingsUi();
  });
}
// l'erreur « renseigne d'abord l'URL » ne doit pas rester affichée une fois l'URL saisie
els.apiUrl.addEventListener('input', () => {
  if (els.status.classList.contains('error') && !state.busy) els.status.hidden = true;
});

restoreSettings();
syncSettingsUi();
renderLibrary();
