import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCAL_BIN = path.join(ROOT, 'bin', 'yt-dlp');

let logger = () => {};
export function setLogger(fn) {
  if (typeof fn === 'function') logger = fn;
}

function bin() {
  if (process.env.YTDLP) return process.env.YTDLP;
  if (fs.existsSync(LOCAL_BIN)) return LOCAL_BIN;
  return 'yt-dlp';
}

// Which yt-dlp would actually run, and whether it's usable. Logged at startup
// so a wrong-architecture binary is obvious in /logs.
export function binary() {
  return bin();
}

export async function version() {
  try {
    const { stdout } = await execFileAsync(bin(), ['--version'], { timeout: 20000 });
    return stdout.trim();
  } catch (e) {
    return 'NOT RUNNABLE: ' + friendly(e).slice(0, 160);
  }
}

// Prefer H.264 + AAC-LC because TV browsers (and VIDAA's old Chromium) often
// cannot decode VP9/AV1, HE-AAC, or mux separate DASH tracks reliably.
function splitFormat(maxHeight) {
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  return (
    `bv*[vcodec^=avc1][ext=mp4]${h}+ba[acodec^=mp4a.40.2][ext=m4a]` +
    `/bv*[vcodec^=avc1][ext=mp4]${h}+ba[acodec^=mp4a][ext=m4a]` +
    `/bv*[vcodec^=avc1][ext=mp4]${h}+ba[ext=m4a]` +
    `/bv*[vcodec^=avc1]${h}+ba` +
    `/b[ext=mp4][vcodec^=avc1]${h}/b[ext=mp4]/b`
  );
}

const MUXED_FORMAT =
  'b[ext=mp4][vcodec^=avc1][height<=720]/b[ext=mp4][vcodec^=avc1]' +
  '/b[ext=mp4]/b/18';

const cache = new Map();
const TTL = 3 * 60 * 60 * 1000;

// Focus prefetch and the real play request arrive within a second of each other.
// Share the in-flight yt-dlp run instead of spawning two (each can take 12 s on
// the TV's Pi).
const inflight = new Map();

function once(key, fn) {
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = Promise.resolve().then(fn);
  inflight.set(key, p);
  const done = () => {
    if (inflight.get(key) === p) inflight.delete(key);
  };
  p.then(done, done);
  return p;
}

async function info(id, format) {
  // yt-dlp 2025+ solves YouTube's player challenge in a JS runtime. Without one
  // it falls back to a deprecated, very slow pure-Python path: 1.9 s on a Mac,
  // 10-28 s on a Pi 5. The container already ships Node, so opt in. If node is
  // missing yt-dlp warns and falls back by itself.
  const runtime = ['--js-runtimes', 'node'];
  const base = [
    '-j',
    '--no-warnings',
    '--no-playlist',
    '--no-progress',
    // Home networks often advertise IPv6 without a working route. Python's
    // socket stack (unlike a browser) tries addresses one at a time, so a dead
    // AAAA record costs a full socket timeout per request.
    '--force-ipv4',
    '--socket-timeout',
    '10',
    '--retries',
    '1',
    '-f',
    format,
    `https://www.youtube.com/watch?v=${id}`,
  ];
  const attempt = async (extra) => {
    const { stdout } = await execFileAsync(bin(), [...extra, ...base], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 45_000,
    });
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(line);
  };

  const t0 = Date.now();
  try {
    let ret;
    try {
      ret = await attempt(runtime);
    } catch (e) {
      // An unusable JS runtime (old Node without --permission, no exec, a
      // sandbox refusing it) must not take playback down with it: retry the
      // same extraction on yt-dlp's built-in fallback path.
      const detail = String((e && (e.stderr || e.message)) || '');
      if (!/node|jsc|js runtime|permission|spawn|ENOENT|EACCES/i.test(detail)) throw e;
      logger('ytdlp', id, 'node runtime failed, retrying without it', detail.slice(0, 120));
      ret = await attempt([]);
    }
    logger('ytdlp', id, `${Date.now() - t0}ms`, 'ok', format.slice(0, 40));
    return ret;
  } catch (e) {
    logger('ytdlp', id, `${Date.now() - t0}ms`, 'ERR', friendly(e).slice(0, 120));
    throw e;
  }
}

function pick(ret) {
  const rf = ret.requested_formats || [];
  let video = null;
  let audio = null;

  for (const f of rf) {
    if (!f.url) continue;
    if (f.vcodec && f.vcodec !== 'none' && !video) video = f;
    if ((!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && !audio) audio = f;
  }
  if (!video && ret.url) {
    // Single progressive file (muxed video+audio).
    return {
      video: ret.url,
      audio: null,
      height: ret.height || 0,
      vcodec: ret.vcodec || '',
      acodec: ret.acodec || '',
    };
  }
  if (video) {
    return {
      video: video.url,
      audio: audio?.url || null,
      height: video.height || 0,
      vcodec: video.vcodec || '',
      acodec: audio?.acodec || '',
    };
  }
  return null;
}

// Resolutions offered by one extraction, for the quality sheet. With hlsOnly
// we keep only the m3u8 renditions, i.e. exactly the ones the MSE path can
// switch between; otherwise we use the progressive/DASH ones.
function normalHeights(list) {
  const uniq = [...new Set(list.filter((h) => h > 0))];
  const normal = uniq.filter((h) => h >= 360);
  return (normal.length ? normal : uniq).sort((a, b) => b - a);
}

function heightsOf(ret, hlsOnly = false) {
  const out = [];
  for (const f of ret.formats || []) {
    if (!f.height || !f.vcodec || !String(f.vcodec).startsWith('avc1')) continue;
    if (f.height > 1080) continue;
    if (hlsOnly && !/m3u8/i.test(String(f.protocol || ''))) continue;
    out.push(f.height);
  }
  return normalHeights(out);
}

// A play response already knows the resolutions, so the cogwheel must not spawn
// another yt-dlp run (which takes seconds on the TV's Pi).
function rememberQualities(id, heights) {
  if (!heights || !heights.length) return;
  cache.set(`q:${id}`, { at: Date.now(), data: { live: false, heights } });
}

// Which resolutions this video actually offers in H.264, for the quality menu.
export async function qualities(id) {
  const key = `q:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  let ret = null;
  for (const f of [splitFormat(1080), MUXED_FORMAT, 'b']) {
    try {
      ret = await info(id, f);
      break;
    } catch {}
  }
  if (!ret) throw new Error('Could not list formats for this video.');

  if (ret.is_live || ret.live_status === 'is_live') {
    const data = { live: true, heights: [] };
    cache.set(key, { at: Date.now(), data, ttl: 60_000 });
    return data;
  }

  // Keep the sheet short for a remote: normal resolutions only, unless the
  // video genuinely only has tiny formats.
  const data = { live: false, heights: heightsOf(ret) };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// HLS variants: YouTube also exposes H.264 HLS playlists with a matching audio
// playlist. Feeding them to hls.js gives one <video> element (MSE) instead of a
// separate video+audio pair, which is much kinder to TV media pipelines.
//
// Every H.264 rendition is returned, not just the requested height, so the
// server can build a real multi-level master playlist and hls.js can start low
// (fast) and step up/own with ABR. Pinning one variant was why a TV whose Wi-Fi
// could not sustain 1080p stalled every couple of seconds.
export async function resolveHls(id, { height = 720, fresh = false } = {}) {
  const maxH = Number(height) || 720;
  // Height is only a preference now (which level the quality sheet calls
  // current), so prefetch and play with different h share the same extraction.
  const key = `hls:${id}`;
  const hit = fresh ? null : cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || TTL)) return hit.data;

  return once(key, async () => {
  const selectors = [
    `bv*[protocol^=m3u8][vcodec^=avc1][height<=${maxH}]+ba[protocol^=m3u8]`,
    'bv*[protocol^=m3u8][vcodec^=avc1]+ba[protocol^=m3u8]',
  ];
  let ret = null;
  for (const sel of selectors) {
    try {
      ret = await info(id, sel);
      break;
    } catch {}
  }
  if (!ret) throw new Error('No HLS stream for this video.');

  if (ret.is_live || ret.live_status === 'is_live') {
    const rf = ret.requested_formats || [];
    const first = rf[0] || {};
    // manifest_url is the hls_variant master playlist (every resolution).
    // Returning it here means the server does not need a second yt-dlp run
    // just to discover the stream is live — that double resolve is what made
    // livestreams slow to start — and hls.js gets all levels, not one variant.
    const hls = first.manifest_url || ret.manifest_url || first.url || ret.url;
    if (!hls) throw new Error('Live stream has no playlist URL.');
    const data = { id, live: true, hls, title: ret.title || '', height: 0 };
    cache.set(key, { at: Date.now(), data, ttl: 60_000 });
    return data;
  }
  if (ret.live_status === 'is_upcoming') {
    throw Object.assign(new Error('This stream has not started yet.'), { code: 'upcoming' });
  }

  const isM3u8 = (f) => /m3u8/i.test(String(f.protocol || ''));
  const audio = (ret.requested_formats || []).find(
    (f) => isM3u8(f) && (!f.vcodec || f.vcodec === 'none')
  ) || (ret.formats || []).find(
    (f) => isM3u8(f) && !f.vcodec &&
      /^mp4a/i.test(String(f.acodec || ''))
  );

  // One H.264 HLS rendition per height. The 60 fps and 30 fps variants of the
  // same height both exist; keep the richer one and let ABR deal with bitrate.
  const byHeight = new Map();
  for (const f of ret.formats || []) {
    if (!isM3u8(f) || !f.url) continue;
    if (!f.vcodec || !String(f.vcodec).startsWith('avc1')) continue;
    const hh = Number(f.height) || 0;
    // 240p is only offered for tiny players; floor at 360 so the quality sheet
    // lists real choices and ABR never lands on a postage stamp.
    if (hh < 360 || hh > 1080) continue;
    const prev = byHeight.get(hh);
    if (!prev || (Number(f.tbr) || 0) > (Number(prev.tbr) || 0)) byHeight.set(hh, f);
  }
  const variants = [...byHeight.values()]
    .sort((a, b) => a.height - b.height)
    .map((f) => ({
      height: f.height,
      width: f.width || 0,
      vcodec: f.vcodec || 'avc1.4D401F',
      tbr: f.tbr || 2000,
      playlist: f.url,
    }));
  if (!variants.length || !audio || !audio.url) {
    throw new Error('No HLS video+audio pair for this video.');
  }

  const wanted = (v) => v.height <= maxH;
  const sel = variants.slice().reverse().find(wanted) || variants[0];
  const data = {
    id,
    live: false,
    title: ret.title || '',
    duration: ret.duration || 0,
    width: sel.width || 0,
    height: sel.height || 0,
    vcodec: sel.vcodec || 'avc1.4D401F',
    acodec: audio.acodec || 'mp4a.40.2',
    tbr: sel.tbr || 2000,
    variants,
    audioPlaylist: audio.url,
    // Kept for older callers / the diagnostic pair.
    videoPlaylist: sel.playlist,
    heights: variants.map((v) => v.height).sort((a, b) => b - a),
  };
  rememberQualities(id, data.heights);
  cache.set(key, { at: Date.now(), data });
  return data;
  });
}

export async function resolve(id, { muxed = false, height = 1080, fresh = false } = {}) {
  const maxH = muxed ? 0 : Number(height) || 1080;
  const key = `${id}:${muxed ? 'm' : 's' + maxH}`;
  const hit = fresh ? null : cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || TTL)) return hit.data;

  return once(key, async () => {
  let ret;
  try {
    ret = await info(id, muxed ? MUXED_FORMAT : splitFormat(maxH));
  } catch (e) {
    // Retry once with a different strategy: a muxed (progressive) file may not
    // exist for every video, and a split file may fail for age/bot reasons.
    const alt = muxed ? splitFormat(720) : MUXED_FORMAT;
    ret = await info(id, alt).catch(() => {
      throw Object.assign(new Error(friendly(e)), { detail: friendly(e) });
    });
  }

  if (ret.is_live || ret.live_status === 'is_live') {
    // Live comes down as HLS. Hand back the master playlist; the page plays it
    // with hls.js over MediaSource (Chromium has no native HLS).
    const rf = ret.requested_formats || [];
    const first = rf[0] || {};
    const hls = first.manifest_url || first.url || ret.manifest_url || ret.url;
    if (!hls) throw new Error('Live stream has no playlist URL.');
    const data = { id, live: true, hls, title: ret.title || '', height: 0, audio: null };
    cache.set(key, { at: Date.now(), data, ttl: 60_000 });
    return data;
  }
  if (ret.live_status === 'is_upcoming') {
    throw Object.assign(new Error('This stream has not started yet.'), { code: 'upcoming' });
  }

  const streams = pick(ret);
  if (!streams) throw new Error('No playable stream found for this video.');

  const data = {
    id,
    title: ret.title || '',
    duration: ret.duration || 0,
    channel: ret.channel || ret.uploader || '',
    video: streams.video,
    audio: streams.audio,
    height: streams.height,
    vcodec: streams.vcodec,
    acodec: streams.acodec,
    heights: heightsOf(ret),
  };
  rememberQualities(id, data.heights);
  cache.set(key, { at: Date.now(), data });
  return data;
  });
}

function friendly(e) {
  const msg = String(e?.stderr || e?.message || e);
  if (/Sign in to confirm/i.test(msg)) {
    // yt-dlp extracts anonymously: the TV login feeds the YouTube TV API, not
    // yt-dlp, so signing in again would not clear this. It is YouTube throttling
    // stream lookups from this IP and normally clears within a minute.
    return 'YouTube is throttling stream lookups (bot check) for this IP. Wait a minute and try again.';
  }
  if (/Video unavailable|private video|removed/i.test(msg)) return 'This video is not available.';
  return msg.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
