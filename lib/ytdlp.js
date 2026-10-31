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

// Prefer H.264 + AAC because TV browsers (and VIDAA's old Chromium) often
// cannot decode VP9/AV1 and cannot mux separate DASH tracks reliably.
const SPLIT_FORMAT =
  'bv*[vcodec^=avc1][ext=mp4][height<=1080]+ba[acodec^=mp4a][ext=m4a]' +
  '/bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]' +
  '/b[ext=mp4][vcodec^=avc1]/b[ext=mp4]/b';

const MUXED_FORMAT =
  'b[ext=mp4][vcodec^=avc1][height<=720]/b[ext=mp4][vcodec^=avc1]' +
  '/b[ext=mp4]/b/18';

const cache = new Map();
const TTL = 3 * 60 * 60 * 1000;

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
    return { video: ret.url, audio: null, height: ret.height || 0 };
  }
  if (video) return { video: video.url, audio: audio?.url || null, height: video.height || 0 };
  return null;
}

export async function resolve(id, { muxed = false } = {}) {
  const key = `${id}:${muxed ? 'm' : 's'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  let ret;
  try {
    ret = await info(id, muxed ? MUXED_FORMAT : SPLIT_FORMAT);
  } catch (e) {
    // Retry with the safest possible stream before giving up.
    ret = await info(id, MUXED_FORMAT).catch(() => {
      throw new Error(friendly(e));
    });
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
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

function friendly(e) {
  const msg = String(e?.stderr || e?.message || e);
  if (/Sign in to confirm/i.test(msg)) {
    return 'YouTube is asking for a bot check. Try again in a minute, or sign in via /login.';
  }
  if (/Video unavailable|private video|removed/i.test(msg)) return 'This video is not available.';
  return msg.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
