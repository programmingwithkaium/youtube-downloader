
import os
import re
import uuid
import shutil
import threading
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, HttpUrl

app = FastAPI(title="YouTube Downloader Pro API")

FRONTEND_URL = os.getenv(
    "FRONTEND_URL", "http://localhost:3000"
).rstrip("/")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Temporary files and job information are not permanent.
TEMP_ROOT = Path(tempfile.gettempdir()) / "ydp-jobs"
TEMP_ROOT.mkdir(parents=True, exist_ok=True)

jobs = {}
jobs_lock = threading.Lock()
active_lock = threading.Lock()
active_job = False

ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "youtu.be", "music.youtube.com",
    "facebook.com", "www.facebook.com", "m.facebook.com",
    "fb.watch", "web.facebook.com",
}

MAX_DURATION_SECONDS = 90 * 60


class LinkRequest(BaseModel):
    url: HttpUrl


class DownloadRequest(BaseModel):
    url: HttpUrl
    mode: str = "video"
    quality: str = "720p"


def validate_url(raw_url):
    parsed = urlparse(str(raw_url))
    host = (parsed.hostname or "").lower()

    allowed = (
        host in ALLOWED_HOSTS
        or host.endswith(".youtube.com")
        or host.endswith(".facebook.com")
    )

    if parsed.scheme != "https" or not allowed:
        raise HTTPException(
            status_code=400,
            detail="Use a supported HTTPS YouTube or Facebook video URL.",
        )

    return str(raw_url)


def base_options():
    options = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
    }

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        options["ffmpeg_location"] = str(Path(ffmpeg).parent)

    return options


@app.get("/")
def health():
    return {"ok": True, "service": "YouTube Downloader Pro API"}


@app.post("/api/info")
def get_info(request: LinkRequest):
    url = validate_url(request.url)

    options = base_options()
    options["skip_download"] = True

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            raise HTTPException(
                status_code=422, detail="Video information unavailable."
            )

        duration = info.get("duration")
        if duration and duration > MAX_DURATION_SECONDS:
            raise HTTPException(
                status_code=413,
                detail="This demo supports videos up to 90 minutes.",
            )

        extractor = str(
            info.get("extractor_key") or info.get("extractor") or ""
        ).lower()

        platform = (
            "Facebook" if "facebook" in extractor
            else "YouTube" if "youtube" in extractor
            else "Supported site"
        )

        return {
            "title": info.get("title") or "Untitled video",
            "thumbnail": info.get("thumbnail"),
            "duration": duration,
            "platform": platform,
            "formats": [
                "Best available", "1080p", "720p", "480p", "360p"
            ],
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Could not read video information: {str(exc)[:350]}",
        )


@app.post("/api/download")
def create_download(request: DownloadRequest):
    global active_job

    url = validate_url(request.url)
    mode = request.mode.lower()
    quality = request.quality

    if mode not in {"video", "mp3"}:
        raise HTTPException(status_code=400, detail="Invalid download type.")

    allowed_quality = {
        "Best available", "1080p", "720p", "480p", "360p"
    }
    if quality not in allowed_quality:
        raise HTTPException(status_code=400, detail="Invalid quality.")

    if mode == "mp3" and not shutil.which("ffmpeg"):
        raise HTTPException(
            status_code=503,
            detail="MP3 conversion is unavailable: FFmpeg is not installed.",
        )

    # Basic demo safeguard: only one active download per server process.
    with active_lock:
        if active_job:
            raise HTTPException(
                status_code=429,
                detail="Another download is running. Try again shortly.",
            )
        active_job = True

    job_id = str(uuid.uuid4())
    job_dir = TEMP_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "message": "Preparing download...",
            "file": None,
            "filename": None,
            "directory": str(job_dir),
        }

    thread = threading.Thread(
        target=run_download,
        args=(job_id, url, mode, quality, job_dir),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id}


def run_download(job_id, url, mode, quality, job_dir):
    global active_job

    def progress_hook(data):
        if data.get("status") == "downloading":
            total = (
                data.get("total_bytes")
                or data.get("total_bytes_estimate")
            )
            downloaded = data.get("downloaded_bytes", 0)
            percent = round(downloaded * 100 / total) if total else 0

            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]["status"] = "downloading"
                    jobs[job_id]["progress"] = min(percent, 99)
                    jobs[job_id]["message"] = "Downloading..."

        elif data.get("status") == "finished":
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]["message"] = "Processing file..."

    try:
        options = base_options()
        options["outtmpl"] = str(
            job_dir / "%(title).100B [%(id)s].%(ext)s"
        )
        options["progress_hooks"] = [progress_hook]
        options["noplaylist"] = True

        if mode == "mp3":
            options["format"] = "bestaudio/best"
            options["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }]
        else:
            height_filter = ""
            if quality != "Best available":
                height = int(quality.replace("p", ""))
                height_filter = f"[height<={height}]"

            options["format"] = (
                f"bestvideo[ext=mp4]{height_filter}+bestaudio[ext=m4a]/"
                f"best[ext=mp4]{height_filter}/"
                f"bestvideo{height_filter}+bestaudio/"
                f"best{height_filter}/best"
            )
            options["merge_output_format"] = "mp4"

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download([url])

        files = [
            p for p in job_dir.iterdir()
            if p.is_file() and not p.name.endswith((".part", ".ytdl"))
        ]
        if not files:
            raise RuntimeError("No completed output file was found.")

        output = max(files, key=lambda p: p.stat().st_mtime)

        with jobs_lock:
            jobs[job_id].update({
                "status": "complete",
                "progress": 100,
                "message": "Download complete",
                "file": str(output),
                "filename": output.name,
            })

    except Exception as exc:
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id].update({
                    "status": "error",
                    "message": str(exc)[:500],
                })
    finally:
        with active_lock:
            active_job = False


@app.get("/api/status/{job_id}")
def get_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")

        return {
            "status": job["status"],
            "progress": job["progress"],
            "message": job["message"],
            "download_url": (
                f"/api/file/{job_id}"
                if job["status"] == "complete" else None
            ),
        }


@app.get("/api/file/{job_id}")
def get_file(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)

        if not job or job["status"] != "complete":
            raise HTTPException(
                status_code=404, detail="File is not ready."
            )

        path = Path(job["file"])
        filename = job["filename"]

    if not path.is_file():
        raise HTTPException(
            status_code=410,
            detail="Temporary file expired. Please download again.",
        )

    media_type = (
        "audio/mpeg" if path.suffix.lower() == ".mp3"
        else "video/mp4" if path.suffix.lower() == ".mp4"
        else "application/octet-stream"
    )

    return FileResponse(
        path=str(path),
        filename=filename,
        media_type=media_type,
    )
