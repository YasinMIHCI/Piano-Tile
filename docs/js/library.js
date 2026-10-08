// Bibliothèque locale : chaque morceau transcrit (notes + audio) est gardé dans IndexedDB,
// pour être rejoué plus tard sans serveur ni nouvelle transcription.
// Deux magasins : « meta » (léger, pour la liste) et « data » (notes + audio, chargé à la lecture).

const DB_NAME = 'piano-tile';
const DB_VERSION = 1;

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta', { keyPath: 'id' });
      db.createObjectStore('data', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(...stores.map((s) => t.objectStore(s)));
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transaction annulée'));
  });
}

/** Liste des morceaux, du plus récent au plus ancien. */
export async function listTracks() {
  const all = await tx(['meta'], 'readonly', (meta) => meta.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** Enregistre un morceau et renvoie son identifiant. */
export async function saveTrack({ title, source, url = null, notes, audio, raw = null }) {
  const id = crypto.randomUUID();
  const duration = notes.reduce((m, n) => Math.max(m, n.end), 0);
  const size = audio.size + (raw ? raw.frames.length + raw.onsets.length : 0);
  const meta = { id, title, source, url, createdAt: Date.now(), duration, noteCount: notes.length, size };
  await tx(['meta', 'data'], 'readwrite', (m, d) => {
    m.put(meta);
    d.put({ id, notes, audio, raw }); // raw : probabilités du modèle, pour « Recalculer »
  });
  // Demande au navigateur de ne pas effacer ces données quand l'espace disque manque
  navigator.storage?.persist?.().catch(() => {});
  return id;
}

/** Remplace les notes d'un morceau (après « Recalculer »). */
export async function updateNotes(id, notes) {
  await tx(['meta', 'data'], 'readwrite', (m, d) => {
    const getData = d.get(id);
    getData.onsuccess = () => getData.result && d.put({ ...getData.result, notes });
    const getMeta = m.get(id);
    getMeta.onsuccess = () => getMeta.result && m.put({ ...getMeta.result, noteCount: notes.length });
  });
}

/** Notes, audio (Blob) et sorties brutes du modèle d'un morceau. */
export function loadTrack(id) {
  return tx(['data'], 'readonly', (d) => d.get(id));
}

export function deleteTrack(id) {
  return tx(['meta', 'data'], 'readwrite', (m, d) => {
    m.delete(id);
    d.delete(id);
  });
}
