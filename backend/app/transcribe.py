"""Transcription audio → MIDI avec le modèle piano de ByteDance (Kong et al., F1 attaques ≈ 96,8 % sur MAESTRO)."""

import functools
import os
import threading
from pathlib import Path

import pretty_midi

PIANO_MIN, PIANO_MAX = 21, 108  # A0 → C8
PROBS_FPS = 100  # trames par seconde du modèle ByteDance
_model_lock = threading.Lock()  # un seul job à la fois sur le modèle


@functools.lru_cache(maxsize=1)
def bytedance_model():
    """Chargé une seule fois (~165 Mo de poids), puis réutilisé par tous les jobs."""
    import torch
    from piano_transcription_inference import PianoTranscription

    device = "cuda" if torch.cuda.is_available() else "cpu"
    # Sans chemin, les poids sont téléchargés via wget dans ~/piano_transcription_inference_data.
    # Sous Windows (sans wget), télécharger le .pth à la main et le désigner avec PIANO_CHECKPOINT.
    return PianoTranscription(device=device, checkpoint_path=os.environ.get("PIANO_CHECKPOINT"))


def _remove_octave_ghosts(notes: list[pretty_midi.Note], ratio: float = 0.75) -> list[pretty_midi.Note]:
    """Retire les harmoniques détectées comme des notes à ±1 octave d'une note plus forte qui sonne déjà."""
    by_pitch: dict[int, list[pretty_midi.Note]] = {}
    for n in notes:
        by_pitch.setdefault(n.pitch, []).append(n)

    def is_ghost(n: pretty_midi.Note) -> bool:
        return any(
            m.start <= n.start + 0.03 and m.end > n.start and n.velocity < ratio * m.velocity
            for p in (n.pitch - 12, n.pitch + 12)
            for m in by_pitch.get(p, [])
        )

    return [n for n in notes if not is_ghost(n)]


def clean_midi(
    pm: pretty_midi.PrettyMIDI, duration: float | None = None, min_dur=0.03, min_velocity=6
) -> pretty_midi.PrettyMIDI:
    """Même nettoyage que la version navigateur (docs/js/transcriber.js)."""
    notes = [n for inst in pm.instruments if not inst.is_drum for n in inst.notes]
    if duration is not None:  # le modèle complète le dernier segment : des notes peuvent dépasser la fin de l'audio
        for n in notes:
            n.end = min(n.end, duration)
    notes = [
        n for n in notes
        if PIANO_MIN <= n.pitch <= PIANO_MAX and n.end - n.start >= min_dur and n.velocity >= min_velocity
    ]
    notes = _remove_octave_ghosts(notes)
    notes.sort(key=lambda n: (n.pitch, n.start))

    cleaned: list[pretty_midi.Note] = []
    for n in notes:
        prev = cleaned[-1] if cleaned and cleaned[-1].pitch == n.pitch else None
        # ré-attaque collée et nettement plus faible : résonance de la même corde
        if prev and n.start - prev.end < 0.012 and n.velocity < prev.velocity * 0.6:
            prev.end = max(prev.end, n.end)
            continue
        if prev and n.start < prev.end:  # même touche ré-attaquée : on tronque la précédente
            prev.end = n.start
        cleaned.append(n)

    out = pretty_midi.PrettyMIDI()
    piano = pretty_midi.Instrument(program=0, name="Piano")
    piano.notes = sorted(cleaned, key=lambda n: n.start)
    piano.control_changes = [  # pédale de sustain (CC64), utile pour une resynthèse
        cc for inst in pm.instruments for cc in inst.control_changes if cc.number == 64
    ]
    out.instruments.append(piano)
    return out


def midi_to_notes(pm: pretty_midi.PrettyMIDI) -> list[dict]:
    """Format JSON consommé par le lecteur (mêmes champs que la version navigateur)."""
    return [
        {
            "pitch": n.pitch,
            "start": round(n.start, 4),
            "end": round(n.end, 4),
            "velocity": n.velocity,
            "hand": "L" if n.pitch < 60 else "R",  # approximation : le site recalcule les mains (docs/js/hands.js)
        }
        for n in pm.instruments[0].notes
    ]


def transcribe_to_midi(audio_path: Path, midi_path: Path) -> tuple[list[dict], dict]:
    import librosa
    from piano_transcription_inference import sample_rate

    # load_audio du package appelle librosa.core.audio, supprimé depuis librosa 0.10
    audio, _ = librosa.load(str(audio_path), sr=sample_rate, mono=True)  # 16 kHz mono
    raw_midi = midi_path.with_name("raw.mid")
    with _model_lock:
        out = bytedance_model().transcribe(audio, str(raw_midi))["output_dict"]

    duration = len(audio) / sample_rate
    # le package coupe ses sorties au nombre d'échantillons, pas de trames : on retire le remplissage final
    n_frames = min(len(out["frame_output"]), int(duration * PROBS_FPS) + 1)
    save_probs(out["frame_output"][:n_frames], out["reg_onset_output"][:n_frames], midi_path.with_name("probs.bin"))
    pm = clean_midi(pretty_midi.PrettyMIDI(str(raw_midi)), duration=duration)
    pm.write(str(midi_path))
    return midi_to_notes(pm), {"fps": PROBS_FPS, "frames": n_frames}


def save_probs(frames, onsets, path: Path) -> None:
    """Probabilités brutes (trames × 88 touches) quantifiées sur un octet : trames puis attaques.

    Le site s'en sert pour « Recalculer » avec ses propres seuils, sans refaire passer le modèle.
    """
    import numpy as np

    to_u8 = lambda x: np.clip(np.rint(np.asarray(x) * 255), 0, 255).astype(np.uint8)
    path.write_bytes(to_u8(frames).tobytes() + to_u8(onsets).tobytes())
