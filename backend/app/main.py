"""API de transcription : liens YouTube et fichiers audio → notes JSON + MIDI.

Le site (docs/) fonctionne sans ce serveur ; il ne sert que pour YouTube et pour le modèle piano plus précis.
"""

import os
import shutil
import subprocess
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .transcribe import transcribe_to_midi
from .youtube import download_youtube_audio

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS", "https://yasinmihci.github.io,http://localhost:8765,http://localhost:3000"
).split(",")

JOBS: dict[str, dict] = {}  # en mémoire : suffisant pour un seul serveur ; Redis + RQ/Celery au-delà

app = FastAPI(title="Piano-Tile API")
# allow_private_network : Chrome envoie un preflight « Private Network Access » quand un site public
# (GitHub Pages) appelle localhost ; sans cet en-tête il est rejeté (400).
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)


def to_wav(src: Path, dst: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "44100", str(dst)],
        check=True,
    )


def to_m4a(src: Path, dst: Path) -> None:
    """Version compressée pour le site (≈ 1 Mo/min contre 5 Mo/min en WAV), gardée dans sa bibliothèque."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "128k", str(dst)],
        check=True,
    )


def run_job(job_id: str, youtube_url: str | None, upload_path: Path | None) -> None:
    job, job_dir = JOBS[job_id], DATA_DIR / job_id
    try:
        if youtube_url:
            job["status"] = "downloading"
            src, job["title"] = download_youtube_audio(youtube_url, job_dir)
        else:
            src = upload_path
        to_wav(src, job_dir / "audio.wav")
        to_m4a(src, job_dir / "audio.m4a")

        job["status"] = "transcribing"
        notes = transcribe_to_midi(job_dir / "audio.wav", job_dir / "transcription.mid")
        job.update(status="done", notes=notes)
    except Exception as e:  # le message remonte tel quel à l'interface
        job.update(status="error", error=str(e))


@app.get("/")
def health():
    return {"ok": True}


@app.post("/api/jobs")
async def create_job(
    background: BackgroundTasks,
    youtube_url: str | None = Form(None),
    file: UploadFile | None = File(None),
):
    if file is not None and not file.filename:  # champ fichier vide
        file = None
    if not youtube_url and file is None:
        raise HTTPException(400, "Fournis un lien YouTube ou un fichier audio.")

    job_id = uuid.uuid4().hex
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True)

    upload_path = None
    if file is not None:
        ext = Path(file.filename).suffix.lower()
        if ext not in AUDIO_EXTS:
            raise HTTPException(415, f"Format non supporté : {ext}")
        upload_path = job_dir / f"upload{ext}"
        with upload_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        if upload_path.stat().st_size > MAX_UPLOAD_BYTES:
            shutil.rmtree(job_dir)
            raise HTTPException(413, "Fichier trop volumineux (50 Mo max).")

    JOBS[job_id] = {"status": "queued", "title": Path(file.filename).stem if file else None}
    background.add_task(run_job, job_id, youtube_url or None, upload_path)
    return {"job_id": job_id}


def _get_job(job_id: str) -> dict:
    if job_id not in JOBS:
        raise HTTPException(404, "Job introuvable")
    return JOBS[job_id]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _get_job(job_id)


@app.get("/api/jobs/{job_id}/midi")
def get_midi(job_id: str):
    if _get_job(job_id)["status"] != "done":
        raise HTTPException(409, "Transcription non terminée")
    return FileResponse(DATA_DIR / job_id / "transcription.mid", media_type="audio/midi", filename="transcription.mid")


@app.get("/api/jobs/{job_id}/audio")
def get_audio(job_id: str):
    if _get_job(job_id)["status"] != "done":
        raise HTTPException(409, "Transcription non terminée")
    return FileResponse(DATA_DIR / job_id / "audio.m4a", media_type="audio/mp4")
