
import glob
import os
import shutil
import uuid
import threading
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator


# ==========================================
# Downloader Pro - Backend Configuration
# ==========================================

app = FastAPI(title="Downloader Pro API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Locate FFmpeg automatically, then use the known WinGet path.
KNOWN_FFMPEG_DIR = Path(
    os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages"
        r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        r"\ffmpeg-9.0.2-full_build\bin"
    )
)

PATH_FFMPEG = shutil.which("ffmpeg")

if PATH_FFMPEG:
    FFMPEG_LOCATION = PATH_FFMPEG
elif (KNOWN_FFMPEG_DIR / "ffmpeg.exe").is_file():
    FFMPEG_LOCATION = str(KNOWN_FFMPEG_DIR)
else:
    FFMPEG_LOCATION = None

jobs = {}
jobs_lock = threading.Lock()


# ==========================================
# Request Models
# ==========================================

class InfoRequest(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip()
        parsed = urlparse(value)

        if (
            parsed.scheme not in ("http", "https")
            or not parsed.netloc
        ):
            raise ValueError("একটি সঠিক http/https URL দিন।")

        return value


class DownloadRequest(InfoRequest):
    mode: str = "video"
    quality: str = "720p"

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, value: str) -> str:
        if value not in ("video", "mp3"):
            raise ValueError("mode হবে video অথবা mp3।")
        return value

    @field_validator("quality")
    @classmethod
    def validate_quality(cls, value: str) -> str:
        if value not in ("360p", "480p", "720p", "1080p"):
            raise ValueError(
                "সমর্থিত quality: 360p, 480p, 720p, 1080p"
            )
        return value


# ==========================================
# Shared Helpers
# ==========================================

def update_job(job_id: str, **changes):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(changes)


def make_ydl_options():
    options = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
    }

    if FFMPEG_LOCATION:
        options["ffmpeg_location"] = FFMPEG_LOCATION

    return options


def require_ffmpeg():
    if not FFMPEG_LOCATION:
        raise RuntimeError(
            "FFmpeg পাওয়া যায়নি। FFmpeg ইনস্টল ও PATH ঠিক করো।"
        )


# ==========================================
# API Routes
# ==========================================

@app.get("/")
def home():
    return {
        "name": "Downloader Pro API",
        "status": "running",
    }


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "ffmpeg_found": bool(FFMPEG_LOCATION),
        "ffmpeg_location": FFMPEG_LOCATION,
    }


@app.post("/api/info")
def get_info(request: InfoRequest):
    try:
        with yt_dlp.YoutubeDL(make_ydl_options()) as ydl:
            info = ydl.extract_info(
                request.url,
                download=False,
            )

        if not info:
            raise HTTPException(
                status_code=400,
                detail="ভিডিওর তথ্য পাওয়া যায়নি।",
            )

        duration = info.get("duration")

        return {
            "title": info.get("title") or "Untitled",
            "thumbnail": info.get("thumbnail"),
            "duration": int(duration) if duration else 0,
            "platform": (
                info.get("extractor_key")
                or info.get("extractor")
                or "Unknown"
            ),
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"ভিডিওর তথ্য আনা যায়নি: {str(exc)[:300]}",
        ) from exc


# ==========================================
# Download Worker
# ==========================================

def download_worker(
    job_id: str,
    url: str,
    mode: str,
    quality: str,
):
    try:
        require_ffmpeg()

        max_height = int(quality.replace("p", ""))

        def progress_hook(data):
            if data.get("status") == "downloading":
                total = (
                    data.get("total_bytes")
                    or data.get("total_bytes_estimate")
                    or 0
                )
                downloaded = data.get("downloaded_bytes", 0)

                progress = (
                    int(downloaded * 100 / total)
                    if total
                    else 0
                )

                update_job(
                    job_id,
                    status="downloading",
                    progress=min(progress, 99),
                    message="ডাউনলোড হচ্ছে...",
                )

            elif data.get("status") == "finished":
                update_job(
                    job_id,
                    status="processing",
                    progress=99,
                    message="ফাইল প্রস্তুত হচ্ছে...",
                )

        output_template = str(
            DOWNLOAD_DIR / f"{job_id}.%(ext)s"
        )

        options = make_ydl_options()
        options.update({
            "outtmpl": output_template,
            "progress_hooks": [progress_hook],
            "noplaylist": True,
            "overwrites": True,
        })

        if mode == "mp3":
            options["format"] = "bestaudio/best"
            options["postprocessors"] = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ]
        else:
            options["format"] = (
                f"bestvideo[height<={max_height}]+bestaudio/"
                f"best[height<={max_height}]/best"
            )
            options["merge_output_format"] = "mp4"

        update_job(
            job_id,
            status="downloading",
            progress=0,
            message="ডাউনলোড শুরু হচ্ছে...",
        )

        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download([url])

        matches = [
            Path(name)
            for name in glob.glob(
                str(DOWNLOAD_DIR / f"{job_id}.*")
            )
            if Path(name).is_file()
            and not name.endswith((".part", ".ytdl"))
        ]

        if not matches:
            raise RuntimeError(
                "ডাউনলোড শেষে ফাইল পাওয়া যায়নি।"
            )

        final_file = max(
            matches,
            key=lambda path: path.stat().st_mtime,
        )

        update_job(
            job_id,
            status="completed",
            progress=100,
            message="ডাউনলোড সম্পন্ন হয়েছে।",
            file_path=str(final_file),
            download_url=f"/api/file/{job_id}",
        )

    except Exception as exc:
        update_job(
            job_id,
            status="error",
            progress=0,
            message=f"ডাউনলোড ব্যর্থ: {str(exc)[:300]}",
        )


# ==========================================
# Start Download
# ==========================================

@app.post("/api/download")
def start_download(request: DownloadRequest):
    job_id = uuid.uuid4().hex

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "message": "কাজের অপেক্ষায়...",
            "download_url": None,
            "file_path": None,
        }

    worker = threading.Thread(
        target=download_worker,
        args=(
            job_id,
            request.url,
            request.mode,
            request.quality,
        ),
        daemon=True,
    )
    worker.start()

    return {
        "job_id": job_id,
        "status": "queued",
        "message": "ডাউনলোডের কাজ শুরু হয়েছে।",
    }


# ==========================================
# Check Download Status
# ==========================================

@app.get("/api/status/{job_id}")
def get_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)

        if not job:
            raise HTTPException(
                status_code=404,
                detail="এই Job ID পাওয়া যায়নি।",
            )

        return {
            "job_id": job_id,
            "status": job["status"],
            "progress": job["progress"],
            "message": job["message"],
            "download_url": job["download_url"],
        }


# ==========================================
# Download Completed File
# ==========================================

@app.get("/api/file/{job_id}")
def get_file(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)

        if not job:
            raise HTTPException(
                status_code=404,
                detail="এই Job ID পাওয়া যায়নি।",
            )

        file_path = job.get("file_path")

    if not file_path:
        raise HTTPException(
            status_code=404,
            detail="ডাউনলোড ফাইল এখনো প্রস্তুত নয়।",
        )

    path = Path(file_path).resolve()

    # Ensure only files inside DOWNLOAD_DIR can be served.
    if (
        not path.is_relative_to(DOWNLOAD_DIR.resolve())
        or not path.is_file()
    ):
        raise HTTPException(
            status_code=404,
            detail="ডাউনলোড ফাইল পাওয়া যায়নি।",
        )

    return FileResponse(
        path=str(path),
        filename=path.name,
        media_type="application/octet-stream",
    )
