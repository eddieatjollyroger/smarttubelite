# TubeTV (SmartTube-lite)

A tiny self-hosted YouTube front end for TVs that can't run SmartTube — specifically
Hisense/Toshiba **VIDAA**, Samsung Tizen, LG webOS, or any old browser.

It uses YouTube's official TV device-code sign-in, pulls your real home feed
(`FEwhat_to_watch`), subscriptions and watch history from InnerTube, and plays video
with `yt-dlp`. No YouTube player code is loaded, so there are no ads to block.

## What you get

- Your actual recommendation feed (logged in), not a "trending" page
- Subscriptions and watch **history** feeds
- Search
- Endless scrolling: reaching the last row loads the next page automatically
- H.264/AAC playback forced, so old TV browsers can decode it
- Videos open fullscreen and autoplay (falls back to muted autoplay + one OK press for sound)
- Quality cascade 1080p → 720p → 480p → compatible file, and it remembers what your
  TV could decode so later videos start there
- Livestreams, played as HLS through a built-in relay (no native HLS required)
- Remote-friendly UI: big tiles, arrow-key spatial navigation
- No ads, no tracking pixels, no YouTube player

## Remote controls

| Key | Grid / search | Player |
|---|---|---|
| ← → ↑ ↓ | move between tiles and nav links | seek ∓10 s / show controls |
| OK / Enter | open the focused item | play / pause (first OK also unmutes) |
| Back / Backspace / Esc | previous page | back to the grid |
| Play/Pause | — | play / pause |
| F | — | toggle fullscreen |

The player is cinema-style: no page chrome, no native control bar, video fills the
screen. The overlay, status pill and clock fade out after a few seconds of playback
and come back on any key. Clicking/tapping the picture also play-pauses.

If a TV cannot decode a stream it steps down automatically. The chosen tier is stored
in the browser; open `/watch?id=…&h=1080` to forget it and try again at 1080p.

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

If you already run other containers with `network_mode: host`, add this instead of
publishing a port:

```yaml
services:
  tubetv:
    build:
      context: /mnt/ssd1/tubetv/smarttubelite
    pull_policy: build
    container_name: tubetv
    restart: unless-stopped
    network_mode: host
    environment:
      PORT: "8484"
      HOST: "0.0.0.0"
      YT_GL: "PT"
      TZ: "Atlantic/Azores"
    volumes:
      - /mnt/ssd1/tubetv/data:/app/data
```

Then `docker compose up -d --build tubetv`. Confirm the running build at
`http://<pi>:8484/healthz`.

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
- Only the first ~60 cards are rendered by the server; more arrive on demand through
  YouTube's continuation tokens. If YouTube has nothing new, the grid simply stops.
- No Shorts, no comments, no channel pages, no casting.
- Unofficial: uses InnerTube and a public OAuth client. Google can change either at any time.
- Only 1080p H.264. VIDAA's browser usually can't do VP9/AV1 or 4K.
- 1080p is H.264 *High* profile; many TV decoders only do *Main*. That is why the
  player steps down to 720p, which YouTube serves as Main profile (`avc1.4D401F`).
- Audio and video are separate DASH streams synced in the page; if they drift, pause/play once.
- Livestreams need `MediaSource` in the TV browser (hls.js). Old VIDAA builds without it
  cannot play them — `/diag` tells you which case you have.

## Diagnostics

If a video won't play on the TV, open `http://<host>:8484/diag` **on the TV**. It
reports the browser's user agent, `MediaSource`, codec support and fullscreen, then
runs six playback tests (direct mp4 → proxied mp4 → `/api/play` → YouTube video →
YouTube audio → video+audio pair, the same layout the player uses). Results are also
posted to the server log.

`http://<host>:8484/logs` shows the last 250 server log lines — every `/api/play`
and `/api/media` request, with the TV's user agent, HTTP status, range and size.

The player also logs quality tiers, autoplay blocks, decode errors, stalls and HLS
errors, so the first failure is visible in `/logs` without reproducing it.

Troubleshooting order, when the TV fails but a desktop browser works:

1. Run `/diag` **on the TV**. "1. direct mp4" failing means the TV browser or the
   network path is the problem, not this app.
2. "2. proxied mp4" failing while 1 passes means proxy/port/firewall trouble.
3. "4. youtube video" failing while 1–2 pass means codec/profile (try `h=720`, which
   the player does automatically).
4. No `media` lines in `/logs` at all while pressing play on the TV means the request
   never left the TV (DNS, IP, port, or the app is pointed at the wrong URL).
