// Rendu façon Synthesia : notes qui tombent sur un clavier de 88 touches, dessiné sur un <canvas>.

const FIRST = 21; // A0
const LAST = 108; // C8
const COMPACT_BELOW_PX = 900;
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
// [note sur touche blanche, note sur touche noire] : la variante foncée distingue les touches noires
const COLORS = { R: ['#4ade80', '#16a34a'], L: ['#60a5fa', '#2563eb'] };

const isBlack = (midi) => BLACK_PCS.has(midi % 12);

const countWhites = (lo, hi) => {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) n++;
  return n;
};

/**
 * Géométrie des 88 touches (index = midi - FIRST). Seule la plage [lo, hi] occupe la largeur :
 * les touches en dehors sont placées hors du canvas.
 */
function layoutKeys(width, lo = FIRST, hi = LAST) {
  const whiteW = width / countWhites(lo, hi);
  const blackW = whiteW * 0.6;
  const keys = [];
  let whiteIdx = lo === FIRST ? 0 : -countWhites(FIRST, lo - 1);
  for (let m = FIRST; m <= LAST; m++) {
    if (isBlack(m)) {
      // une touche noire est centrée sur la jonction entre deux blanches
      keys.push({ x: whiteIdx * whiteW - blackW / 2, w: blackW, black: true });
    } else {
      keys.push({ x: whiteIdx * whiteW, w: whiteW, black: false });
      whiteIdx++;
    }
  }
  return keys;
}

/** Premier index i tel que notes[i].start >= t (notes triées par start). */
function lowerBound(notes, t) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class FallingNotesRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => number} getTime horloge en secondes (l'audio en lecture)
   */
  constructor(canvas, getTime) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getTime = getTime;
    this.notes = [];
    this.maxDur = 0;
    this.lookahead = 3; // secondes visibles au-dessus du clavier
    this.latency = 0; // secondes retranchées à l'horloge (casque Bluetooth, etc.)
    this.showNames = true;
    this.W = 0;
    this.H = 0;
    this.keys = [];

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  setNotes(notes) {
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.maxDur = this.notes.reduce((m, n) => Math.max(m, n.end - n.start), 0);
    this.relayout();
  }

  /** Sur petit écran, le clavier ne montre que les octaves utilisées (de Do à Do) pour garder des touches lisibles. */
  keyRange() {
    if (this.W >= COMPACT_BELOW_PX || !this.notes.length) return [FIRST, LAST];
    const pitches = this.notes.map((n) => n.pitch);
    const lo = Math.min(...pitches);
    const hi = Math.max(...pitches);
    return [Math.max(FIRST, lo - (lo % 12)), Math.min(LAST, hi - (hi % 12) + 12)];
  }

  relayout() {
    this.keys = layoutKeys(this.W, ...this.keyRange());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = this.canvas.clientWidth;
    this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.relayout();
  }

  frame() {
    if (this.W > 0) this.draw(this.getTime() - this.latency);
    this.raf = requestAnimationFrame(this.frame);
  }

  draw(t) {
    const { ctx, W, H, keys, notes } = this;
    const kbH = Math.min(Math.max(H * 0.2, 70), 170);
    const kbTop = H - kbH;
    const pxPerSec = kbTop / this.lookahead;
    const active = new Map();

    // fond + couloirs plus sombres au-dessus des touches noires
    const bg = ctx.createLinearGradient(0, 0, 0, kbTop);
    bg.addColorStop(0, '#05070d');
    bg.addColorStop(1, '#101830');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, kbTop);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    for (const k of keys) if (k.black) ctx.fillRect(k.x, 0, k.w, kbTop);

    // repères verticaux sur chaque Do
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    for (let m = 24; m <= LAST; m += 12) {
      const x = Math.round(keys[m - FIRST].x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, kbTop);
      ctx.stroke();
    }

    // notes tombantes : seulement celles dont start ∈ [t - maxDur, t + lookahead]
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, kbTop);
    ctx.clip();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const stop = lowerBound(notes, t + this.lookahead);
    for (let i = lowerBound(notes, t - this.maxDur); i < stop; i++) {
      const n = notes[i];
      if (n.end <= t) continue;
      const k = keys[n.pitch - FIRST];
      if (!k) continue;
      const yBottom = kbTop - (n.start - t) * pxPerSec; // le bas de la note touche le clavier à n.start
      const h = Math.max((n.end - n.start) * pxPerSec, 4);
      const playing = n.start <= t;
      if (playing) active.set(n.pitch, n);

      const color = COLORS[n.hand][k.black ? 1 : 0];
      ctx.globalAlpha = 0.55 + (0.45 * n.velocity) / 127;
      ctx.shadowColor = color;
      ctx.shadowBlur = playing ? 26 : 0; // halo lumineux sur les notes en cours
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(k.x + 1, yBottom - h, k.w - 2, h, Math.min(5, k.w / 3));
      ctx.fill();
      ctx.shadowBlur = 0;

      // reflet sur le bord gauche
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(k.x + 2, yBottom - h + 2, Math.max(1, (k.w - 4) * 0.22), Math.max(0, h - 4));
      ctx.globalAlpha = 1;

      if (this.showNames && h > 18) {
        const name = NOTE_NAMES[n.pitch % 12];
        const size = Math.min(12, k.w * 0.5);
        ctx.font = `600 ${size}px system-ui, sans-serif`;
        if (size >= 7 && ctx.measureText(name).width < k.w - 2) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          ctx.fillText(name, k.x + k.w / 2, Math.min(yBottom, kbTop) - 4);
        }
      }
    }
    ctx.restore();

    this.drawKeyboard(kbTop, kbH, active);
  }

  drawKeyboard(top, h, active) {
    const { ctx, W, keys } = this;
    const blackH = h * 0.63;

    // lueur au-dessus des touches enfoncées
    for (const [pitch, n] of active) {
      const k = keys[pitch - FIRST];
      const glow = ctx.createLinearGradient(0, top - 36, 0, top);
      glow.addColorStop(0, 'rgba(0, 0, 0, 0)');
      glow.addColorStop(1, COLORS[n.hand][0]);
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = glow;
      ctx.fillRect(k.x - k.w * 0.3, top - 36, k.w * 1.6, 36);
      ctx.globalAlpha = 1;
    }

    const whiteFill = ctx.createLinearGradient(0, top, 0, top + h);
    whiteFill.addColorStop(0, '#ffffff');
    whiteFill.addColorStop(1, '#d6dae3');
    const blackFill = ctx.createLinearGradient(0, top, 0, top + blackH);
    blackFill.addColorStop(0, '#3a3d45');
    blackFill.addColorStop(1, '#0b0c10');

    // touches blanches
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    keys.forEach((k, i) => {
      if (k.black) return;
      const n = active.get(i + FIRST);
      ctx.fillStyle = n ? COLORS[n.hand][0] : whiteFill;
      ctx.fillRect(k.x, top, k.w, h);
      ctx.strokeStyle = '#2a2d35';
      ctx.strokeRect(k.x + 0.5, top + 0.5, k.w - 1, h - 1);
      const midi = i + FIRST;
      if (midi % 12 === 0 && k.w >= 14) {
        ctx.font = `${Math.min(11, k.w * 0.42)}px system-ui, sans-serif`;
        ctx.fillStyle = n ? '#0b0c10' : '#7a808c';
        ctx.fillText(`Do${Math.floor(midi / 12) - 1}`, k.x + k.w / 2, top + h - 4);
      }
    });

    // touches noires, par-dessus
    keys.forEach((k, i) => {
      if (!k.black) return;
      const n = active.get(i + FIRST);
      ctx.fillStyle = n ? COLORS[n.hand][1] : blackFill;
      ctx.beginPath();
      ctx.roundRect(k.x, top, k.w, blackH, [0, 0, 3, 3]);
      ctx.fill();
    });

    // feutrine rouge au-dessus du clavier, comme sur un vrai piano
    ctx.fillStyle = '#9f1239';
    ctx.fillRect(0, top - 4, W, 4);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
  }
}
