import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCAL_BIN = path.join(ROOT, 'bin', 'yt-dlp');

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
  const args = [
    '-j',
    '--no-warnings',
    '--no-playlist',
    '--no-progress',
    '--socket-timeout',
    '15',
    '-f',
    format,
    `https://www.youtube.com/watch?v=${id}`,
  ];
  const { stdout } = await execFileAsync(bin(), args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 45_000,
  });
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
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

  const heights = new Set();
  for (const f of ret.formats || []) {
    if (!f.height || !f.vcodec || !String(f.vcodec).startsWith('avc1')) continue;
    if (f.height <= 1080) heights.add(f.height);
  }
  // Keep the sheet short for a remote: normal resolutions only, unless the
  // video genuinely only has tiny formats.
  const list = [...heights];
  const normal = list.filter((h) => h >= 360);
  const data = {
    live: false,
    heights: (normal.length ? normal : list).sort((a, b) => b - a),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// HLS variant: YouTube also exposes H.264 HLS playlists with a matching audio
// playlist. Feeding both to hls.js gives one <video> element (MSE) instead of a
// separate video+audio pair, which is much kinder to TV media pipelines.
export async function resolveHls(id, { height = 720, fresh = false } = {}) {
  const maxH = Number(height) || 720;
  const key = `hls:${id}:${maxH}`;
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
    const data = { id, live: true, title: ret.title || '', height: 0 };
    cache.set(key, { at: Date.now(), data, ttl: 60_000 });
    return data;
  }
  if (ret.live_status === 'is_upcoming') {
    throw Object.assign(new Error('This stream has not started yet.'), { code: 'upcoming' });
  }

  const rf = ret.requested_formats || [];
  const isM3u8 = (f) => /m3u8/i.test(String(f.protocol || ''));
  const video = rf.find((f) => isM3u8(f) && f.vcodec && f.vcodec !== 'none');
  const audio = rf.find((f) => isM3u8(f) && (!f.vcodec || f.vcodec === 'none'));
  if (!video || !audio || !video.url || !audio.url) {
    throw new Error('No HLS video+audio pair for this video.');
  }

  const data = {
    id,
    live: false,
    title: ret.title || '',
    duration: ret.duration || 0,
    width: video.width || 0,
    height: video.height || 0,
    vcodec: video.vcodec || 'avc1.4D401F',
    acodec: audio.acodec || 'mp4a.40.2',
    tbr: video.tbr || 2000,
    videoPlaylist: video.url,
    audioPlaylist: audio.url,
  };
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
  };
  cache.set(key, { at: Date.now(), data });
  return data;
  });
}

function friendly(e) {
  const msg = String(e?.stderr || e?.message || e);
  if (/Sign in to confirm/i.test(msg)) {
    return 'YouTube is asking for a bot check. Try again in a minute, or sign in via /login.';
  }
  if (/Video unavailable|private video|removed/i.test(msg)) return 'This video is not available.';
  return msg.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
