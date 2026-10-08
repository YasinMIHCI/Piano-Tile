// Répartition main gauche / main droite.
//
// Une coupure fixe au Do central se trompe dès qu'une main déborde de son côté (accord de main droite
// qui descend sous le Do 4, basse qui monte…). On suit plutôt la position de chaque main dans le temps :
// les notes qui démarrent ensemble sont coupées en deux (graves → gauche, aigus → droite) à l'endroit
// le moins coûteux, compte tenu de :
//   - la distance à la position récente de chaque main ;
//   - l'écart que chaque main devrait couvrir, notes encore tenues comprises (au-delà d'une octave, c'est
//     de plus en plus improbable), et dans une moindre mesure avec ses notes des dernières secondes : après
//     un arpège La2-Mi3-La3, le Do4 qui suit revient en général à la main droite ;
//   - le nombre de doigts (5 notes au plus par main) ;
//   - l'écart à l'endroit de la coupure : deux notes très proches jouées ensemble sont en général de la même main.

const CHORD_WINDOW_S = 0.06; // attaques plus proches que ça : jouées ensemble
const COMFORT_SPAN = 12; // une octave : écart couvert sans effort
const MAX_SPAN = 16; // une dixième : au-delà, pratiquement injouable d'une main
const FOLLOW = 0.4; // vitesse à laquelle la position estimée d'une main suit ses dernières notes
const MIN_GAP = 5; // les deux mains ne sont jamais estimées plus proches que ça (demi-tons)
const RECENT_S = 0.8; // « empreinte » récente d'une main, comptée à moitié dans l'écart
const CLOSE = 6; // coupure entre deux notes simultanées à moins d'une quarte augmentée : pénalisée

function spanCost(pitches) {
  if (pitches.length < 2) return 0;
  const span = Math.max(...pitches) - Math.min(...pitches);
  return 4 * Math.max(0, span - COMFORT_SPAN) + 40 * Math.max(0, span - MAX_SPAN);
}

/** Renvoie de nouvelles notes avec `hand` = 'L' ou 'R'. Les notes doivent être triées par début. */
export function assignHands(input) {
  const notes = input.map((n) => ({ ...n })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const center = { L: 48, R: 67 }; // Do 3 et Sol 4 au départ ; s'adaptent dès les premières notes
  const held = { L: [], R: [] };
  const recent = { L: [], R: [] };

  for (let i = 0; i < notes.length; ) {
    let j = i + 1;
    while (j < notes.length && notes[j].start - notes[i].start < CHORD_WINDOW_S) j++;
    const chord = notes.slice(i, j).sort((a, b) => a.pitch - b.pitch);
    const t = chord[0].start;
    for (const h of ['L', 'R']) {
      held[h] = held[h].filter((n) => n.end > t + 0.02);
      recent[h] = recent[h].filter((n) => n.start > t - RECENT_S);
    }

    let best = null;
    for (let k = 0; k <= chord.length; k++) {
      const left = chord.slice(0, k).map((n) => n.pitch);
      const right = chord.slice(k).map((n) => n.pitch);
      let cost =
        left.reduce((s, p) => s + Math.abs(p - center.L), 0) +
        right.reduce((s, p) => s + Math.abs(p - center.R), 0) +
        spanCost([...left, ...held.L.map((n) => n.pitch)]) +
        spanCost([...right, ...held.R.map((n) => n.pitch)]) +
        0.5 * spanCost([...left, ...recent.L.map((n) => n.pitch)]) +
        0.5 * spanCost([...right, ...recent.R.map((n) => n.pitch)]) +
        20 * Math.max(0, left.length - 5) +
        20 * Math.max(0, right.length - 5) +
        (left.length && right.length ? 2 * Math.max(0, CLOSE - (right[0] - left[left.length - 1])) : 0);
      // une main ne passe pas « à travers » l'autre : gauche sous les notes tenues à droite, et inversement
      const heldR = held.R.map((n) => n.pitch);
      const heldL = held.L.map((n) => n.pitch);
      if (left.length && heldR.length) cost += 6 * Math.max(0, Math.max(...left) - Math.min(...heldR));
      if (right.length && heldL.length) cost += 6 * Math.max(0, Math.max(...heldL) - Math.min(...right));
      if (!best || cost < best.cost) best = { cost, k };
    }

    chord.forEach((n, idx) => {
      n.hand = idx < best.k ? 'L' : 'R';
      held[n.hand].push(n);
      recent[n.hand].push(n);
    });
    for (const h of ['L', 'R']) {
      const mine = chord.filter((n) => n.hand === h);
      if (mine.length) {
        const mean = mine.reduce((s, n) => s + n.pitch, 0) / mine.length;
        center[h] += FOLLOW * (mean - center[h]);
      }
    }
    if (center.R - center.L < MIN_GAP) {
      const mid = (center.L + center.R) / 2;
      center.L = mid - MIN_GAP / 2;
      center.R = mid + MIN_GAP / 2;
    }
    i = j;
  }
  return notes;
}
