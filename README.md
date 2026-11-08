# TubeTV (SmartTube-lite)

A tiny self-hosted YouTube front end for TVs that can't run SmartTube — specifically
Hisense/Toshiba **VIDAA**, Samsung Tizen, LG webOS, or any old browser.

It uses YouTube's official TV device-code sign-in, pulls your real home feed
(`FEwhat_to_watch`), subscriptions and watch history from InnerTube, and plays video
from YouTube's HLS manifests (VISIONOS player client, with `yt-dlp` as fallback). No
YouTube player code is loaded, so there are no ads to block.

## What you get

- Your actual recommendation feed (logged in), not a "trending" page
- The home feed hides **Shorts**, so the TV shows landscape videos instead of
  portrait tiles with no title
- Promoted/sponsored tiles (brand names, often with a leading bullet) are filtered
  out of every feed, so they cannot be opened as if they were normal videos
- Subscriptions and watch **history** feeds
- Search
- Endless scrolling: reaching the last row loads the next page automatically. The
  server hops past Shorts-only shelves, prefers the page-tail continuation over a
  single shelf's token (so home does not stop after its first shelf), and rebuilds a
  continuation token that has gone stale on a long-open TV session instead of ending
  the grid
- H.264/AAC by default; VP9 1440p/2160p when the TV supports it, so old browsers
  still get a compatible stream
- Videos go fullscreen and start **on their own**, muted first (no key needed), then
  the player turns sound on by itself where the browser allows it
- Bottom control bar with play/pause, a **Quality** menu listing the resolutions this
  video actually offers, **Comments** (read-only, scrolls for more), and
  **Suggested** videos for the current video
- YouTube-style suggestions: the **Suggested** button opens a scrollable list, and
  when playback ends an **Up next** end screen shows the first eight as a 4×2 grid.
  Arrow keys choose a card, OK plays it in place, and Back returns to the player.
  Suggestions are fetched from the web `/next` surface (the TV surface omits the
  related column) and cached for 10 minutes per video
- Quality menu with every resolution this video offers; adaptive ABR by default,
  and an explicit pick pins that level for the current video. The next video starts
  in Automatic again, so one 4K/1440p pick is not forced on everything afterwards
- Livestreams, played as HLS through a built-in relay (no native HLS required)
- Remote-friendly UI: big tiles, arrow-key spatial navigation
- Remembers where each video was left, resumes there on the next open (also via
  `/watch?id=…&t=<seconds>`), and paints YouTube's red watched bar under the tile on
  the grid. Within 30 s of the end the next open starts from the beginning
- **Channel browsing:** hold OK on a tile to open a small menu with **Go to channel**,
  or use the channel row under the player controls (avatar, name and subscriber
  count). Channel pages list that channel's videos with infinite scroll, the same as
  a normal TV feed
- Two-way watch-progress sync with the signed-in YouTube account: resume positions
  come from YouTube's history feed and playback updates YouTube's watchtime when
  possible. The further valid position wins, so watching a little more on a phone
  resumes there — but a video finished or restarted on the TV still starts from the
  top
- No ads, no tracking pixels, no YouTube player

## Remote controls

| Key | Grid / search | Player |
|---|---|---|
| ↑ ↓ | move between tiles / rows | show the control bar; hide it again |
| ← → | move between tiles and nav links | seek ∓10 s, accelerating while held (bar hidden) / move between buttons |
| OK / Enter | open the focused item; hold ~0.7 s for **Go to channel** | play/pause, or activate the focused button |
| Back / Backspace / Esc | previous page | close the end screen or panel, then the bar, then the grid |
| Play/Pause | — | play / pause |
| S | — | quality menu (same as the **Quality** button) |
| C | — | comments (same as the **Comments** button) |
| R | — | suggested videos (same as the **Suggested** button) |
| D | — | open `/diag` (works from any page) |
| F | — | toggle fullscreen |
| 0 | — | restart the video and forget its saved position |

## How playback starts

Choosing a tile does **not** load a new page. Every page carries the player as a
hidden overlay; the tile click opens it in place and the URL is updated with
`history.pushState`. That matters for two reasons:

- The OK press that chose the video is still a *live user gesture* when playback
  begins, so the browser lets the player turn the sound on and go fullscreen. A
  full page load throws that gesture away, which is why a separate watch page
  always ended up muted. (This is the same reason Jellyfin/Plex feel instant.)
- Nothing is re-fetched, so the grid, its scroll position and the focused tile
  survive. Back closes the overlay and restores all three.

`/watch?id=…` still works as a real page for bookmarks, reloads and deep links;
it uses the same player script.

## Channels

Holding OK on a tile for about 0.7 s opens a small menu with **Go to channel**,
**Play video** and **Cancel**; a normal short press still opens the video
immediately, so nothing gets slower. The menu only appears for tiles whose channel
id is known (the TV, search and related feeds all carry it). Back closes the menu
and puts focus back on the same tile.

A channel page (`/channel?id=UC…`) opens YouTube's **Videos** tab through the web
`browse` surface, because the TV surface does not expose the avatar or subscriber
count. The header shows the avatar, name, handle, subscriber count, video count and
a two-line description; below it are the channel's videos, loaded 30 at a time as
you reach the bottom. Avatars are proxied through `/api/img` for the same reason as
thumbnails — VIDAA's browser drops third-party images.

While a video is playing, a channel row sits under the control buttons with the
same avatar, channel name and subscriber count. It is fetched after the first frame
(so it never delays startup) and is cached for the rest of the session. OK on that
row saves the current position and opens the channel page; Back returns to the
player where it left off.

## Watch progress

The TV keeps a small map in `localStorage` (`tubetv.hist`) with the last position of
each video. Opening a tile again seeks there once metadata is ready and shows
“Resumed at 12:34”; the grid paints YouTube's red watched bar under the thumbnail.
A position in the first 30 s, or within 30 s of the end, is treated as “not started”,
so a finished video replays from the top. Press **0** while watching to restart and
clear the saved position, or open `/watch?id=…&t=300` to jump to a specific second.
The map is capped at the 200 most recent videos.

With a signed-in account the TV also syncs with YouTube:

- **Read.** The signed-in History feed marks partially watched videos with a resume
  overlay. The server turns those percentages into positions and inlines the map into
  each page (cached for 10 minutes, refreshed in the background). The player compares
  the local and YouTube positions and takes the **further** one, so continuing a
  video on a phone and coming back to the TV resumes where the phone stopped. A
  local record that means “start from the top” — the done marker, a position in the
  last 30 s, or a restart watched only briefly — is never overridden by an older
  YouTube position. The chosen position is written back to the local map so the grid
  bar agrees. A percentage-only entry is resolved against the real duration once HLS
  reports it, not against the first partial duration.
- **Write.** When the TV player response carries YouTube's `playbackTracking` URLs,
  the player sends the same watchtime beacons YouTube's own player uses: once after
  about 20 s, then every 30 s, and on pause, close and end. The URLs are fetched
  lazily on the first ping, so opening a tile and immediately leaving marks nothing.
  This is strictly best-effort; a failure never affects playback.
- Without an account both directions are disabled and only the local map is used.

`/diag/progress?debug=1` shows the cached YouTube map plus the overlay fields found in
the signed-in history feed; `/diag/track?id=<videoId>` checks that a video exposes the
watchtime URLs (`&write=1&t=60` actually sends one partial ping).

The player is cinema-style: video fills the screen and the title/control bars fade
out after a few seconds; any key brings them back. Up from the bottom row focuses the
timeline (Left/Right seek 10 s), Up again reaches **Back**, and Down walks back down.
The **Quality** sheet lists only the resolutions that video has and remembers your
pick; it opens instantly because `/api/play` already sends the list, so no second
resolve is needed. Picking a quality switches hls.js to that level immediately —
no re-resolve and no restart. **Automatic** clears the pin and hands quality back to
hls.js.
Clicking/tapping the picture also play-pauses.

VOD uses a single MSE pipeline: YouTube's HLS video playlists plus the matching
audio playlist are fed to hls.js, which presents one `<video>` element. The server
builds a master with **exactly one codec family**. A VP9-capable TV gets the
1440p/2160p VP9 renditions; every other browser gets H.264 360p–1080p. hls.js 0.14
uses a single MSE `SourceBuffer`, so mixing `avc1` and `vp09` in one master made an
ABR switch throw `bufferAppendingError`, flush the buffer and black-screen the TV.
Keeping one family means hls.js starts on the best level of that family and ABR moves
within it at fragment boundaries. If VP9 playback fails, the player reloads the H.264
master (≤1080p) at the same position before giving up on MSE. The old split
progressive path (a video element *and* a separate audio element, often with a 100 MB+
open-ended download) is only a fallback for videos with no HLS pair.

Multi-language videos list every auto-dub before the original in YouTube's master,
and none of those entries is marked `DEFAULT`. The server picks the one named
`… - original` (preferring AAC-LC over HE-AAC for the TV) instead of the first entry,
so a Hindi/Arabic dub cannot play over an English video. Livestreams get the same
treatment in the player: once hls.js publishes its audio tracks, it switches to the
original track if the stream carries dubs.

Livestreams use the same single element; the first resolve returns the `hls_variant`
master directly, so a live channel starts from one resolve instead of two (and hls.js
gets every level instead of one fixed variant). Live playback starts at 1080p and
releases to ABR after four seconds, so the first picture is already sharp. Live HLS
from YouTube tops out at **1080p**, even for channels that advertise 4K, because the
HLS formats YouTube exposes for those streams only carry AVC ≤1080p. The **Quality**
sheet works for livestreams too: it lists the levels from the live manifest and switches
between them immediately, with **Automatic** returning control to ABR. A live pick that
stalls is dropped back to automatic rather than freezing.

**4K is automatic.** YouTube publishes 1440p/2160p only as VP9, so the player asks
MediaSource whether it can decode `vp09`. If it can, `/api/play` builds a VP9-only
master and hls.js starts on 2160p; when the link cannot sustain it, ABR drops to 1440p
within the same codec (no buffer flush and no black screen) and climbs back later. If
the TV cannot decode VP9, the master is H.264-only and the Quality sheet stops at
1080p. A VP9 failure reloads the H.264 master at the same position instead of dropping
straight to the split path. A manual pick applies to the video you are watching; each
new video starts in Automatic, so an old pin cannot force a level the Pi cannot keep
up with on every later video.

The first tile starts prefetching as soon as the grid exists (not on window `load`,
which waits for every thumbnail), and a tile is prefetched 300 ms after the remote
stops on it. The prefetch shares the same in-flight resolve as the play request,
so OK does not pay for a second resolve. A play request cancels prefetches for *other*
tiles but never the one already resolving for the tile being opened, so a cold start
does not throw away a nearly-finished resolve. Resolves are serialized: only one
resolver (and one challenge solver) runs at a time. Before that, three concurrent
resolves on the Pi took the load average to 35 and made every one of them slower.
Chromium allows unmuted playback for the rest of the page after any key press
(`hasBeenActive`), which outlives the ~5 s `isActive` window, so playback starts
**unmuted** even when the resolve is slow. If sound is genuinely refused, it starts
muted (always allowed) and one OK press turns the sound on.

Grid thumbnails are proxied by the Pi (`/api/thumb`) instead of loading from
`i.ytimg.com`. VIDAA's browser proved unreliable at third-party images and blanked
the whole grid, and same-origin HTTP avoids YouTube's signed thumbnail URLs as well
as DNS/TLS surprises. The proxy caches JPEGs in memory and steps from `hq720` down
to `mqdefault` if a large one is unavailable.

If something pauses the stream on its own (the browser's autoplay policy, a stalled
fragment, a decoder reset) the player resumes it, the way a set-top box does. It
only stays paused when you paused it.

Resolved stream URLs are cached for a few hours, but googlevideo sometimes invalidates
one early (IP or session change). The proxy notices the resulting 403 and re-resolves once
before handing anything to the TV; the player does the same if a URL dies mid-playback,
resuming at the same position. A failed **audio** track is also non-fatal: it is
re-resolved once, then playback continues video-only at the chosen quality instead of
dropping the resolution for no reason.

If a TV cannot decode a stream it steps down automatically. The chosen tier is stored
in the browser; open `/watch?id=…&h=1080` to forget it and try again at 1080p. Your own
quality pick from the menu is remembered separately (`tubetv.h`); **Automatic** clears it.
Build `2026-11-02.5` also clears the old forced-split quality/tier once (marker
`tubetv.prefver=3`), so a TV that previously wedged starts adaptive once.

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

### Deploying from a laptop

`./deploy.sh` rsyncs the source to the Pi (never touching its `data/`, so sign-in
survives) and rebuilds the container:

```sh
./deploy.sh                    # eddie@192.168.1.69
./deploy.sh eddie@192.168.1.69 # explicit user
```

It finishes by polling `/healthz` and fails loudly if the build is not the expected
one. If SSH still asks for a password, pass the same user the host actually uses:
the Pi is `eddie@edberry5`, not `pi`/`joao`. Give the Pi a DHCP reservation in the
router: when its address changes, the TV's bookmark points at a dead host.

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

> **The `bin/` folder is ignored by Docker** (`.dockerignore`). In the container the
> image downloads its own `yt-dlp_linux_<arch>` to `/usr/local/bin/yt-dlp` and sets
> `YTDLP` to it, so whatever sits in `bin/` is never used there. `bin/` only matters
> when you run `./run.sh` (plain Node). At startup the server logs which binary it
> will use and its version to `/logs`:
>
> ```
> start yt-dlp /usr/local/bin/yt-dlp
> start yt-dlp version 2026.10.26
> ```
>
> If it says `NOT RUNNABLE: spawn ... ENOEXEC` (or `Exec format error`) under
> plain Node, you have the wrong architecture in `bin/yt-dlp`.

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
| `YT_DIRECT_HLS` | on | Resolve the HLS master through the VISIONOS player client (0.1–0.5 s). Set `0`/`false`/`off` to force yt-dlp |
| `YTDLP` | `bin/yt-dlp` | Path to yt-dlp binary; wins over every default (Docker sets `/usr/local/bin/yt-dlp`) |
| `YTDLP_JS_RUNTIME` | `none` | JS challenge solver used for HLS resolves. `none` is fastest and cannot hang; `quickjs`, `node`, or `quickjs:/path/to/qjs` also work. A comma list is allowed |
| `YTDLP_JS_FALLBACK` | `quickjs` | One extra resolve with this solver for the rare video with no HLS pair (Docker installs `qjs`). Set `none` to disable |
| `YTDLP_SPLIT_JS` | `quickjs` | Solver for the progressive split fallback, whose URLs can carry the `n` throttle parameter |
| `YTDLP_TIMEOUT_MS` | `45000` | Deadline for one yt-dlp resolve (clamped 5–180 s). A timeout is not retried |

## Performance

No transcoding happens anywhere — the resolvers only return stream URLs and the server
copies bytes — so CPU stays flat:

| Activity | Measured on an ARM Mac | Pi 5 (scaled) |
|---|---|---|
| Idle | ~0% | <1% of one core |
| Proxying 1080p | 2.6% of one core @ 3.3 Mbps | ~4–6% (up to ~12% for 8 Mbps) |
| Resolving a new video | 0.1–0.5 s (VISIONOS), no child process | same order |
| RAM | 100–135 MB | same |

Resolution is the one slow step, so it no longer uses yt-dlp for normal playback.
The current build (`2026-11-06.7`) asks YouTube's **VISIONOS player client** for the HLS master
directly: one InnerTube `player` request plus one master playlist fetch, measured at
**0.1–0.5 s** for a VOD and **~0.08–0.1 s** for a livestream even on the Pi. VISIONOS
only needs a visitor id (taken for free from the feed that is already loaded), not the
signed-in account, so a missing or rejected OAuth token does not affect playback. The
master is cached per video, so a prefetch and the following play request share it.

`yt-dlp` remains the fallback for anything VISIONOS will not serve. That path skips the
~1 MB watch page and YouTube's player JavaScript, because the HLS playlists this app
uses do not carry YouTube's `n` throttle parameter: the InnerTube visitor id from the
feed is reused as `--extractor-args "youtube:player_skip=webpage;visitor_data=..."`, so
yt-dlp asks the player API directly (measured 1.6–2 s per VOD/live resolve instead of
12–35 s on the Pi). If that shortcut fails for any reason (stale visitor, age gate,
consent, bot check) the same video is retried once with the full webpage extraction, so
it is an optimization only, never a new failure mode. Set `YT_DIRECT_HLS=0` to force the
yt-dlp path (useful if YouTube changes the VISIONOS surface). The previous Node/V8
solver needed >100 MB per solve; on a 4 GB Pi it could fall into swap and hang past the
resolve deadline, which is exactly what made VOD starts time out.
The server also prefers IPv4 for its own YouTube/InnerTube requests (matching
`yt-dlp --force-ipv4`), so a broken IPv6 route does not add a connect timeout to every
lookup.

If a video exposes no HLS video+audio pair, the server retries once with **QuickJS**
(`YTDLP_JS_FALLBACK=quickjs`) — a small single-threaded C runtime that writes the
challenge to a temp file and solves it in a few MB. The Docker image installs the
static `qjs` binary for that fallback. The progressive split fallback also asks for
QuickJS (`YTDLP_SPLIT_JS`), because those URLs are the ones that can need `n` solving.

On a Mac, plain `node ./run.sh` does not need a runtime for normal HLS playback. If you
want the fallbacks to work there too, put `qjs` on `PATH` or set
`YTDLP_JS_FALLBACK=quickjs:/path/to/qjs`. A missing solver is ignored by yt-dlp, so
nothing breaks without it.

Every resolve is serialized (one resolver at a time) and a play request cancels
prefetches for other videos but shares the one already running for the video being
opened. A timeout is final: the server does not fall through to a second
resolver, which previously doubled a failed start. The default deadline is 45 s
(`YTDLP_TIMEOUT_MS`); a timeout is logged with whether the whole process group was
killed. Leftover Node/QJS children were what kept the Pi load average high.

To see where the seconds go on the host, open `http://<host>:8484/diag/sys`. It reports
Node/platform/CPU/memory (including `/proc/meminfo` and swap), DNS lookup time for IPv4
and IPv6, an HTTPS probe, the yt-dlp binary, the JS runtime and timeout, and the
current resolve queue. Add `?resolve=<videoId>` to include one fresh cold resolve:

```
http://<host>:8484/diag/sys?resolve=aqz-KE-bpKQ
```

Add `&timeout=120000` to give a cold resolve more than the playback deadline (clamped
to 5–180 s). On failure the response includes `killed` and the tail of yt-dlp's
stderr, so a broken JS runtime is visible without SSH.

A slow `dns6` with a fast `dns4` is a broken IPv6 route (yt-dlp runs with
`--force-ipv4` for exactly that reason); a slow `resolve` with fast `dns4`/`http`
means yt-dlp itself is the bottleneck, not the network. Check `load`, `swapFreeMB`
and `memFreeMB` in the same response: a Pi that is swapping (or has other containers
competing for its 4 GB) can turn a 2 s resolve into 30 s no matter how the player is
configured. Reboot it and run `docker stats --no-stream` before blaming the app.

`http://<host>:8484/diag/fast?id=<videoId>` probes the VISIONOS path in isolation.
It returns the elapsed time and HLS host on success, or the exact error when YouTube
does not hand back an HLS manifest. This is the path normal playback uses, so its `ms`
figure is the real startup resolve time. Add `&fresh=1` to `/api/play` to bypass the
per-video cache.

`/logs` writes `direct <id> <levels>lv <ms>` for a VOD and `direct <id> live <ms>` for a
livestream when the VISIONOS path served the video. A `ytdlp <id> … fast` line means the
fallback ran instead; `web-fallback` means yt-dlp's webpage-less visitor path was
rejected and it repeated the full extraction. A run of `web-fallback` or `direct … ERR`
lines means the visitor id is being rejected, so startup will look like the old build
until a fresh id is cached (or `YT_DIRECT_HLS=0` is set).

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
- Comments are read-only (no posting or voting), and come from YouTube's web surface
  while the feeds use the TV one.
- No Shorts, no casting.
- Unofficial: uses InnerTube and a public OAuth client. Google can change either at any time.
- Automatic quality reaches **2160p** when the TV's `MediaSource` reports `vp09`
  support; otherwise it tops out at 1080p H.264. 1440p/2160p are VP9 only. If VP9
  playback fails, the player reloads the H.264 HLS master (≤1080p) at the same position.
- 1080p is H.264 *High* profile; many TV decoders only do *Main*. If the 1080p level
  fails, the watchdog steps down to 720p, which YouTube serves as Main profile
  (`avc1.4D401F`).
- **Live HLS is 1080p at most.** Even 4K live channels expose only AVC HLS ≤1080p to
  the resolver, so the Quality sheet cannot offer more than 1080p for a livestream.
- Audio and video are separate HLS streams muxed by hls.js into one `<video>`; the
  split element pair is only a fallback for videos with no HLS rendition.
- Livestreams need `MediaSource` in the TV browser (hls.js). Old VIDAA builds without it
  cannot play them — `/diag` tells you which case you have.

## Diagnostics

If a video won't play on the TV, open `http://<host>:8484/diag` **on the TV** (or press
**D** anywhere in the app). It
reports the browser's user agent, `MediaSource`, codec support and fullscreen, then
runs eight playback tests **one at a time** (TV chips often have a single video
decoder, so parallel tests lie):

| # | Test | What a failure means |
|---|---|---|
| 1 | direct mp4 with audio | TV browser or internet path |
| 2 | proxied mp4 | the media proxy, port or firewall |
| 3 | `/api/play` | yt-dlp / YouTube auth |
| 4 | YouTube video-only 1080p | High-profile or video-only decode |
| 5 | YouTube video-only 720p | Main-profile decode |
| 6 | YouTube muxed file | progressive-file decode |
| 7 | YouTube audio-only AAC | AAC decode |
| 8 | video+audio pair | the exact element layout the player uses |

Results are also posted to the server log line by line, so a hang still leaves a trace.

A very specific failure worth knowing: `TIMEOUT t=0.0 rs=4 ... paused=false` means the
browser downloaded the stream, read the metadata and *still* never advanced the clock.
That is a TV decoder refusing the stream without raising an error — the player's
watchdog detects exactly this and steps down to the next quality tier.

`http://<host>:8484/logs` shows the last 250 server log lines — every `/api/play`
and `/api/media` request, with the TV's user agent, HTTP status, range and size.
Every `yt-dlp` run is logged with its duration and solver
(`ytdlp <id> 2000ms ok js=none …`), so a slow start is easy to tell from a stall.
A timed-out run is one line (`ytdlp <id> ERR yt-dlp timed out (kill: group)`), and a
`play hls <id> … <n>lv+vp9` line shows how many levels the master really had.
`http://<host>:8484/diag/sys` measures the host side (DNS4/DNS6, HTTPS, binary,
memory/swap, resolve queue, and optionally one cold resolve).

The player also logs quality tiers, autoplay blocks, decode errors, stalls and HLS
errors, so the first failure is visible in `/logs` without reproducing it.

Troubleshooting order, when the TV fails but a desktop browser works:

1. Run `/diag` **on the TV**. "1. direct mp4" failing means the TV browser or the
   network path is the problem, not this app.
2. "2. proxied mp4" failing while 1 passes means proxy/port/firewall trouble.
3. "4. youtube video-only 1080p" failing while 1–2 pass means codec/profile. If test 5
   (720p, Main profile) passes, that is it — the player's cascade lands there and
   remembers it. If 5 fails too but 1–2 pass, it is video-only playback; run test 8
   (the pair) to confirm and send the results.
4. No `media` lines in `/logs` at all while pressing play on the TV means the request
   never left the TV (DNS, IP, port, or the app is pointed at the wrong URL).
