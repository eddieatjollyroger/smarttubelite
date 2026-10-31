# TubeTV (SmartTube-lite)

A tiny self-hosted YouTube front end for TVs that can't run SmartTube — specifically
Hisense/Toshiba **VIDAA**, Samsung Tizen, LG webOS, or any old browser.

It uses YouTube's official TV device-code sign-in, pulls your real home feed
(`FEwhat_to_watch`) and subscriptions from InnerTube, and plays video with `yt-dlp`.
No YouTube player code is loaded, so there are no ads to block.

## What you get

- Your actual recommendation feed (logged in), not a "trending" page
- Subscriptions feed
- Search
- H.264/AAC playback forced, so old TV browsers can decode it
- Remote-friendly UI: big tiles, arrow-key spatial navigation
- No ads, no tracking pixels, no YouTube player

## Requirements

- Node.js 18+ (tested on 25), or Docker
- `yt-dlp` for your platform (the copy in `bin/` is **macOS only**)
- A host on the same network as the TV — a Raspberry Pi 5 is plenty (see *Performance*)

## Run

### Docker (recommended on a Pi / always-on box)

```sh
cd smarttube-lite
docker compose up -d --build
```

Serves on **port 8484** (`TUBETV_PORT=9000 docker compose up -d` to change). The
container downloads the matching `yt-dlp` for its architecture at build time and
keeps sign-in tokens in `./data`. Update yt-dlp by rebuilding:

```sh
docker compose build --pull --build-arg YTDLP_VERSION=$(curl -s https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
docker compose up -d
```

### Plain Node

```sh
cd ~/smarttube-lite
./run.sh
```

It prints something like:

```
  local:   http://localhost:8484
  TV:      http://192.168.1.42:8484
```

On Linux the yt-dlp binary must match the machine: replace `bin/yt-dlp` with
`yt-dlp_linux_aarch64` (Pi 5) or `yt-dlp_linux` (x86_64) from the
[releases page](https://github.com/yt-dlp/yt-dlp/releases).

Open the **TV** URL in the TV browser. On VIDAA:

- VIDAA ≤ 4: browser → `hisense://debug` → App name `TubeTV`, App URL = the TV URL.
- VIDAA 5–8: use [vidaa-edge](https://github.com/weinzii/vidaa-edge) to install it as a PWA,
  or just bookmark the URL in the browser.

## Sign in

1. Open `http://<your-ip>:8484/login` on the TV (or click **Sign in**).
2. On your phone, open <https://www.google.com/device> and enter the code shown on the TV.
3. Approve. The page reloads into your personalized home feed.

The pending code is saved to `data/pending.json`, so restarting or rebuilding the
container does not invalidate it. Uses the same public OAuth client as the YouTube
TV app. Revoke any time at `myaccount.google.com → Security → Third-party connections`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8484` | HTTP port (container-internal in Docker) |
| `TUBETV_PORT` | `8484` | Host port published by compose |
| `HOST` | `0.0.0.0` | Bind address |
| `YT_GL` | `US` | Country for recommendations. Try `PT`, `BR`, etc. |
| `YT_HL` | `en` | UI language |
| `YTDLP` | `bin/yt-dlp` | Path to yt-dlp binary (Docker sets this) |

## Performance

No transcoding happens anywhere — yt-dlp only returns stream URLs and the server
copies bytes — so CPU stays flat:

| Activity | Measured on an ARM Mac | Pi 5 (scaled) |
|---|---|---|
| Idle | ~0% | <1% of one core |
| Proxying 1080p | 2.6% of one core @ 3.3 Mbps | ~4–6% (up to ~12% for 8 Mbps) |
| Resolving a new video | 0.83 CPU-s, 1.9 s, 98 MB peak | ~2 CPU-s, 3–5 s, cached 3 h |
| RAM | 100–135 MB | same |

The real limit is bandwidth: traffic passes through the box twice (Google → host →
TV), so budget ~2× the video bitrate. Gigabit ethernet is plenty.

## Keep it working

- Keep yt-dlp current: `bin/yt-dlp -U`, or rebuild the image (see above).
- If a video says "bot check", wait a minute or re-login.
- `data/auth.json` holds your tokens (mode 600). Delete it to sign out.

## Limitations

- **LAN only.** There is no authentication on the server itself. Do not port-forward it.
- A plain-Node host must stay awake (`caffeinate -i ./run.sh` on macOS; systemd on Linux).
- Only the first page of each feed is loaded (no infinite scroll / continuations yet).
- No Shorts, no comments, no channel pages, no casting.
- Unofficial: uses InnerTube and a public OAuth client. Google can change either at any time.
- 1080p H.264 max. VIDAA's browser usually can't do VP9/AV1 or 4K.
- Audio and video are separate DASH streams synced in the page; if they drift, pause/play once.
