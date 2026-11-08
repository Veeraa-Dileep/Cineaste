from __future__ import annotations

import atexit
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote

from flask import Flask, Response, abort, jsonify, render_template, request, send_file

APP_DIR = Path(__file__).resolve().parent
VIDEO_EXTENSIONS = {
    ".mp4", ".m4v", ".mkv", ".mov", ".webm", ".avi", ".wmv",
    ".flv", ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv"
}
EXTERNAL_SUBTITLE_EXTENSIONS = {".srt", ".vtt", ".ass", ".ssa", ".sub"}
TEXT_SUBTITLE_CODECS = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text", "srt"}
DIRECT_CONTAINERS = {".mp4", ".m4v", ".mov", ".webm"}
DIRECT_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis"}
DEFAULT_HEIGHT = 1080
MAX_TRANSCODE_HEIGHT = 2160
HLS_SEGMENT_SECONDS = 4
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CACHE_LIMIT_BYTES = int(os.environ.get("TRANSCODE_CACHE_GB", "40")) * 1024 ** 3
CACHE_CLEANUP_INTERVAL_SECONDS = 300
CACHE_ACTIVE_GRACE_SECONDS = 600
CACHE_ORPHAN_GRACE_SECONDS = 900
SESSION_RETENTION_SECONDS = 12 * 60 * 60

app = Flask(__name__)

MEDIA_ROOT: Path | None = None
THUMB_DIR = APP_DIR / "thumbnail_cache"
TRANSCODE_DIR = APP_DIR / "transcode_cache"
SUBTITLE_DIR = APP_DIR / "subtitle_cache"
for directory in (THUMB_DIR, TRANSCODE_DIR, SUBTITLE_DIR):
    directory.mkdir(exist_ok=True)

probe_cache: dict[tuple[str, int, int], dict | None] = {}
probe_lock = threading.Lock()
letterbox_cache: dict[tuple[str, int, int], dict | None] = {}
letterbox_lock = threading.Lock()
session_lock = threading.Lock()
start_lock = threading.Lock()
encoder_lock = threading.Lock()
cleanup_lock = threading.Lock()
lan_lock = threading.Lock()
sessions: dict[str, dict] = {}
active_transcode_sid: str | None = None
encoder_state = {"checked": False, "encoder": None}
lan_cache = {"at": 0.0, "items": []}

LANGUAGE_NAMES = {
    "en": "English", "eng": "English", "english": "English",
    "es": "Spanish", "spa": "Spanish", "spanish": "Spanish",
    "fr": "French", "fre": "French", "fra": "French", "french": "French",
    "de": "German", "ger": "German", "deu": "German", "german": "German",
    "it": "Italian", "ita": "Italian", "italian": "Italian",
    "pt": "Portuguese", "por": "Portuguese", "portuguese": "Portuguese",
    "pt-br": "Portuguese (Brazil)", "pb": "Portuguese (Brazil)",
    "ja": "Japanese", "jpn": "Japanese", "japanese": "Japanese",
    "ko": "Korean", "kor": "Korean", "korean": "Korean",
    "zh": "Chinese", "chi": "Chinese", "zho": "Chinese", "chinese": "Chinese",
    "zh-hans": "Chinese (Simplified)", "zh-hant": "Chinese (Traditional)",
    "ru": "Russian", "rus": "Russian", "russian": "Russian",
    "ar": "Arabic", "ara": "Arabic", "arabic": "Arabic",
    "hi": "Hindi", "hin": "Hindi", "hindi": "Hindi",
    "nl": "Dutch", "dut": "Dutch", "nld": "Dutch", "dutch": "Dutch",
    "sv": "Swedish", "swe": "Swedish", "swedish": "Swedish",
    "no": "Norwegian", "nor": "Norwegian", "norwegian": "Norwegian",
    "da": "Danish", "dan": "Danish", "danish": "Danish",
    "fi": "Finnish", "fin": "Finnish", "finnish": "Finnish",
    "pl": "Polish", "pol": "Polish", "polish": "Polish",
    "tr": "Turkish", "tur": "Turkish", "turkish": "Turkish",
    "cs": "Czech", "cze": "Czech", "ces": "Czech", "czech": "Czech",
    "el": "Greek", "gre": "Greek", "ell": "Greek", "greek": "Greek",
    "he": "Hebrew", "heb": "Hebrew", "hebrew": "Hebrew",
    "th": "Thai", "tha": "Thai", "thai": "Thai",
    "vi": "Vietnamese", "vie": "Vietnamese", "vietnamese": "Vietnamese",
    "id": "Indonesian", "ind": "Indonesian", "indonesian": "Indonesian",
    "uk": "Ukrainian", "ukr": "Ukrainian", "ukrainian": "Ukrainian",
    "ro": "Romanian", "rum": "Romanian", "ron": "Romanian", "romanian": "Romanian",
    "hu": "Hungarian", "hun": "Hungarian", "hungarian": "Hungarian",
    "bg": "Bulgarian", "bul": "Bulgarian", "bulgarian": "Bulgarian",
    "hr": "Croatian", "hrv": "Croatian", "croatian": "Croatian",
    "sr": "Serbian", "srp": "Serbian", "serbian": "Serbian",
    "sk": "Slovak", "slo": "Slovak", "slk": "Slovak", "slovak": "Slovak",
    "sl": "Slovenian", "slv": "Slovenian", "slovenian": "Slovenian",
    "lt": "Lithuanian", "lit": "Lithuanian", "lithuanian": "Lithuanian",
    "lv": "Latvian", "lav": "Latvian", "latvian": "Latvian",
    "et": "Estonian", "est": "Estonian", "estonian": "Estonian",
    "fa": "Persian", "per": "Persian", "fas": "Persian", "persian": "Persian",
    "ur": "Urdu", "urd": "Urdu", "urdu": "Urdu",
    "bn": "Bengali", "ben": "Bengali", "bengali": "Bengali",
    "ta": "Tamil", "tam": "Tamil", "tamil": "Tamil",
    "te": "Telugu", "tel": "Telugu", "telugu": "Telugu",
    "ml": "Malayalam", "mal": "Malayalam", "malayalam": "Malayalam",
    "mr": "Marathi", "mar": "Marathi", "marathi": "Marathi",
    "gu": "Gujarati", "guj": "Gujarati", "gujarati": "Gujarati",
    "pa": "Punjabi", "pan": "Punjabi", "punjabi": "Punjabi",
    "ca": "Catalan", "cat": "Catalan", "catalan": "Catalan",
    "eu": "Basque", "baq": "Basque", "eus": "Basque", "basque": "Basque",
    "gl": "Galician", "glg": "Galician", "galician": "Galician",
    "und": "Undetermined", "unknown": "Unknown",
}

EXCLUDED_INTERFACE_HINTS = (
    "loopback", "vethernet", "bluetooth", "vpn", "tailscale", "zerotier",
    "hyper-v", "wsl", "virtualbox", "vmware", "npcap", "docker", "pseudo",
)


def is_inside_root(candidate: Path) -> bool:
    if MEDIA_ROOT is None:
        return False
    try:
        candidate.resolve().relative_to(MEDIA_ROOT.resolve())
        return True
    except (ValueError, OSError):
        return False


def resolve_video(relative_path: str) -> Path:
    if MEDIA_ROOT is None:
        abort(500)
    candidate = (MEDIA_ROOT / relative_path).resolve()
    if not is_inside_root(candidate) or not candidate.is_file():
        abort(404)
    if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
        abort(404)
    return candidate


def find_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def find_ffprobe() -> str | None:
    probe = shutil.which("ffprobe")
    if probe:
        return probe
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    candidate = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    return str(candidate) if candidate.exists() else None


def pretty_title(path: Path) -> str:
    name = path.stem.replace(".", " ").replace("_", " ")
    return re.sub(r"\s+", " ", name).strip() or path.stem


def relative_posix(path: Path) -> str:
    if MEDIA_ROOT is None:
        return ""
    return path.relative_to(MEDIA_ROOT).as_posix()


def language_label(code: str | None) -> str:
    if not code:
        return ""
    return LANGUAGE_NAMES.get(str(code).lower(), str(code))


def ascii_text(value: str) -> str:
    return unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode("ascii")


def sanitize_hls_tag(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 _().-]+", "", ascii_text(value)).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return (cleaned or fallback)[:48]


def run_probe(path: Path) -> dict | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    with probe_lock:
        if key in probe_cache:
            return probe_cache[key]
    ffprobe = find_ffprobe()
    if not ffprobe:
        with probe_lock:
            probe_cache[key] = None
        return None
    command = [
        ffprobe, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", str(path),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=30, creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode != 0:
            data = None
        else:
            raw = json.loads(result.stdout or "{}")
            data = normalize_probe(raw)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError):
        data = None
    with probe_lock:
        probe_cache[key] = data
    return data


def normalize_probe(raw: dict) -> dict:
    streams = raw.get("streams") or []
    video = None
    audio = []
    subtitles = []
    for stream in streams:
        codec_type = stream.get("codec_type")
        tags = stream.get("tags") or {}
        disposition = stream.get("disposition") or {}
        index = int(stream.get("index", 0))
        if codec_type == "video" and video is None and not disposition.get("attached_pic"):
            video = {
                "index": index,
                "codec_name": stream.get("codec_name") or "",
                "profile": stream.get("profile") or "",
                "pix_fmt": stream.get("pix_fmt") or "",
                "width": int(stream.get("width") or 0),
                "height": int(stream.get("height") or 0),
            }
        elif codec_type == "audio":
            audio.append({
                "index": index,
                "codec_name": stream.get("codec_name") or "",
                "channels": int(stream.get("channels") or 0),
                "language": str(tags.get("language") or ""),
                "title": str(tags.get("title") or ""),
                "default": bool(disposition.get("default")),
            })
        elif codec_type == "subtitle":
            codec = stream.get("codec_name") or ""
            subtitles.append({
                "index": index,
                "codec_name": codec,
                "language": str(tags.get("language") or ""),
                "title": str(tags.get("title") or ""),
                "default": bool(disposition.get("default")),
                "forced": bool(disposition.get("forced")),
                "text": codec.lower() in TEXT_SUBTITLE_CODECS,
            })
    duration = 0.0
    fmt = raw.get("format") or {}
    try:
        duration = float(fmt.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0 and video:
        duration = 0.0
    return {
        "duration": duration,
        "format_name": str(fmt.get("format_name") or ""),
        "video": video,
        "audio": audio,
        "subtitles": subtitles,
    }


def is_h264_8bit(video: dict | None) -> bool:
    if not video or (video.get("codec_name") or "").lower() != "h264":
        return False
    pix = (video.get("pix_fmt") or "").lower()
    profile = (video.get("profile") or "").lower()
    if any(value in pix for value in ("10", "12", "p010", "p016")):
        return False
    if "10" in profile or "4:2:2" in profile or "4:4:4" in profile:
        return False
    return True


def is_direct_video(video: dict | None, suffix: str) -> bool:
    if not video:
        return suffix in DIRECT_CONTAINERS
    codec = (video.get("codec_name") or "").lower()
    pix = (video.get("pix_fmt") or "").lower()
    if suffix in {".mp4", ".m4v", ".mov"}:
        return is_h264_8bit(video)
    if suffix == ".webm":
        if codec not in {"vp8", "vp9", "av1"}:
            return False
        return not any(value in pix for value in ("10", "12", "p010", "p016"))
    return False


def is_direct_audio(track: dict) -> bool:
    codec = (track.get("codec_name") or "").lower()
    channels = int(track.get("channels") or 0)
    return codec in DIRECT_AUDIO_CODECS and (channels <= 2 or channels == 0)


def choose_mode(path: Path, probe: dict | None) -> str:
    suffix = path.suffix.lower()
    if probe and probe.get("video"):
        video = probe["video"]
        audio = probe.get("audio") or []
        if is_direct_video(video, suffix) and len(audio) <= 1 and all(is_direct_audio(track) for track in audio):
            return "direct"
        if is_h264_8bit(video):
            return "remux"
        return "transcode"
    if suffix in DIRECT_CONTAINERS:
        return "direct"
    return "transcode"


def audio_tracks(probe: dict | None) -> list[dict]:
    if not probe:
        return []
    result = []
    for position, track in enumerate(probe.get("audio") or [], start=1):
        language = language_label(track.get("language"))
        label = track.get("title") or language or f"Audio {position}"
        result.append({
            "index": track["index"],
            "codec": track.get("codec_name") or "",
            "channels": track.get("channels") or 0,
            "language": track.get("language") or "",
            "language_name": language,
            "title": track.get("title") or "",
            "label": label,
            "default": track.get("default") or position == 1,
        })
    if len(result) == 1 and not result[0]["title"] and result[0]["language_name"] in ("Undetermined", "Unknown"):
        result[0]["label"] = "Main soundtrack"
    return result


def discover_external_subtitles(video_path: Path) -> list[dict]:
    if MEDIA_ROOT is None:
        return []
    stem = video_path.stem
    directories = [video_path.parent]
    for name in ("Subs", "subs", "Subtitles", "subtitles"):
        candidate = video_path.parent / name
        if candidate.is_dir():
            directories.append(candidate)
    found = []
    seen = set()
    for directory in directories:
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_file() or entry.suffix.lower() not in EXTERNAL_SUBTITLE_EXTENSIONS:
                continue
            base = entry.stem
            if base != stem and not base.startswith(stem + "."):
                continue
            try:
                relative = entry.relative_to(MEDIA_ROOT).as_posix()
            except ValueError:
                continue
            if relative in seen:
                continue
            seen.add(relative)
            tag_text = base[len(stem):].strip(".")
            tags = [tag.lower() for tag in tag_text.split(".") if tag]
            forced = any(tag in {"forced", "force"} for tag in tags)
            sdh = any(tag in {"sdh", "cc", "hi"} for tag in tags)
            language = ""
            for tag in tags:
                if tag in LANGUAGE_NAMES:
                    language = tag
                    break
            label = language_label(language) or "External subtitle"
            if forced:
                label += " (Forced)"
            if sdh:
                label += " (SDH)"
            found.append({
                "id": "e:" + relative,
                "source": "external",
                "label": label,
                "language": language,
                "srclang": language or "und",
                "codec": entry.suffix.lower().lstrip("."),
                "forced": forced,
                "default": False,
                "supported": True,
                "relative": relative,
            })
    found.sort(key=lambda item: (item["label"], item["relative"]))
    return found


def subtitle_tracks(probe: dict | None, video_path: Path) -> tuple[list[dict], int]:
    tracks = []
    unsupported = 0
    if probe:
        for position, stream in enumerate(probe.get("subtitles") or [], start=1):
            if not stream.get("text"):
                unsupported += 1
                continue
            language = language_label(stream.get("language"))
            label = stream.get("title") or language or f"Subtitle {position}"
            if stream.get("forced"):
                label += " (Forced)"
            tracks.append({
                "id": f"s:{stream['index']}",
                "source": "embedded",
                "label": label,
                "language": stream.get("language") or "",
                "srclang": stream.get("language") or "und",
                "codec": stream.get("codec_name") or "",
                "forced": bool(stream.get("forced")),
                "default": bool(stream.get("default")),
                "supported": True,
            })
    for track in discover_external_subtitles(video_path):
        tracks.append(track)
    for track in tracks:
        track["url"] = (
            f"/api/subtitles/{quote(str(video_path.relative_to(MEDIA_ROOT).as_posix()), safe='/')}"
            f"?track={quote(track['id'], safe='')}"
        )
    return tracks, unsupported


def analyze_media(path: Path) -> tuple[dict, dict | None]:
    probe = run_probe(path)
    stat = path.stat()
    relative = relative_posix(path)
    mode = choose_mode(path, probe)
    video = (probe or {}).get("video") or {}
    audio = audio_tracks(probe)
    subtitles, unsupported_subtitles = subtitle_tracks(probe, path)
    info = {
        "path": relative,
        "title": pretty_title(path),
        "folder": path.parent.relative_to(MEDIA_ROOT).as_posix() if path.parent != MEDIA_ROOT else "",
        "size": stat.st_size,
        "modified": stat.st_mtime,
        "extension": path.suffix.lower(),
        "duration": float((probe or {}).get("duration") or 0.0),
        "mode": mode,
        "video": video,
        "audio_tracks": audio,
        "subtitle_tracks": subtitles,
        "unsupported_subtitles": unsupported_subtitles,
        "transcode_available": bool(find_ffmpeg() and find_ffprobe()),
    }
    return info, probe


def detect_encoder() -> str | None:
    with encoder_lock:
        if encoder_state["checked"]:
            return encoder_state["encoder"]
        ffmpeg = find_ffmpeg()
        encoder = None
        if ffmpeg:
            for candidate in ("h264_nvenc", "h264_qsv", "h264_amf", "libx264"):
                test_command = [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "color=c=black:s=256x256:r=1:d=0.2", "-frames:v", "1",
                    "-c:v", candidate, "-f", "null", "-",
                ]
                try:
                    result = subprocess.run(
                        test_command, capture_output=True, timeout=20,
                        creationflags=CREATE_NO_WINDOW,
                    )
                except (OSError, subprocess.SubprocessError):
                    continue
                if result.returncode == 0:
                    encoder = candidate
                    break
        encoder_state["encoder"] = encoder
        encoder_state["checked"] = True
        return encoder


def get_encoder() -> str | None:
    if encoder_state["checked"]:
        return encoder_state["encoder"]
    return detect_encoder()


def video_bitrate_kbps(height: int) -> int:
    if height >= 2000:
        return 20000
    if height >= 1000:
        return 5000
    if height >= 700:
        return 3000
    return 1800


def hls_bandwidth(height: int) -> int:
    bitrate = video_bitrate_kbps(height)
    return int(bitrate * 1.1 * 1000) + 512000


def available_transcode_heights(source_height: int) -> list[int]:
    heights = [DEFAULT_HEIGHT, 720]
    if source_height >= MAX_TRANSCODE_HEIGHT:
        heights.insert(0, MAX_TRANSCODE_HEIGHT)
    return heights


def transcode_key(relative: str, stat: os.stat_result, mode: str, height: int, audio_count: int) -> str:
    raw = f"{relative}|{stat.st_mtime_ns}|{stat.st_size}|{mode}|{height}|{audio_count}|v2"
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:32]


def read_meta(directory: Path) -> dict | None:
    try:
        return json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_meta(directory: Path, meta: dict) -> None:
    try:
        temp = directory / "meta.json.tmp"
        temp.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        temp.replace(directory / "meta.json")
    except OSError:
        pass


def cache_usable(directory: Path, meta: dict) -> bool:
    if not meta or not meta.get("complete"):
        return False
    video_index = int(meta.get("video_index") or 0)
    master = directory / "master.m3u8"
    video_playlist = directory / f"stream_{video_index}" / "index.m3u8"
    return master.is_file() and video_playlist.is_file()


def session_for_cache(session_id: str, key: str, directory: Path, meta: dict, info: dict) -> dict:
    audio_count = len(info.get("audio_tracks") or [])
    video_index = int(meta.get("video_index") if meta.get("video_index") is not None else audio_count)
    return {
        "id": session_id,
        "key": key,
        "dir": directory,
        "relative": info["path"],
        "path": (MEDIA_ROOT / info["path"]).resolve(),
        "mode": meta.get("mode") or info["mode"],
        "height": int(meta.get("height") or DEFAULT_HEIGHT),
        "audio_tracks": info.get("audio_tracks") or [],
        "info": info,
        "duration": float(info.get("duration") or 0.0),
        "video_index": video_index,
        "audio_count": audio_count,
        "proc": None,
        "status": "complete",
        "error": "",
        "created": time.time(),
        "last_access": time.time(),
        "progress_path": directory / "progress.txt",
        "log_path": directory / "ffmpeg.log",
        "encoder": meta.get("encoder") or "",
        "stopping": False,
    }


def make_master(session: dict) -> None:
    directory = session["dir"]
    master = directory / "master.m3u8"
    if master.exists() and master.stat().st_size > 0:
        return
    audio = session.get("audio_tracks") or []
    video_index = session["video_index"]
    video_info = (session.get("info") or {}).get("video") or {}
    source_width = int(video_info.get("width") or 0)
    source_height = int(video_info.get("height") or 0)
    height = session["height"] if session["mode"] == "transcode" else source_height
    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    default_index = 0
    for index, track in enumerate(audio):
        if track.get("default"):
            default_index = index
            break
    for index, track in enumerate(audio):
        name = sanitize_hls_tag(track.get("label") or "", f"Audio {index + 1}")
        language = re.sub(r"[^A-Za-z0-9-]+", "", track.get("language") or "")[:16]
        attrs = [
            "TYPE=AUDIO",
            'GROUP-ID="aud"',
            f'NAME="{name}"',
            "AUTOSELECT=YES",
        ]
        if language:
            attrs.append(f'LANGUAGE="{language}"')
        if index == default_index:
            attrs.append("DEFAULT=YES")
        attrs.append(f'URI="stream_{index}/index.m3u8"')
        lines.append("#EXT-X-MEDIA:" + ",".join(attrs))
    out_height = min(height, source_height) if source_height else height
    out_height = out_height - (out_height % 2)
    out_width = int(source_width * (out_height / source_height)) if source_height and out_height else 0
    out_width = out_width - (out_width % 2)
    bandwidth = hls_bandwidth(out_height or height)
    attrs = [f"BANDWIDTH={bandwidth}"]
    if out_width and out_height:
        attrs.append(f"RESOLUTION={out_width}x{out_height}")
    if audio:
        attrs.append('AUDIO="aud"')
    lines.append("#EXT-X-STREAM-INF:" + ",".join(attrs))
    lines.append(f"stream_{video_index}/index.m3u8")
    temp = directory / "master.m3u8.tmp"
    try:
        temp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        temp.replace(master)
    except OSError:
        pass


def build_ffmpeg_command(session: dict, encoder: str) -> list[str]:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("FFmpeg is not available")
    directory = session["dir"]
    info = session["info"]
    audio = session.get("audio_tracks") or []
    video = info.get("video") or {}
    mode = session["mode"]
    height = session["height"] if mode == "transcode" else 0
    command = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", session["path"]]
    video_index = int(video.get("index") or 0)
    command += ["-map", f"0:{video_index}"]
    for track in audio:
        command += ["-map", f"0:{track['index']}"]
    if mode == "remux":
        command += ["-c:v", "copy"]
    else:
        scale_height = min(height or DEFAULT_HEIGHT, int(video.get("height") or height or DEFAULT_HEIGHT))
        command += ["-vf", f"scale=-2:min({scale_height}\\,ih)", "-pix_fmt", "yuv420p"]
        bitrate = video_bitrate_kbps(scale_height)
        maxrate = int(bitrate * 1.2)
        bufsize = bitrate * 2
        rate_args = ["-b:v", f"{bitrate}k", "-maxrate", f"{maxrate}k", "-bufsize", f"{bufsize}k"]
        if encoder == "h264_nvenc":
            command += ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr"] + rate_args
        elif encoder == "h264_qsv":
            command += ["-c:v", "h264_qsv", "-preset", "veryfast"] + rate_args
        elif encoder == "h264_amf":
            command += ["-c:v", "h264_amf", "-quality", "speed"] + rate_args
        else:
            preset = "superfast" if scale_height >= 1000 else "veryfast"
            command += [
                "-c:v", "libx264", "-preset", preset, "-crf", "22",
                "-maxrate", f"{maxrate}k", "-bufsize", f"{bufsize}k",
            ]
        command += ["-force_key_frames", "expr:gte(t,n_forced*4)"]
    if audio:
        command += ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]
    var_parts = []
    default_index = 0
    for index, track in enumerate(audio):
        if track.get("default"):
            default_index = index
            break
    for index, track in enumerate(audio):
        language = re.sub(r"[^A-Za-z0-9-]+", "", track.get("language") or "")[:16]
        part = [f"a:{index}", "agroup:aud"]
        if index == default_index:
            part.append("default:yes")
        if language:
            part.append(f"language:{language}")
        var_parts.append(",".join(part))
    if audio:
        var_parts.append("v:0,agroup:aud")
    else:
        var_parts.append("v:0")
    command += [
        "-f", "hls",
        "-hls_time", str(HLS_SEGMENT_SECONDS),
        "-hls_init_time", "1",
        "-hls_list_size", "0",
        "-hls_playlist_type", "event",
        "-hls_flags", "independent_segments+temp_file",
        "-hls_segment_filename", str(directory / "stream_%v" / "seg_%06d.ts"),
        "-var_stream_map", " ".join(var_parts),
        "-progress", str(session["progress_path"]),
        "-nostats",
        str(directory / "stream_%v" / "index.m3u8"),
    ]
    return command


def tail_log(session: dict, limit: int = 1200) -> str:
    try:
        data = session["log_path"].read_text(encoding="utf-8", errors="replace")
        return data[-limit:].strip()
    except OSError:
        return ""


def watch_process(session: dict) -> None:
    process = session.get("proc")
    if process is None:
        return
    code = process.wait()
    completed = False
    with session_lock:
        if session.get("stopping"):
            session["status"] = "stopped"
        elif code == 0:
            session["status"] = "complete"
            session["last_access"] = time.time()
            completed = True
        else:
            session["status"] = "error"
            session["error"] = tail_log(session) or "FFmpeg exited before finishing."
        if session["status"] == "complete":
            meta = read_meta(session["dir"]) or {}
            meta.update({
                "complete": True,
                "mode": session["mode"],
                "height": session["height"],
                "video_index": session["video_index"],
                "audio_count": session["audio_count"],
                "encoder": session.get("encoder") or "",
                "last_used": time.time(),
            })
            write_meta(session["dir"], meta)
        global active_transcode_sid
        if active_transcode_sid == session["id"]:
            active_transcode_sid = None
    if completed:
        threading.Thread(target=cleanup_cache, daemon=True).start()


def start_ffmpeg(session: dict, encoder: str | None = None) -> None:
    if encoder is None:
        encoder = get_encoder()
    if not encoder:
        raise RuntimeError("FFmpeg is not available")
    session["encoder"] = encoder
    command = build_ffmpeg_command(session, encoder)
    log_path = session["log_path"]
    try:
        with open(log_path, "wb") as log_file:
            process = subprocess.Popen(
                command, stdout=subprocess.DEVNULL, stderr=log_file,
                creationflags=CREATE_NO_WINDOW,
            )
    except OSError as exc:
        raise RuntimeError(f"Could not start FFmpeg: {exc}") from exc
    session["proc"] = process
    session["status"] = "starting"
    thread = threading.Thread(target=watch_process, args=(session,), daemon=True)
    thread.start()


def terminate_session(session: dict) -> None:
    process = session.get("proc")
    session["stopping"] = True
    if process and process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=4)
        except (OSError, subprocess.SubprocessError):
            try:
                process.kill()
            except OSError:
                pass
    with session_lock:
        session["status"] = "stopped"
        global active_transcode_sid
        if active_transcode_sid == session["id"]:
            active_transcode_sid = None


def stop_other_transcodes(keep_sid: str | None = None) -> None:
    with session_lock:
        running = [
            session for session in sessions.values()
            if session.get("proc") and session["proc"].poll() is None
            and session["id"] != keep_sid
        ]
    for session in running:
        terminate_session(session)


def wait_for_ready(session: dict, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    video_index = session["video_index"]
    video_playlist = session["dir"] / f"stream_{video_index}" / "index.m3u8"
    video_dir = session["dir"] / f"stream_{video_index}"
    master = session["dir"] / "master.m3u8"
    while time.time() < deadline:
        status = session.get("status")
        if status == "error":
            raise RuntimeError(session.get("error") or "Transcoding failed.")
        if status == "stopped":
            raise RuntimeError("Transcoding was stopped.")
        if video_playlist.exists() and video_playlist.stat().st_size > 0:
            try:
                has_segment = any(video_dir.glob("*.ts"))
            except OSError:
                has_segment = False
            if has_segment:
                make_master(session)
                with session_lock:
                    if session["status"] == "starting":
                        session["status"] = "running"
                return session
        process = session.get("proc")
        if process and process.poll() is not None and not video_playlist.exists():
            raise RuntimeError(session.get("error") or "FFmpeg stopped before producing a stream.")
        time.sleep(0.25)
    terminate_session(session)
    raise RuntimeError("Timed out while preparing the stream.")


def start_hls_session(relative_path: str, path: Path, info: dict, probe: dict | None, height: int) -> dict:
    mode = info["mode"]
    if mode not in {"remux", "transcode"}:
        raise RuntimeError("This file does not require HLS.")
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required for this file.")
    stat = path.stat()
    audio = info.get("audio_tracks") or []
    audio_count = len(audio)
    key = transcode_key(relative_path, stat, mode, height if mode == "transcode" else 0, audio_count)
    directory = TRANSCODE_DIR / key
    with start_lock:
        with session_lock:
            for session in sessions.values():
                if session["key"] == key and session["status"] in {"running", "starting"}:
                    session["last_access"] = time.time()
                    return session
            meta = read_meta(directory)
            if meta and cache_usable(directory, meta):
                session_id = secrets.token_urlsafe(12)
                session = session_for_cache(session_id, key, directory, meta, info)
                sessions[session_id] = session
                meta["last_used"] = time.time()
                write_meta(directory, meta)
                return session
        stop_other_transcodes()
        with session_lock:
            if directory.exists():
                shutil.rmtree(directory, ignore_errors=True)
            directory.mkdir(parents=True, exist_ok=True)
            video_index = audio_count if audio else 0
            for index in range(audio_count + 1):
                (directory / f"stream_{index}").mkdir(exist_ok=True)
            session_id = secrets.token_urlsafe(12)
            session = {
                "id": session_id,
                "key": key,
                "dir": directory,
                "relative": relative_path,
                "path": path,
                "mode": mode,
                "height": height if mode == "transcode" else 0,
                "audio_tracks": audio,
                "info": info,
                "duration": float(info.get("duration") or 0.0),
                "video_index": video_index,
                "audio_count": audio_count,
                "proc": None,
                "status": "starting",
                "error": "",
                "created": time.time(),
                "last_access": time.time(),
                "progress_path": directory / "progress.txt",
                "log_path": directory / "ffmpeg.log",
                "encoder": "",
                "stopping": False,
            }
            sessions[session_id] = session
            meta = {
                "complete": False,
                "mode": mode,
                "height": session["height"],
                "video_index": video_index,
                "audio_count": audio_count,
                "source": relative_path,
                "created": time.time(),
                "last_used": time.time(),
            }
            write_meta(directory, meta)
            global active_transcode_sid
            active_transcode_sid = session_id
            make_master(session)
        start_ffmpeg(session)
    return session


def read_progress(session: dict) -> dict:
    path = session.get("progress_path")
    if not path or not path.exists():
        return {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    data = {}
    for line in lines[-80:]:
        if "=" in line:
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip()
    return data


def session_status(session: dict) -> dict:
    progress = read_progress(session)
    converted = 0.0
    if "out_time_us" in progress:
        try:
            converted = float(progress["out_time_us"]) / 1_000_000
        except ValueError:
            converted = 0.0
    elif "out_time_ms" in progress:
        try:
            converted = float(progress["out_time_ms"]) / 1_000_000
        except ValueError:
            converted = 0.0
    elif "out_time" in progress:
        parts = progress["out_time"].split(":")
        try:
            if len(parts) == 3:
                converted = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        except ValueError:
            converted = 0.0
    duration = float(session.get("duration") or 0.0)
    if duration:
        converted = min(converted, duration)
    speed = None
    if progress.get("speed"):
        try:
            speed = float(progress["speed"].rstrip("x"))
        except ValueError:
            speed = None
    status = session.get("status") or "starting"
    if status == "complete":
        converted = duration
    percent = (converted / duration * 100) if duration else 0.0
    error = session.get("error") or ""
    if status == "error" and not error:
        error = tail_log(session) or "FFmpeg failed."
    return {
        "id": session["id"],
        "status": status,
        "mode": session["mode"],
        "height": session["height"],
        "duration": duration,
        "converted": converted,
        "percent": max(0.0, min(100.0, percent)),
        "speed": speed,
        "error": error[-1200:],
        "encoder": session.get("encoder") or "",
    }


def stop_session_by_id(session_id: str) -> bool:
    session = sessions.get(session_id)
    if not session:
        return False
    terminate_session(session)
    if session["status"] != "complete" and not cache_usable(session["dir"], read_meta(session["dir"]) or {}):
        shutil.rmtree(session["dir"], ignore_errors=True)
    return True


def stop_all_sessions() -> None:
    for session in list(sessions.values()):
        process = session.get("proc")
        if process and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass


atexit.register(stop_all_sessions)


def directory_size(directory: Path) -> int:
    total = 0
    try:
        for entry in directory.rglob("*"):
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
    return total


def protected_cache_paths(now: float) -> set[str]:
    protected = set()
    for session in sessions.values():
        try:
            path = str(Path(session["dir"]).resolve())
        except (KeyError, OSError):
            continue
        status = session.get("status") or "starting"
        last_access = float(session.get("last_access") or session.get("created") or 0.0)
        process = session.get("proc")
        alive = bool(process and process.poll() is None)
        if alive:
            protected.add(path)
        elif status in {"starting", "running", "complete"} and now - last_access < CACHE_ACTIVE_GRACE_SECONDS:
            protected.add(path)
    return protected


def cleanup_cache(startup: bool = False) -> None:
    if not cleanup_lock.acquire(blocking=False):
        return
    try:
        now = time.time()
        cached_access: dict[str, float] = {}
        with session_lock:
            for session_id, session in list(sessions.items()):
                if session.get("proc") and session["proc"].poll() is None:
                    continue
                last_access = float(session.get("last_access") or session.get("created") or 0.0)
                status = session.get("status")
                stale = (
                    status in {"stopped", "error"} and now - last_access > 3600
                ) or (
                    status == "complete" and now - last_access > SESSION_RETENTION_SECONDS
                )
                if stale:
                    sessions.pop(session_id, None)
            for session in sessions.values():
                try:
                    path = str(Path(session["dir"]).resolve())
                except (KeyError, OSError):
                    continue
                last_access = float(session.get("last_access") or session.get("created") or 0.0)
                cached_access[path] = max(cached_access.get(path, 0.0), last_access)
        entries = []
        for directory in TRANSCODE_DIR.iterdir():
            if not directory.is_dir():
                continue
            try:
                path = str(directory.resolve())
                age = now - directory.stat().st_mtime
            except OSError:
                continue
            meta = read_meta(directory)
            usable = cache_usable(directory, meta)
            size = directory_size(directory)
            entries.append({
                "directory": directory,
                "path": path,
                "size": size,
                "usable": usable,
                "orphan": not usable and (startup or age >= CACHE_ORPHAN_GRACE_SECONDS),
                "last_used": max(
                    float((meta or {}).get("last_used") or 0.0),
                    cached_access.get(path, 0.0),
                ),
            })
        with start_lock:
            with session_lock:
                live_protected = protected_cache_paths(time.time())
            for entry in entries:
                if entry["orphan"] and entry["path"] not in live_protected:
                    shutil.rmtree(entry["directory"], ignore_errors=True)
                    entry["deleted"] = True
                else:
                    entry["deleted"] = False
            total = sum(entry["size"] for entry in entries if not entry["deleted"])
            evictable = sorted(
                (
                    entry for entry in entries
                    if entry["usable"] and not entry["deleted"] and entry["path"] not in live_protected
                ),
                key=lambda entry: entry["last_used"],
            )
            for entry in evictable:
                if total <= CACHE_LIMIT_BYTES:
                    break
                shutil.rmtree(entry["directory"], ignore_errors=True)
                total -= entry["size"]
    except OSError:
        pass
    finally:
        cleanup_lock.release()


def cleanup_worker() -> None:
    cleanup_cache(startup=True)
    while True:
        time.sleep(CACHE_CLEANUP_INTERVAL_SECONDS)
        cleanup_cache()


def get_lan_addresses() -> list[dict]:
    now = time.time()
    with lan_lock:
        if now - lan_cache["at"] < 300:
            return list(lan_cache["items"])
    primary = ""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        primary = sock.getsockname()[0]
        sock.close()
    except OSError:
        primary = ""
    found: list[tuple[str, str]] = []
    try:
        import psutil
        for interface, addresses in psutil.net_if_addrs().items():
            for address in addresses:
                if address.family == socket.AF_INET:
                    found.append((address.address, interface))
    except ImportError:
        if os.name == "nt":
            script = (
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
                "Get-NetIPAddress -AddressFamily IPv4 | "
                "Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | "
                "Select-Object InterfaceAlias, IPAddress | ConvertTo-Json -Compress"
            )
            try:
                result = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=8, creationflags=CREATE_NO_WINDOW,
                )
                data = json.loads(result.stdout or "[]")
                if isinstance(data, dict):
                    data = [data]
                for item in data:
                    found.append((item.get("IPAddress") or "", item.get("InterfaceAlias") or ""))
            except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
                pass
        try:
            hostname = socket.gethostbyname_ex(socket.gethostname())[2]
            for address in hostname:
                found.append((address, "LAN"))
        except OSError:
            pass
    if primary and not any(address == primary for address, _ in found):
        found.append((primary, "Primary route"))
    result = []
    seen = set()
    for address, interface in found:
        if not address or address in seen:
            continue
        if address.startswith(("127.", "169.254.", "0.", "255.")):
            continue
        lowered = interface.lower()
        is_primary = address == primary
        if any(hint in lowered for hint in EXCLUDED_INTERFACE_HINTS) and not is_primary:
            continue
        seen.add(address)
        result.append({
            "ip": address,
            "interface": interface,
            "primary": is_primary,
        })
    result.sort(key=lambda item: (not item["primary"], item["interface"].lower(), item["ip"]))
    with lan_lock:
        lan_cache["at"] = now
        lan_cache["items"] = result
    return result


def server_port() -> int:
    try:
        return int(os.environ.get("PORT", "8000"))
    except ValueError:
        return 8000


def server_info() -> dict:
    port = server_port()
    addresses = get_lan_addresses()
    for address in addresses:
        address["url"] = f"http://{address['ip']}:{port}"
    primary = next((address for address in addresses if address["primary"]), addresses[0] if addresses else None)
    encoder = encoder_state["encoder"] if encoder_state["checked"] else "detecting"
    if not find_ffmpeg():
        encoder = "unavailable"
    return {
        "name": "Cinéaste",
        "tagline": "A film lover's private library.",
        "port": port,
        "local_url": f"http://127.0.0.1:{port}",
        "addresses": addresses,
        "primary_url": primary["url"] if primary else f"http://127.0.0.1:{port}",
        "ffmpeg": bool(find_ffmpeg()),
        "ffprobe": bool(find_ffprobe()),
        "encoder": encoder,
        "max_height": MAX_TRANSCODE_HEIGHT,
        "cache_limit_gb": round(CACHE_LIMIT_BYTES / (1024 ** 3), 1),
    }


def make_thumbnail(video_path: Path) -> Path | None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    try:
        relative = video_path.relative_to(MEDIA_ROOT).as_posix()
        key = hashlib.sha256(relative.encode("utf-8", "replace")).hexdigest()
        thumb = THUMB_DIR / f"{key}.jpg"
        if thumb.exists() and thumb.stat().st_mtime >= video_path.stat().st_mtime:
            return thumb
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", "00:00:30",
             "-i", str(video_path), "-frames:v", "1", "-vf", "scale=360:-2",
             "-q:v", "5", "-y", str(thumb)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25,
            creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode == 0 and thumb.exists() and thumb.stat().st_size:
            return thumb
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def parse_cropdetect(output: str) -> tuple[int, int, int, int] | None:
    matches = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", output or "")
    if not matches:
        return None
    try:
        crop_width, crop_height, crop_x, crop_y = matches[-1]
        return int(crop_width), int(crop_height), int(crop_x), int(crop_y)
    except (TypeError, ValueError):
        return None


def bars_from_crop(
    crop: tuple[int, int, int, int] | None,
    frame_width: int,
    frame_height: int,
) -> dict | None:
    if not crop or frame_width <= 0 or frame_height <= 0:
        return None
    _crop_width, crop_height, _crop_x, crop_y = crop
    top = crop_y
    bottom = frame_height - (crop_y + crop_height)
    if top < 0 or bottom < 0 or crop_height <= 0:
        return None
    top_fraction = top / frame_height
    bottom_fraction = bottom / frame_height
    if top_fraction < 0.01 or bottom_fraction < 0.01:
        return None
    if abs(top_fraction - bottom_fraction) > 0.01:
        return None
    content_height = frame_height - top - bottom
    if content_height <= 0:
        return None
    content_aspect = frame_width / content_height
    if content_aspect < 1.5 or content_aspect > 2.8:
        return None
    return {
        "top": round(top_fraction, 6),
        "bottom": round(bottom_fraction, 6),
    }


def detect_image_bars(thumbnail: Path) -> dict | None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    image = run_probe(thumbnail)
    image_video = (image or {}).get("video") or {}
    image_width = int(image_video.get("width") or 0)
    image_height = int(image_video.get("height") or 0)
    if image_width <= 0 or image_height <= 0:
        return None
    command = [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info", "-loop", "1",
        "-i", str(thumbnail), "-frames:v", "3",
        "-vf", "format=yuv420p,cropdetect=24:2:0", "-f", "null", "-",
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=10, creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return bars_from_crop(parse_cropdetect(result.stderr), image_width, image_height)


def cropdetect_sample(
    path: Path,
    seconds: float,
    video_index: int,
    source_height: int,
) -> tuple[int, int, int, int] | None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    attempts = [True, False] if source_height >= 1800 else [False]
    for hardware in attempts:
        command = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info"]
        if hardware:
            command += ["-hwaccel", "auto"]
        command += [
            "-ss", f"{max(0.0, seconds):.3f}", "-i", str(path),
            "-map", f"0:{video_index}", "-frames:v", "3",
            "-vf", "format=yuv420p,cropdetect=24:2:0",
            "-an", "-sn", "-dn", "-f", "null", "-",
        ]
        try:
            result = subprocess.run(
                command, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=20, creationflags=CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        crop = parse_cropdetect(result.stderr)
        if crop:
            return crop
    return None


def letterbox_matches(left: dict, right: dict) -> bool:
    return (
        abs(left["top"] - right["top"]) <= 0.01
        and abs(left["bottom"] - right["bottom"]) <= 0.01
    )


def detect_letterbox(path: Path, info: dict) -> dict | None:
    video = info.get("video") or {}
    frame_width = int(video.get("width") or 0)
    frame_height = int(video.get("height") or 0)
    if frame_width <= 0 or frame_height <= 0:
        return None
    frame_aspect = frame_width / frame_height
    if frame_aspect < 1.4 or frame_aspect > 2.2:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    with letterbox_lock:
        if key in letterbox_cache:
            return letterbox_cache[key]
    result = None
    try:
        thumbnail = make_thumbnail(path)
        thumb_bars = detect_image_bars(thumbnail) if thumbnail else None
        if thumb_bars:
            duration = float(info.get("duration") or 0.0)
            if duration > 0:
                positions = (duration * 0.6, duration * 0.8)
            else:
                positions = (5.0, 15.0)
            video_index = int(video.get("index") or 0)
            for seconds in positions:
                crop = cropdetect_sample(path, seconds, video_index, frame_height)
                source_bars = bars_from_crop(crop, frame_width, frame_height)
                if source_bars and letterbox_matches(thumb_bars, source_bars):
                    result = source_bars
                    break
    except (OSError, subprocess.SubprocessError, ValueError):
        result = None
    with letterbox_lock:
        if len(letterbox_cache) >= 2048:
            letterbox_cache.clear()
        letterbox_cache[key] = result
    return result


def convert_subtitle(path: Path, track_id: str) -> Path | None:
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    source_mtime = 0
    source_key = ""
    input_path = path
    if track_id.startswith("s:"):
        try:
            stream_index = int(track_id[2:])
        except ValueError:
            return None
        probe = run_probe(path)
        if not probe:
            return None
        stream = next((item for item in probe.get("subtitles") or [] if item["index"] == stream_index), None)
        if not stream or not stream.get("text"):
            return None
        source_mtime = path.stat().st_mtime_ns
        source_key = f"embedded:{stream_index}"
        map_spec = f"0:{stream_index}"
    elif track_id.startswith("e:"):
        relative = track_id[2:]
        if MEDIA_ROOT is None:
            return None
        input_path = (MEDIA_ROOT / relative).resolve()
        if not is_inside_root(input_path) or not input_path.is_file():
            return None
        if input_path.suffix.lower() not in EXTERNAL_SUBTITLE_EXTENSIONS:
            return None
        allowed = {item["id"] for item in discover_external_subtitles(path)}
        if track_id not in allowed:
            return None
        source_mtime = input_path.stat().st_mtime_ns
        source_key = "external:" + relative
        map_spec = "0:s:0"
    else:
        return None
    key = hashlib.sha256(
        f"{relative_posix(path)}|{path.stat().st_mtime_ns}|{source_key}|{source_mtime}|v3".encode("utf-8", "replace")
    ).hexdigest()
    output = SUBTITLE_DIR / f"{key}.vtt"
    if output.exists() and output.stat().st_size > 0:
        return output
    if track_id.startswith("e:") and input_path.suffix.lower() == ".vtt":
        try:
            output.write_bytes(input_path.read_bytes())
            return output
        except OSError:
            return None
    temp = SUBTITLE_DIR / f"{key}.tmp.vtt"
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(input_path),
        "-map", map_spec, "-c:s", "webvtt", "-f", "webvtt", str(temp),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, timeout=40,
            creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode == 0 and temp.exists() and temp.stat().st_size:
            temp.replace(output)
            return output
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        temp.unlink(missing_ok=True)
    except OSError:
        pass
    return None


PLACEHOLDER_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="360" height="540" viewBox="0 0 360 540">
<rect width="360" height="540" fill="#17130f"/>
<rect x="18" y="18" width="324" height="504" fill="none" stroke="#f2e8d8" stroke-opacity=".22"/>
<g fill="#f2e8d8" opacity=".32">
<rect x="34" y="4" width="14" height="8" rx="2"/><rect x="66" y="4" width="14" height="8" rx="2"/><rect x="98" y="4" width="14" height="8" rx="2"/><rect x="130" y="4" width="14" height="8" rx="2"/><rect x="162" y="4" width="14" height="8" rx="2"/><rect x="194" y="4" width="14" height="8" rx="2"/><rect x="226" y="4" width="14" height="8" rx="2"/><rect x="258" y="4" width="14" height="8" rx="2"/><rect x="290" y="4" width="14" height="8" rx="2"/>
<rect x="34" y="528" width="14" height="8" rx="2"/><rect x="66" y="528" width="14" height="8" rx="2"/><rect x="98" y="528" width="14" height="8" rx="2"/><rect x="130" y="528" width="14" height="8" rx="2"/><rect x="162" y="528" width="14" height="8" rx="2"/><rect x="194" y="528" width="14" height="8" rx="2"/><rect x="226" y="528" width="14" height="8" rx="2"/><rect x="258" y="528" width="14" height="8" rx="2"/><rect x="290" y="528" width="14" height="8" rx="2"/>
</g>
<text x="180" y="315" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="176" fill="#f2e8d8">C</text>
<circle cx="180" cy="352" r="7" fill="#d64027"/>
<text x="180" y="428" text-anchor="middle" font-family="'Courier New', monospace" font-size="14" letter-spacing="5" fill="#b8ac9a">CINÉASTE</text>
<text x="180" y="456" text-anchor="middle" font-family="'Courier New', monospace" font-size="9" letter-spacing="3" fill="#6e6559">PRIVATE EDITION</text>
</svg>"""


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/videos")
def api_videos():
    items = []
    if MEDIA_ROOT is None:
        return jsonify(items)
    try:
        paths = MEDIA_ROOT.rglob("*")
        for path in paths:
            try:
                if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
                    stat = path.stat()
                    relative = path.relative_to(MEDIA_ROOT).as_posix()
                    parent = path.parent.relative_to(MEDIA_ROOT).as_posix()
                    items.append({
                        "path": relative,
                        "title": pretty_title(path),
                        "folder": "" if parent == "." else parent,
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                        "extension": path.suffix.lower(),
                    })
            except (OSError, PermissionError, ValueError):
                continue
    except OSError:
        pass
    items.sort(key=lambda item: (item["folder"].lower(), item["title"].lower()))
    return jsonify(items)


@app.get("/api/server-info")
def api_server_info():
    return jsonify(server_info())


@app.get("/api/media-info/<path:relative_path>")
def api_media_info(relative_path):
    path = resolve_video(relative_path)
    info, _ = analyze_media(path)
    return jsonify(info)


@app.post("/api/play/<path:relative_path>")
def api_play(relative_path):
    path = resolve_video(relative_path)
    info, probe = analyze_media(path)
    payload = request.get_json(silent=True) or {}
    source_height = int(info.get("video", {}).get("height") or 0)
    available_heights = available_transcode_heights(source_height)
    try:
        height = int(payload.get("height") or DEFAULT_HEIGHT)
    except (TypeError, ValueError):
        height = DEFAULT_HEIGHT
    if height not in available_heights:
        height = DEFAULT_HEIGHT
    force = bool(payload.get("force_transcode"))
    mode = info["mode"]
    if force and mode != "transcode":
        mode = "transcode"
    letterbox = detect_letterbox(path, info)
    if mode == "direct":
        url = "/media/" + quote(relative_path, safe="/")
        return jsonify({
            "mode": "direct",
            "play_mode": "direct",
            "url": url,
            "session_id": None,
            "duration": info["duration"],
            "height": source_height,
            "source_height": source_height,
            "available_heights": available_heights,
            "letterbox": letterbox,
            "audio_tracks": info["audio_tracks"],
            "subtitle_tracks": info["subtitle_tracks"],
            "unsupported_subtitles": info["unsupported_subtitles"],
            "limited_seeking": False,
            "encoder": None,
        })
    if not find_ffmpeg():
        return jsonify({"error": "FFmpeg is required for this file. Install FFmpeg and restart Cinéaste."}), 503
    effective_info = dict(info)
    effective_info["mode"] = mode
    try:
        session = start_hls_session(relative_path, path, effective_info, probe, height)
        session = wait_for_ready(session)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500
    except OSError as exc:
        return jsonify({"error": f"Could not prepare this stream: {exc}"}), 500
    return jsonify({
        "mode": "hls",
        "play_mode": session["mode"],
        "url": f"/hls/{session['id']}/master.m3u8",
        "session_id": session["id"],
        "duration": session["duration"],
        "height": session["height"] if session["mode"] == "transcode" else source_height,
        "source_height": source_height,
        "available_heights": available_heights,
        "letterbox": letterbox,
        "audio_tracks": info["audio_tracks"],
        "subtitle_tracks": info["subtitle_tracks"],
        "unsupported_subtitles": info["unsupported_subtitles"],
        "limited_seeking": True,
        "encoder": session.get("encoder") or "",
    })


@app.get("/api/play/<session_id>/status")
def api_play_status(session_id):
    session = sessions.get(session_id)
    if not session:
        abort(404)
    session["last_access"] = time.time()
    return jsonify(session_status(session))


@app.post("/api/play/<session_id>/stop")
def api_play_stop(session_id):
    stopped = stop_session_by_id(session_id)
    return jsonify({"stopped": stopped})


@app.get("/hls/<session_id>/<path:filename>")
def hls_file(session_id, filename):
    session = sessions.get(session_id)
    if not session:
        abort(404)
    base = session["dir"].resolve()
    target = (base / filename).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        abort(404)
    if not target.is_file() or target.suffix.lower() not in {".m3u8", ".ts", ".mp4"}:
        abort(404)
    session["last_access"] = time.time()
    if target.suffix.lower() == ".m3u8":
        response = send_file(target, mimetype="application/vnd.apple.mpegurl", conditional=False, max_age=0)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    else:
        response = send_file(target, mimetype="video/mp2t", conditional=True, etag=True, max_age=3600)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/api/subtitles/<path:relative_path>")
def api_subtitles(relative_path):
    path = resolve_video(relative_path)
    track_id = request.args.get("track", "")
    output = convert_subtitle(path, track_id)
    if not output:
        abort(404)
    try:
        data = output.read_bytes()
    except OSError:
        abort(404)
    response = Response(data, mimetype="text/vtt")
    response.headers["Cache-Control"] = "public, max-age=86400"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/thumbnail/<path:relative_path>")
def thumbnail(relative_path):
    candidate = (MEDIA_ROOT / relative_path).resolve()
    if not is_inside_root(candidate) or not candidate.is_file() or candidate.suffix.lower() not in VIDEO_EXTENSIONS:
        abort(404)
    thumb = make_thumbnail(candidate)
    if thumb:
        return send_file(thumb, mimetype="image/jpeg", conditional=True, max_age=86400)
    return Response(PLACEHOLDER_SVG, mimetype="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/media/<path:relative_path>")
def media(relative_path):
    candidate = resolve_video(relative_path)
    mimetype = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    response = send_file(
        candidate, mimetype=mimetype, conditional=True, etag=True,
        last_modified=candidate.stat().st_mtime,
    )
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def main():
    global MEDIA_ROOT
    if len(sys.argv) < 2:
        print('Usage: python server.py "D:\\Movies"')
        print("Pass the folder containing your video library as the first argument.")
        raise SystemExit(2)
    root = Path(sys.argv[1]).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        print(f"Error: folder does not exist: {root}")
        raise SystemExit(2)
    MEDIA_ROOT = root
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    port = server_port()
    threading.Thread(target=detect_encoder, daemon=True).start()
    threading.Thread(target=cleanup_worker, daemon=True).start()
    addresses = get_lan_addresses()
    print()
    print("CINÉASTE")
    print("A film lover's private library.")
    print()
    print(f"Video folder: {MEDIA_ROOT}")
    print(f"On this laptop: http://127.0.0.1:{port}")
    tablet_addresses = [item for item in addresses if item["ip"] not in {"127.0.0.1"}]
    if tablet_addresses:
        for item in tablet_addresses:
            label = item["interface"] or "LAN"
            suffix = " (primary)" if item["primary"] else ""
            print(f"On your tablet: http://{item['ip']}:{port}  [{label}]{suffix}")
        print("Use the address on the same network as your tablet.")
    else:
        print("No LAN address detected. Check your Wi-Fi or Ethernet connection.")
    print(f"FFmpeg: {'found' if find_ffmpeg() else 'not found (transcoding and thumbnails disabled)'}")
    print("Keep this window open while streaming. Press Ctrl+C to stop.")
    print()
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
