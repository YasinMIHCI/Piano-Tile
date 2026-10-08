from pathlib import Path
from urllib.parse import urlparse

import yt_dlp

MAX_DURATION_S = 15 * 60
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}


class DownloadError(Exception):
    pass


def download_youtube_audio(url: str, out_dir: Path) -> tuple[Path, str]:
    """Télécharge la meilleure piste audio d'une vidéo YouTube. Renvoie (chemin, titre)."""
    if urlparse(url).hostname not in ALLOWED_HOSTS:
        raise DownloadError("Seuls les liens YouTube sont acceptés.")

    out_dir.mkdir(parents=True, exist_ok=True)
    base_opts = {"quiet": True, "noplaylist": True}

    try:
        # 1) Métadonnées seules : on refuse les vidéos trop longues avant de télécharger.
        with yt_dlp.YoutubeDL(base_opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if (info.get("duration") or 0) > MAX_DURATION_S:
            raise DownloadError(f"Vidéo trop longue (max {MAX_DURATION_S // 60} min).")

        # 2) Piste audio brute (webm/m4a) ; la conversion en WAV est faite ensuite par ffmpeg.
        opts = {**base_opts, "format": "bestaudio/best", "outtmpl": str(out_dir / "source.%(ext)s")}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(str(e)) from e

    return Path(info["requested_downloads"][0]["filepath"]), info.get("title") or "youtube"
