import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { playerHls } from './innertube.js';

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

// --- one yt-dlp at a time -------------------------------------------------
//
// Every resolve is CPU-heavy (Python + Node solving YouTube's player
// challenge). Letting several run at once on a 4-core Pi took the load average
// to 35 and made every resolve slower, not faster: the chosen video waited
// behind focus prefetches, timers fired late, and orphaned JS runtimes kept the
// pipes open. Playback requests go to the front and cancel a running prefetch;
// a prefetch only runs when nothing else needs the CPU.
let activeJob = null;
const waiting = [];
let jobSeq = 0;

function cancelErr() {
  return Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
}

export function queueStats() {
  return {
    active: activeJob
      ? {
          id: activeJob.id,
          prefetch: activeJob.prefetch,
          ms: Date.now() - activeJob.startedAt,
        }
      : null,
    waiting: waiting.map((j) => ({ id: j.id, prefetch: j.prefetch })),
    max: 1,
  };
}

function pump() {
  if (activeJob || !waiting.length) return;
  const job = waiting.shift();
  activeJob = job;
  job.startedAt = Date.now();
  Promise.resolve()
    .then(() => job.run((cancel) => { job.cancel = cancel; }))
    .then(
      (v) => {
        if (activeJob === job) activeJob = null;
        job.resolve(v);
        pump();
      },
      (e) => {
        if (activeJob === job) activeJob = null;
        job.reject(e);
        pump();
      }
    );
}

function enqueue(run, { id = '', prefetch = false } = {}) {
  return new Promise((resolve, reject) => {
    const job = { run, resolve, reject, prefetch, id, seq: ++jobSeq, cancel: null, startedAt: 0 };
    if (!prefetch) {
      // A real playback request wins: drop queued prefetches and abort the one
      // that is running (its process group is killed inside runYtdlp).
      // Never cancel a prefetch for *this* video: the play request shares its
      // in-flight promise, so killing it would throw away a resolve that is
      // already most of the way done — the main reason a cold start still took
      // ~20 s even though the tile had been focused.
      for (let i = waiting.length - 1; i >= 0; i--) {
        if (waiting[i].prefetch && waiting[i].id !== id) {
          const [w] = waiting.splice(i, 1);
          w.reject(cancelErr());
        }
      }
      if (activeJob && activeJob.prefetch && activeJob.id !== id && activeJob.cancel) {
        activeJob.cancel();
      }
      let at = 0;
      while (at < waiting.length && !waiting[at].prefetch) at++;
      waiting.splice(at, 0, job);
    } else {
      waiting.push(job);
    }
    pump();
  });
}

// Run yt-dlp in its own process group so a timeout/cancel can kill the Python
// process *and* the JS challenge runtime it spawned. Killing only the parent
// left node holding the stdout pipe open, so a "45 s timeout" could take 130 s
// to return and left the Pi overloaded.
function defaultTimeout() {
  const n = Number(process.env.YTDLP_TIMEOUT_MS);
  if (!Number.isFinite(n) || n < 5_000) return 45_000;
  return Math.min(n, 180_000);
}

export function resolveTimeout() {
  return defaultTimeout();
}

export function jsRuntime() {
  return jsRuntimeSpec();
}

// Most of this app's yt-dlp runs select HLS playlists, and those URLs do not
// carry YouTube's `n` throttle parameter, so the JS challenge is pure overhead
// for them. `none` is the default: it is ~2x faster than any solver and cannot
// hang on a small Pi. Set YTDLP_JS_RUNTIME=quickjs (or node) only for the rare
// video that exposes no HLS pair, or for the split fallback.
function jsRuntimeSpec() {
  return process.env.YTDLP_JS_RUNTIME || 'none';
}

function runtimeArgs(spec = jsRuntimeSpec()) {
  const s = String(spec).trim();
  if (!s || s === 'none') return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((x) => ['--js-runtimes', x]);
}

function runtimeLabel(spec = jsRuntimeSpec()) {
  const s = String(spec).trim();
  if (!s || s === 'none') return 'none';
  return s.split(',')[0].split(':')[0] || 'none';
}

// The split/progressive fallback is the one path that can benefit from a real
// JS runtime: those URLs are the ones that carry YouTube's `n` throttle
// parameter. QuickJS is optional there and silently ignored when missing.
function splitJsRuntime() {
  return process.env.YTDLP_SPLIT_JS || 'quickjs';
}

function runYtdlp(args, { timeoutMs = defaultTimeout(), onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin(), args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    let timer = null;
    const finish = (e, val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (e) reject(e);
      else resolve(val);
    };
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return 'group';
      } catch (e) {
        try {
          child.kill('SIGKILL');
          return 'parent';
        } catch (e2) {
          return 'failed';
        }
      }
    };
    const cancel = () => {
      if (done) return;
      kill();
      finish(cancelErr());
    };
    timer = setTimeout(() => {
      const killed = kill();
      finish(
        Object.assign(new Error('yt-dlp timed out'), {
          timeout: true,
          stderr: err,
          killed,
        })
      );
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < 64 * 1024 * 1024) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 64 * 1024) err += d;
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code, signal) => {
      if (code === 0) finish(null, { stdout: out, stderr: err });
      else {
        finish(
          Object.assign(new Error(`yt-dlp exited ${code ?? signal}`), {
            stderr: err,
            code,
            signal,
          })
        );
      }
    });
    if (onSpawn) onSpawn(cancel);
  });
}

// A missing/unusable JS runtime prints a yt-dlp error that names it. Never
// decide that from the command line: it contains "--js-runtimes ...", so a
// plain timeout used to look like a runtime failure and paid for a second run.
function runtimeBroken(stderr) {
  return /jsc|js[ -]runtime|quickjs|qjs|permission|ENOENT|EACCES|not (?:found|installed)|spawn .*(?:node|qjs)/i.test(
    String(stderr || '')
  );
}

async function info(
  id,
  format,
  { prefetch = false, timeoutMs = defaultTimeout(), js = jsRuntimeSpec() } = {}
) {
  // yt-dlp 2025+ can solve YouTube's player challenge in an external JS runtime.
  // The HLS selector does not need it, so the default is no runtime at all.
  // When a solver is configured but unusable (missing binary), retry once with
  // Node before giving up.
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

  const run = async (onSpawn) => {
    const t0 = Date.now();
    const rt = runtimeLabel(js);
    let res;
    try {
      res = await runYtdlp([...runtimeArgs(js), ...base], { timeoutMs, onSpawn });
    } catch (e) {
      // A timeout or a cancel is final: never pay for a second full resolve.
      if (e.code === 'CANCELLED' || e.timeout || e.signal || e.killed) throw e;
      const stderr = String(e.stderr || '');
      if (rt === 'none' || /node/i.test(js) || !runtimeBroken(stderr)) throw e;
      logger(
        'ytdlp',
        id,
        `${rt} runtime unusable; retrying with node`,
        stderr.replace(/\s+/g, ' ').slice(-500)
      );
      res = await runYtdlp([...runtimeArgs('node'), ...base], { timeoutMs, onSpawn });
    }
    const line = res.stdout.trim().split('\n').filter(Boolean).pop();
    const ret = JSON.parse(line);
    logger('ytdlp', id, `${Date.now() - t0}ms`, 'ok', `js=${rt}`, format.slice(0, 40));
    return ret;
  };

  try {
    return await enqueue(run, { id, prefetch });
  } catch (e) {
    if (e.code !== 'CANCELLED') {
      logger('ytdlp', id, 'ERR', friendly(e).slice(0, 200));
    }
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
      ret = await info(id, f, { prefetch: true, js: 'none' });
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

// Parse YouTube's hls_variant master. It has one #EXT-X-MEDIA audio rendition
// (sometimes more) and #EXT-X-STREAM-INF per resolution. Returning the same
// {formats} shape as yt-dlp lets the existing variant builder below handle
// de-duplication and codec grouping.
function hlsAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function parseHlsMaster(text, base) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const audios = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = hlsAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (String(a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) {
        audios.push({
          uri: new URL(a.URI, base).toString(),
          def: a.DEFAULT === 'YES',
          codec: String(a.CODECS || '').split(',').map((x) => x.trim()).find((x) => /^mp4a/i.test(x)) || 'mp4a.40.2',
        });
      }
      continue;
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = hlsAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    let uri = '';
    for (let k = i + 1; k < lines.length; k++) {
      if (!lines[k].startsWith('#')) { uri = lines[k]; break; }
    }
    if (!uri) continue;
    const codecs = String(a.CODECS || '').split(',').map((x) => x.trim());
    const vc = codecs.find((c) => /^(avc1|hvc1|hev1|vp0?9|av01)/i.test(c)) || '';
    const kind = /^avc1/i.test(vc) ? 'avc' : /^(vp09|vp9)/i.test(vc) ? 'vp9' : '';
    const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
    const height = res ? Number(res[2]) : 0;
    if (!kind || !height) continue;
    variants.push({
      url: new URL(uri, base).toString(),
      protocol: 'm3u8_native',
      vcodec: vc,
      acodec: 'none',
      width: res ? Number(res[1]) : 0,
      height,
      tbr: Math.round((Number(a.BANDWIDTH) || 0) / 1000) || 2000,
    });
  }
  const audio = audios.find((a) => a.def) || audios[0] || null;
  return {
    variants,
    audio: audio ? { url: audio.uri, protocol: 'm3u8_native', vcodec: 'none', acodec: audio.codec } : null,
  };
}

async function directHlsRet(id) {
  const info = await playerHls(id);
  if (info.live) {
    return { title: info.title, is_live: true, manifest_url: info.hls };
  }
  const r = await fetch(info.hls, {
    headers: {
      'user-agent': 'Mozilla/5.0 (PS4; Leanback Shell) Cobalt/26.lts.0-qa; compatible;',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('master HTTP ' + r.status);
  const text = await r.text();
  const parsed = parseHlsMaster(text, info.hls);
  if (!parsed.variants.length || !parsed.audio) {
    throw new Error('master has no HLS video+audio pair');
  }
  return {
    title: info.title,
    duration: info.duration,
    formats: [...parsed.variants, parsed.audio],
  };
}

// HLS variants: YouTube also exposes H.264 and VP9 HLS playlists with a
// matching audio playlist. Feeding them to hls.js gives one <video> element
// (MSE) instead of a separate video+audio pair, which is much kinder to TV
// media pipelines.
//
// Every H.264 rendition up to 1080p is returned, not just the requested
// height, so the server can build a real multi-level master playlist and hls.js
// can start at the best level and step down with ABR. Pinning one variant was
// why a TV whose Wi-Fi could not sustain 1080p stalled every couple of seconds.
//
// 1440p/2160p exist on YouTube only as VP9. They are collected too, but the
// server puts exactly one codec family in a master (see /api/hls/master).
export async function resolveHls(
  id,
  { height = 720, fresh = false, prefetch = false, vp9 = false, timeoutMs } = {}
) {
  const maxH = Number(height) || 720;
  // Height is only a preference now (which level the quality sheet calls
  // current), so prefetch and play with different h share the same extraction.
  const key = `hls:${id}`;
  const hit = fresh ? null : cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || TTL)) return hit.data;

  const attempt = async (js, direct = false) => {
  let ret = null;
  let lastErr = null;
  if (direct) {
    ret = await directHlsRet(id);
  } else {
    const selectors = [
      `bv*[protocol^=m3u8][vcodec^=avc1][height<=${maxH}]+ba[protocol^=m3u8]`,
      'bv*[protocol^=m3u8][vcodec^=avc1]+ba[protocol^=m3u8]',
    ];
    for (const sel of selectors) {
      try {
        ret = await info(id, sel, { prefetch, timeoutMs, js });
        break;
      } catch (e) {
        lastErr = e;
        // A timeout or a cancelled prefetch must not buy a second 25 s attempt.
        if (e.timeout || e.code === 'CANCELLED') break;
      }
    }
  }
  if (!ret) {
    if (lastErr && (lastErr.timeout || lastErr.code === 'CANCELLED')) throw lastErr;
    throw Object.assign(new Error('No HLS stream for this video.'), {
      detail: lastErr ? friendly(lastErr) : '',
    });
  }

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

  // One rendition per height and codec family. The 60 fps and 30 fps variants
  // of the same height both exist; keep the richer one and let ABR deal with
  // bitrate. H.264 tops out at 1080p; VP9 is only interesting above that.
  const byKey = new Map();
  for (const f of ret.formats || []) {
    if (!isM3u8(f) || !f.url) continue;
    const vc = String(f.vcodec || '');
    const kind = vc.startsWith('avc1') ? 'avc' : /^(vp09|vp9)/.test(vc) ? 'vp9' : '';
    if (!kind) continue;
    const hh = Number(f.height) || 0;
    // 240p is only offered for tiny players; floor at 360 so the quality sheet
    // lists real choices and ABR never lands on a postage stamp.
    if (hh < 360) continue;
    if (kind === 'avc' && hh > 1080) continue;
    if (kind === 'vp9' && hh <= 1080) continue;
    if (hh > 2160) continue;
    const k = `${kind}:${hh}`;
    const prev = byKey.get(k);
    if (!prev || (Number(f.tbr) || 0) > (Number(prev.tbr) || 0)) byKey.set(k, f);
  }
  const variants = [...byKey.values()]
    .sort(
      (a, b) =>
        a.height - b.height ||
        (String(a.vcodec).startsWith('avc1') ? -1 : 1)
    )
    .map((f) => ({
      height: f.height,
      width: f.width || 0,
      codec: String(f.vcodec).startsWith('avc1') ? 'avc' : 'vp9',
      vcodec: f.vcodec || 'avc1.4D401F',
      tbr: f.tbr || 2000,
      playlist: f.url,
    }));
  if (!variants.length || !audio || !audio.url) {
    throw new Error('No HLS video+audio pair for this video.');
  }

  const avc = variants.filter((v) => v.codec === 'avc');
  const wanted = (v) => v.height <= maxH;
  const sel = avc.slice().reverse().find(wanted) || avc[0] || variants[0];
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
    heights: [...new Set(variants.map((v) => v.height))].sort((a, b) => b - a),
  };
  rememberQualities(id, data.heights);
  cache.set(key, { at: Date.now(), data });
  return data;
  };

  // The signed-in TV player gives us the HLS master in one request; yt-dlp is
  // the fallback. Keep the fast path strictly optional: any failure (signed
  // out, bot check, no HLS manifest) drops through to the proven extractor.
  return once(key, async () => {
    try {
      const data = await attempt(null, true);
      logger('ytdlp', id, 'direct hls ok', data.live ? 'live' : `${(data.variants || []).length}lv`);
      return data;
    } catch (e) {
      if (e.code === 'CANCELLED') throw e;
      logger('ytdlp', id, 'direct ERR', friendly(e).slice(0, 160));
    }

    // No-JS extraction is the fast path, but rare videos expose no HLS pair
    // without a real JS runtime. Retry those once with QuickJS (if installed).
    // A timeout or a cancel is final, and never add a second resolve for errors
    // that a second attempt cannot fix.
    try {
      return await attempt(jsRuntimeSpec());
    } catch (e) {
      if (e.timeout || e.code === 'CANCELLED' || e.code === 'upcoming') throw e;
      // "Requested format is not available" means this video has no HLS
      // rendition at all (post-live uploads, for example). A JS solver cannot
      // invent one, so skip the retry and let the server use the split path.
      if (/Requested format is not available/i.test(String(e.detail || ''))) throw e;
      // Only retry when the failure is actually "no HLS pair": a bot check, a
      // private video or a network error will not be fixed by a solver.
      if (!/No HLS (?:video\+audio pair|stream)|no playlist URL/i.test(String(e.message || ''))) throw e;
      const fb = String(process.env.YTDLP_JS_FALLBACK ?? 'quickjs').trim();
      if (!fb || fb === 'none' || runtimeLabel(fb) === runtimeLabel(jsRuntimeSpec())) throw e;
      logger('ytdlp', id, `no HLS without JS; retrying with ${runtimeLabel(fb)}`);
      return attempt(fb);
    }
  });
}

export async function resolve(
  id,
  { muxed = false, height = 1080, fresh = false, prefetch = false } = {}
) {
  const maxH = muxed ? 0 : Number(height) || 1080;
  const key = `${id}:${muxed ? 'm' : 's' + maxH}`;
  const hit = fresh ? null : cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || TTL)) return hit.data;

  return once(key, async () => {
  let ret;
  try {
    ret = await info(id, muxed ? MUXED_FORMAT : splitFormat(maxH), {
      prefetch,
      js: splitJsRuntime(),
    });
  } catch (e) {
    if (e.timeout || e.code === 'CANCELLED') throw e;
    // Retry once with a different strategy: a muxed (progressive) file may not
    // exist for every video, and a split file may fail for age/bot reasons.
    const alt = muxed ? splitFormat(720) : MUXED_FORMAT;
    ret = await info(id, alt, { prefetch, js: splitJsRuntime() }).catch(() => {
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
  if (e?.timeout) {
    const tail = String(e.stderr || '').replace(/\s+/g, ' ').trim().slice(-140);
    return `yt-dlp timed out (kill: ${e.killed || 'none'})${tail ? ' ' + tail : ''}`.slice(0, 300);
  }
  if (/Sign in to confirm/i.test(msg)) {
    // yt-dlp extracts anonymously: the TV login feeds the YouTube TV API, not
    // yt-dlp, so signing in again would not clear this. It is YouTube throttling
    // stream lookups from this IP and normally clears within a minute.
    return 'YouTube is throttling stream lookups (bot check) for this IP. Wait a minute and try again.';
  }
  if (/Video unavailable|private video|removed/i.test(msg)) return 'This video is not available.';
  return msg.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}
