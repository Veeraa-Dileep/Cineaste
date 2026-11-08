# Cinéaste
### A film lover's private library.

Cinéaste is a local-only film library for a Windows laptop and the screens around
your home. It scans a folder of videos, presents them like a small repertory
cinema, and streams them to a browser on the same Wi-Fi network. There is no
account, no cloud, no recommendation feed, and no internet connection required.

## Highlights
- Editorial "private screening room" interface with a warm-paper and ink theme.
- Responsive browsing for laptop, tablet, and phone, with search and folder shelves.
- Poster thumbnails generated from the films by FFmpeg.
- Direct MP4/WebM playback when the browser can handle the source.
- Automatic HLS remux for H.264 files in other containers such as MKV.
- Automatic HLS transcode for HEVC/10-bit or otherwise incompatible sources.
- Optional 4K H.264 output for 4K sources, using NVENC, QSV, AMF, or CPU.
- Selectable embedded audio tracks and embedded text subtitles.
- Automatic discovery of external `.srt`, `.vtt`, `.ass`, `.ssa`, and `.sub` files.
- Per-film audio, subtitle, frame, volume, and quality preferences in the browser.
- Auto-fit for films with baked-in letterbox bars on wide screens, with an
  Original-frame toggle.
- Keyboard controls and a LAN address you can copy to another device.

## Requirements
- Windows 10 or 11.
- Python 3.10 or newer.
- A modern browser: current Chrome, Edge, Firefox, or Safari.
- Optional but strongly recommended: FFmpeg and FFprobe on `PATH`.

Without FFmpeg, direct browser-compatible files and generic placeholder posters
still work. FFmpeg is required for real thumbnails, remuxing, transcoding, and
subtitle extraction.

## 1. Install Python
Install Python 3.10+ from https://www.python.org/downloads/windows/.
During installation, enable **Add python.exe to PATH**. If Python is already
installed, skip this step.

## 2. Install the dependency
Open PowerShell in this folder and run:
```powershell
python -m pip install -r requirements.txt
```

## 3. Install FFmpeg (recommended)
Install FFmpeg and make sure both `ffmpeg -version` and `ffprobe -version` work in
a NEW PowerShell window. The app searches `PATH` and common Windows install
locations. Restart Cinéaste after installing FFmpeg.

## 4. Start Cinéaste
Pass the folder that contains your films:
```powershell
python server.py "D:\Movies"
```

The server scans nested folders and prints your local and LAN addresses:
```
On this laptop: http://127.0.0.1:8000
On your tablet: http://192.168.1.20:8000  [Wi-Fi]
```

Open the laptop address locally, or open the printed tablet address on a device
connected to the same Wi-Fi. You can also use the address-copy control in the
Screening Room.

If Windows Firewall asks, allow Python on **Private networks only**. If no prompt
appears and another device cannot connect, create an inbound rule for the port on
Private networks. Managed or guest Wi-Fi may block communication between devices;
a personal hotspot is a useful test.

## Playback behavior
Cinéaste picks the lightest reliable method for each film:

1. **Direct** — MP4, M4V, MOV with 8-bit H.264 and at most one stereo AAC/MP3
   track, or browser-compatible WebM. The original file is served unchanged.
2. **Remux** — 8-bit H.264 in a less browser-friendly container such as MKV.
   Video is copied without re-encoding; audio is converted to browser-friendly
   HLS streams when needed.
3. **Transcode** — HEVC/H.265, 10-bit video, and other incompatible sources are
   scaled and encoded for the browser. Choose 1080p or 720p from the player.
   For 4K sources that need transcoding, 2160p (4K) is also offered. 4K output
   is SDR 8-bit H.264: HDR is not preserved, and the source file must already be
   4K. Direct-playable 4K H.264 and 4K remuxes stay at 4K without transcoding.

Transcodes are prepared on demand into `transcode_cache`. The default cache limit
is 40 GB; a two-hour 4K print is roughly 18 GB. Cleanup runs every five minutes
and after a transcode finishes:
abandoned incomplete runs are removed, prints that are being watched or were
used recently are protected, and the least-recently-used completed prints are
evicted when the limit is exceeded. A protected 4K print may temporarily keep
the cache above its limit while it is being prepared. Only one transcode runs at
a time, so a second incompatible film may wait for the first reel to finish.
Seeking during a live transcode is limited to the frames already prepared;
seeking becomes unrestricted once the print is complete.

The player supports embedded audio-track switching and embedded/external text
subtitles. Bitmap subtitles (PGS, VobSub, and similar) are not supported because
browsers cannot render them as HTML text. A backend-supplied subtitle file is
never burned into the video.

When a film's widescreen picture is baked into a taller frame with black bars,
Cinéaste detects the real picture and fills a wide screen with it. Use the frame
button near fullscreen to restore the original encoded frame; the choice is
remembered per film. This is presentation-only and does not re-encode the film.

## Keyboard controls
Library:
- `/` — open search
- `Arrow Down` / `Arrow Up` — move through search results
- `Enter` — play the highlighted result
- `Esc` — close search

Player:
- `Space` or `K` — play/pause
- `←` / `→` — seek back/forward 10 seconds
- `↑` / `↓` — adjust volume
- `M` — mute/unmute
- `F` — enter/exit fullscreen
- `Esc` — close the player or exit fullscreen

## Optional configuration
Set these in PowerShell before starting the server:
```powershell
$env:PORT = "8001"
$env:TRANSCODE_CACHE_GB = "60"
python server.py "D:\Movies"
```
- `PORT` changes the HTTP port (default `8000`).
- `TRANSCODE_CACHE_GB` changes the transcode cache limit (default `40`).

## Folder layout
Point Cinéaste at the top of your film collection. Nested folders become shelves
in the Screening Room. For example:
```
D:\Movies\
  Noir\
    After Hours (2024)\
      After Hours (2024).mkv
  Documentary\
    The Tenth Frame.mkv
  Flat\
    Color Bars.mp4
```
Supported video extensions: MP4, M4V, MKV, MOV, WebM, AVI, WMV, FLV, MPG, MPEG,
TS, M2TS, 3GP, and OGV.

## Troubleshooting
- **`python` not found:** try `py -m pip install -r requirements.txt` and
  `py server.py "D:\Movies"`.
- **Port already in use:** stop the earlier server or start with
  `$env:PORT=8001`, then use port 8001 on the tablet.
- **A file will not play:** check that FFmpeg/FFprobe are installed and working.
  Direct files are the most reliable; HEVC and 10-bit sources need transcoding.
- **Transcoding is slow:** the first play prepares the stream. Later plays reuse
  the cache. On older CPUs, use 720p and keep only one incompatible film running.
- **4K stutters or is slow to start:** 4K H.264 needs a fast GPU encoder, roughly
  20 Mbps of network bandwidth, and a large cache. Use 1080p on modest hardware.
  HDR sources are shown as SDR because tone mapping is not performed.
- **No thumbnails:** install FFmpeg, confirm it works in a new terminal, then
  restart the server and reload the page.
- **Subtitles are missing:** only text subtitles are supported. For external
  subtitles, keep the subtitle file beside the video and use a matching filename.
- **No tablet connection:** confirm both devices are on the same Wi-Fi, use the
  active Wi-Fi IPv4 address, allow Python on Private networks, and check for
  client isolation on managed Wi-Fi.
- **Seeking is limited on an incompatible film:** wait for the "Print ready"
  conversion chip to disappear or for the reel to finish preparing.

## Security and privacy
Cinéaste is designed for a trusted home network. There is no authentication:
anyone who can reach the port may browse and stream the configured folder. Do not
expose it to the internet, and do not point it at a folder containing sensitive
files. Stop the server with `Ctrl+C`.

All playback stays on your machine and local network. The bundled HLS player is
served locally, so no third-party CDN or cloud service is contacted.
