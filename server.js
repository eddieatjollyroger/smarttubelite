import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { setDefaultResultOrder } from 'node:dns';
import { Readable } from 'node:stream';

// yt-dlp runs with --force-ipv4 because home networks often advertise IPv6
// without a working route. Node's fetch would otherwise try AAAA first for
// every YouTube/InnerTube request (including the direct player fast path) and
// wait for the connect timeout before falling back.
setDefaultResultOrder('ipv4first');

import * as auth from './lib/auth.js';
import * as yt from './lib/innertube.js';
import {
  resolve as resolveStream,
  resolveHls as resolveHlsStream,
  qualities as resolveQualities,
  binary as ytdlpBinary,
  version as ytdlpVersion,
  queueStats as ytdlpQueue,
  resolveTimeout as ytdlpTimeout,
  jsRuntime as ytdlpJsRuntime,
  setLogger as setYtdlpLogger,
} from './lib/ytdlp.js';
import { page, grid, card, channelHead, comment, esc, playerMarkup } from './lib/ui.js';

const PORT = Number(process.env.PORT || 8484);
const HOST = process.env.HOST || '0.0.0.0';
// Bumped by hand when behaviour changes, so /healthz shows what's deployed.
const BUILD = '2026-11-11.3';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Resolved googlevideo URLs are IP-locked and expire. Keep them server-side and
// hand the browser short opaque paths instead.
const tokens = new Map();
// HLS/MSI player sessions: video+audio playlist URLs plus the metadata needed to
// build a master playlist with one <video> element on the client.
const hlsTokens = new Map();

// Thumbnails are served from this Pi instead of i.ytimg.com. VIDAA's browser
// proved unreliable at fetching third-party images (and blanks them all when
// its image cache is under pressure), while same-origin HTTP always works.
const thumbCache = new Map();
const imgCache = new Map();
// Video id -> channel identity. Used by the long-press menu when the feed
// surface did not carry a channel id (the signed-in TV home feed, mostly).
const chanOfCache = new Map();

// Small in-memory ring buffer so the TV's behaviour can be inspected from a
// Mac (`/logs`) or with `docker compose logs`, without SSHing around.
const LOG = [];
function log(...parts) {
  const line =
    new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + parts.join(' ');
  LOG.push(line);
  if (LOG.length > 400) LOG.shift();
  console.log(line);
}
setYtdlpLogger(log);

function ua(req) {
  return String(req.headers['user-agent'] || '?').slice(0, 90);
}

function makeHlsToken(info) {
  const t = crypto.randomBytes(12).toString('hex');
  hlsTokens.set(t, { ...info, at: Date.now() });
  const timer = setTimeout(() => hlsTokens.delete(t), 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return t;
}

function makeToken({ video, audio, id = '', height = 0, muxed = false }) {
  const t = crypto.randomBytes(12).toString('hex');
  tokens.set(t, { video, audio, id, height, muxed, at: Date.now() });
  const timer = setTimeout(() => tokens.delete(t), 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return t;
}

// Watchtime sessions. The URLs themselves are fetched lazily by /api/track on
// the first progress ping, so opening a video never pays for them.
const trackTokens = new Map();

function cpn() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] & 63];
  return out;
}

function makeTrackToken(id) {
  if (!yt.signedIn()) return '';
  const t = crypto.randomBytes(12).toString('hex');
  trackTokens.set(t, { id, cpn: cpn(), sent: 0, fails: 0, at: Date.now(), busy: false });
  const timer = setTimeout(() => trackTokens.delete(t), 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return t;
}

function progressFor(id) {
  const rec = yt.progressCached()[id];
  if (!rec) return null;
  return { p: rec.p || 0, t: rec.t || 0, d: rec.d || 0 };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

function errorPage(res, err, status = 500) {
  html(
    res,
    status,
    page({
      title: 'Error',
      active: '',
      signedIn: yt.signedIn(),
      body: `<div class="err">${esc(err.message || err)}</div>
             <p class="hint"><a class="btn" href="/">Back to home</a></p>`,
    })
  );
}

async function proxyMedia(req, res, url, hostOk = /(^|\.)googlevideo\.com$/, retry) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return json(res, 400, { error: 'bad url' });
  }
  if (!hostOk.test(target.hostname)) {
    return json(res, 403, { error: 'host not allowed' });
  }

  const headers = {
    'user-agent': UA,
    referer: 'https://www.youtube.com/',
  };
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];

  async function fetchUp(raw) {
    const ac = new AbortController();
    const abort = setTimeout(() => ac.abort(), 20_000);
    try {
      const up = await fetch(raw, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        signal: ac.signal,
      });
      clearTimeout(abort);
      return up;
    } finally {
      clearTimeout(abort);
    }
  }

  let upstream;
  try {
    upstream = await fetchUp(url);
  } catch (e) {
    log('media ERR', target.hostname, e.name || e.message, ua(req));
    return json(res, 502, { error: 'upstream fetch failed: ' + e.message });
  }

  // googlevideo URLs are IP-locked and can go stale inside our cache window.
  // Re-resolve once rather than handing the TV a dead stream (which looks like
  // a codec failure and makes the player step the quality down for no reason).
  if (retry && (upstream.status === 403 || upstream.status === 404 || upstream.status === 410)) {
    try {
      await upstream.body?.cancel();
    } catch {}
    let next = null;
    try {
      next = await retry();
    } catch (e) {
      log('media retry ERR', String(e.message || e).slice(0, 100), ua(req));
    }
    if (!next) return json(res, 502, { error: 'stream unavailable' });
    try {
      target = new URL(next);
      if (!hostOk.test(target.hostname)) throw new Error('host not allowed');
      upstream = await fetchUp(next);
      log('media refreshed', upstream.status, target.hostname, ua(req));
    } catch (e) {
      log('media retry ERR', String(e.message || e).slice(0, 100), ua(req));
      return json(res, 502, { error: 'upstream retry failed' });
    }
  }

  log(
    'media',
    upstream.status,
    req.headers.range || '-',
    upstream.headers.get('content-length') || '-',
    ua(req)
  );

  const out = {
    'content-type': upstream.headers.get('content-type') || 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  for (const k of ['content-length', 'content-range']) {
    const v = upstream.headers.get(k);
    if (v) out[k] = v;
  }

  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD' || !upstream.body) return res.end();

  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  res.on('close', () => {
    try {
      stream.destroy();
    } catch {}
  });
  stream.pipe(res);
}

// --- HLS relay for livestreams -------------------------------------------
// The TV can't fetch googlevideo directly (IP-locked, and Chromium has no HLS),
// so playlists and segments are relayed and every URI is rewritten to stay here.
function b64u(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function wrapHls(uri, base) {
  let abs;
  try {
    abs = new URL(uri, base).toString();
  } catch {
    return uri;
  }
  return '/api/hls?u=' + b64u(abs);
}

async function proxyHls(req, res, rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return json(res, 400, { error: 'bad url' });
  }
  if (!/(^|\.)googlevideo\.com$/.test(u.hostname)) {
    return json(res, 403, { error: 'host not allowed' });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let up;
  try {
    up = await fetch(u, {
      headers: { 'user-agent': UA, referer: 'https://www.youtube.com/' },
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    log('hls ERR', u.pathname.slice(0, 60), e.name || e.message);
    return json(res, 502, { error: 'upstream fetch failed' });
  }
  clearTimeout(timer);

  if (!up.ok) {
    log('hls', up.status, u.pathname.slice(0, 60));
    return json(res, 502, { error: 'upstream ' + up.status });
  }

  const type = up.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8$/i.test(u.pathname);

  if (isPlaylist) {
    const text = await up.text();
    const body = text
      .split(/\r?\n/)
      .map((line) => {
        if (!line) return line;
        if (line.charAt(0) === '#') {
          return line.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="' + wrapHls(uri, u) + '"');
        }
        return wrapHls(line, u);
      })
      .join('\n');
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  const out = {
    'content-type': type || 'video/mp4',
    'cache-control': 'no-store',
  };
  const len = up.headers.get('content-length');
  if (len) out['content-length'] = len;
  res.writeHead(up.status, out);
  if (!up.body) return res.end();

  const stream = Readable.fromWeb(up.body);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  res.on('close', () => {
    try {
      stream.destroy();
    } catch {}
  });
  stream.pipe(res);
}

// Runs on the TV and reports what its browser can actually do. This is how we
// find out why playback fails without guessing.
const DIAG_JS = `
(function () {
  var out = document.getElementById('out');
  var box = document.getElementById('videos');
  var lines = [];
  function say(s) { lines.push(s); out.textContent = lines.join('\\n'); }
  function report() {
    try {
      fetch('/api/log', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'DIAG ' + lines.join(' | ').slice(0, 3000)
      });
    } catch (e) {}
  }

  var probe = document.createElement('video');
  function type(t) { try { return probe.canPlayType(t) || 'no'; } catch (e) { return 'err'; } }

  say('UA: ' + navigator.userAgent);
  say('screen: ' + screen.width + 'x' + screen.height + ' dpr=' + (window.devicePixelRatio || 1));
  say('MSE: ' + (typeof window.MediaSource !== 'undefined' || typeof window.WebKitMediaSource !== 'undefined'));
  say('h264 baseline/aac: ' + type('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'));
  say('h264 high: ' + type('video/mp4; codecs="avc1.640028"'));
  say('hevc: ' + type('video/mp4; codecs="hvc1.1.6.L93.B0"'));
  say('hls native: ' + type('application/vnd.apple.mpegurl'));
  say('fetch: ' + (typeof fetch) + '  Promise: ' + (typeof Promise) + '  URLSearchParams: ' + (typeof URLSearchParams));
  say('fullscreen: ' + !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen));
  say('');

  function test(label, url, done) {
    if (!url) {
      say(label + ': skipped (no stream)');
      report();
      if (done) done();
      return;
    }
    var t = document.createElement('video');
    var finished = false;
    var extra = '';
    t.muted = true;
    t.autoplay = true;
    t.setAttribute('playsinline', '');
    t.setAttribute('webkit-playsinline', '');
    t.preload = 'auto';
    t.style.width = '300px';
    t.style.background = '#000';
    t.style.margin = '6px';
    box.appendChild(t);

    function finish(msg) {
      if (finished) return;
      finished = true;
      say(label + ': ' + msg);
      report();
      // Release the decoder before the next test: TV chips often have only one.
      try {
        t.pause();
        t.removeAttribute('src');
        t.load();
        if (t.parentNode) t.parentNode.removeChild(t);
      } catch (e) {}
      if (done) done();
    }
    t.addEventListener('error', function () {
      var e = t.error;
      finish('FAIL code=' + (e ? e.code : '?') + '  rs=' + t.readyState + '  ns=' + t.networkState + '  ' + extra);
    });
    t.addEventListener('loadedmetadata', function () {
      extra += ' meta=' + t.videoWidth + 'x' + t.videoHeight + ' dur=' + (isFinite(t.duration) ? Math.round(t.duration) : t.duration);
    });
    t.addEventListener('timeupdate', function () {
      if (t.currentTime > 0.2) finish('OK t=' + t.currentTime.toFixed(1) + 's rs=' + t.readyState + extra);
    });

    t.src = url;
    function kick() {
      try {
        var p = t.play();
        if (!p || !p.then) { extra += ' play=undefined'; return; }
        p.then(function () { extra += ' play=ok'; }, function (err) {
          var name = (err && err.name) || '?';
          // AbortError = the attempt was cancelled, usually by the browser
          // still setting up the element. One retry is enough.
          if (name === 'AbortError' && !t.dataset.retried) {
            t.dataset.retried = '1';
            setTimeout(kick, 400);
            return;
          }
          extra += ' play=' + name;
        });
      } catch (e) { extra += ' play-threw'; }
    }
    kick();

    setTimeout(function () {
      finish('TIMEOUT t=' + t.currentTime.toFixed(1) + ' rs=' + t.readyState +
        ' ns=' + t.networkState + ' paused=' + t.paused + extra);
    }, 10000);
  }

  // The real player uses a video-only element plus a separate audio element.
  // Test that exact combination: both must decode and advance together.
  function pair(j, done) {
    if (!j || !j.video) {
      say('8. video+audio pair: skipped');
      if (done) done();
      return;
    }
    var vv = document.createElement('video');
    var aa = document.createElement('audio');
    vv.muted = true;
    vv.autoplay = true;
    vv.setAttribute('playsinline', '');
    vv.preload = 'auto';
    vv.style.width = '300px';
    vv.style.background = '#000';
    vv.style.margin = '6px';
    box.appendChild(vv);
    aa.preload = 'auto';
    aa.muted = true; // autoplay policy, not a playback test
    vv.src = j.video;
    if (j.audio) aa.src = j.audio;
    try { vv.play(); } catch (e) {}
    if (j.audio) { try { aa.play(); } catch (e) {} }
    setTimeout(function () {
      say('8. video+audio pair: v=' + vv.currentTime.toFixed(1) + 's rs=' + vv.readyState +
          ' vpaused=' + vv.paused +
          ' verr=' + (vv.error ? vv.error.code : 0) +
          ' a=' + aa.currentTime.toFixed(1) + 's ars=' + aa.readyState +
          ' apaused=' + aa.paused +
          ' aerr=' + (aa.error ? aa.error.code : 0));
      try {
        vv.pause(); vv.removeAttribute('src'); vv.load();
        aa.pause(); aa.removeAttribute('src'); aa.load();
      } catch (e) {}
      report();
      if (done) done();
    }, 10000);
  }

  var DIRECT = 'https://download.samplelib.com/mp4/sample-5s.mp4';
  var PROXIED = '/api/probe?u=' + encodeURIComponent(DIRECT);
  var id = new URLSearchParams(location.search).get('id') || 'aqz-KE-bpKQ';

  // Tests run strictly one after another: TV chips usually have a single video
  // decoder, and playing several elements at once makes the results lie.
  function playInfo(q, label, next) {
    fetch('/api/play?id=' + id + q, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        say(label + ': ' + JSON.stringify(j).slice(0, 260));
        next(j);
      })
      .catch(function (e) { say(label + ' FAILED: ' + e); next(null); });
  }

  test('1. direct mp4 (video+audio)', DIRECT, function () {
    test('2. proxied mp4', PROXIED, function () {
      playInfo('', '3. /api/play 1080p', function (a) {
        test('4. youtube video-only 1080p', a && a.video, function () {
          playInfo('&h=720', '4b. /api/play 720p', function (b) {
            test('5. youtube video-only 720p', b && b.video, function () {
              playInfo('&muxed=1', '5b. /api/play muxed', function (c) {
                test('6. youtube muxed (video+audio in one file)', c && c.video, function () {
                  test('7. youtube audio-only', a && a.audio, function () {
                    pair(a, function () { say('done'); report(); });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
})();
`;

const LOGIN_JS = `
(function () {
  var codeEl = document.getElementById('code');
  var stat = document.getElementById('status');
  var newBtn = document.getElementById('newcode');
  var timer = null;

  function stop(msg) {
    stat.textContent = msg;
    if (timer) { clearInterval(timer); timer = null; }
    if (newBtn) newBtn.style.display = 'inline-block';
  }

  function poll() {
    fetch('/api/login/poll', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.status === 'ok') { location.href = '/'; return; }
        if (j.status === 'error') {
          stop(j.description || j.error || 'Sign-in failed. Try a new code.');
          return;
        }
        if (j.status === 'expired' || j.status === 'idle') {
          stop('Code expired. Get a new one.');
          return;
        }
        if (j.user_code) codeEl.textContent = j.user_code;
        stat.textContent = 'Waiting for you to approve on your phone…';
      })
      .catch(function () {});
  }

  function begin(j) {
    if (j.error) { stop(j.error); return; }
    codeEl.textContent = j.user_code;
    stat.textContent = 'Waiting for you to approve on your phone…';
    if (timer) clearInterval(timer);
    timer = setInterval(poll, Math.max(3, j.interval || 5) * 1000);
    poll();
  }

  // Reuse a code that is already waiting instead of minting a new one on
  // every page load (that is what silently broke the first attempt).
  fetch('/api/login/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      if (s.status === 'waiting') { begin(s); return; }
      return fetch('/api/login/start', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(begin);
    })
    .catch(function (e) { stop(String(e)); });
})();
`;

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/healthz') {
    return json(res, 200, { ok: true, signedIn: yt.signedIn(), build: BUILD });
  }

  // --- diagnostics -------------------------------------------------------
  if (path === '/api/log' && req.method === 'POST') {
    const body = (await readBody(req, 4096)).replace(/\s+/g, ' ').slice(0, 800);
    log('client', body, '|', ua(req));
    return json(res, 200, { ok: true });
  }

  if (path === '/logs') {
    const text = LOG.slice(-250).join('\n') || '(no log yet)';
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(text + '\n');
  }

  if (path === '/diag') {
    const body = `<h1>TV diagnostics</h1>
      <h2>Row switch test</h2>
      <p class="hint">Turn things off one at a time, then press Back and move up/down
      through the grid. Each move is timed and written to the log; open
      <code>/logs</code> afterwards.</p>
      <p><button class="btn" style="border:0;font:inherit;color:inherit;cursor:pointer" data-fx="sticky">Sticky header</button>
      <button class="btn" style="border:0;font:inherit;color:inherit;cursor:pointer" data-fx="scale">Card zoom</button>
      <a class="btn" href="/">Back to grid</a></p>
      <p class="hint" id="fxstate"></p>
      <script>
      (function () {
        var KEY = 'tubetv.rowfx';
        function load() {
          try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
        }
        function show() {
          var f = load();
          var s = ['sticky header: ' + (f.sticky === false ? 'OFF' : 'ON'),
                   'card zoom: ' + (f.scale === false ? 'OFF' : 'ON')];
          document.getElementById('fxstate').textContent = s.join(' · ');
          var b = document.querySelectorAll('[data-fx]');
          for (var i = 0; i < b.length; i++) {
            var k = b[i].getAttribute('data-fx');
            b[i].textContent = (k === 'sticky' ? 'Sticky header: ' : 'Card zoom: ') +
              (f[k] === false ? 'OFF' : 'ON');
          }
        }
        document.addEventListener('click', function (e) {
          var el = e.target;
          while (el && el !== document && !(el.getAttribute && el.getAttribute('data-fx'))) el = el.parentNode;
          if (!el || el === document || !el.getAttribute) return;
          var k = el.getAttribute('data-fx');
          var f = load();
          f[k] = f[k] === false ? true : false;
          try { localStorage.setItem(KEY, JSON.stringify(f)); } catch (e2) {}
          show();
        });
        show();
      })();
      </script>
      <h2>Playback test</h2>
      <p class="hint">Runs playback tests in this TV's browser. Takes about 40 seconds. When it finishes, open <code>/logs</code> to send me the results.</p>
      <pre id="out" class="diagout">starting…</pre>
      <div id="videos" class="diagvideos"></div>
      <script>${DIAG_JS}</script>`;
    return html(res, 200, page({ title: 'Diagnostics', body, signedIn: yt.signedIn() }));
  }

  // Server-side timing: where the seconds actually go. Open on the Pi itself
  // (or curl from the LAN) to tell DNS/IPv6 trouble from yt-dlp cost.
  //   /diag/sys
  //   /diag/sys?resolve=<videoId>   (also does one fresh yt-dlp resolve)
  if (path === '/diag/sys') {
    const timed = async (fn) => {
      const t = Date.now();
      try {
        const value = await fn();
        return { ms: Date.now() - t, ok: true, value };
      } catch (e) {
        return { ms: Date.now() - t, ok: false, error: String(e.message || e).slice(0, 160) };
      }
    };
    const mem = (() => {
      try {
        const t = fs.readFileSync('/proc/meminfo', 'utf8');
        const get = (k) => Number((t.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [])[1] || 0);
        return {
          totalMB: Math.round(get('MemTotal') / 1024),
          availMB: Math.round(get('MemAvailable') / 1024),
          swapTotalMB: Math.round(get('SwapTotal') / 1024),
          swapFreeMB: Math.round(get('SwapFree') / 1024),
        };
      } catch {
        return null;
      }
    })();
    const out = {
      build: BUILD,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpus: os.cpus().length,
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      memFreeMB: Math.round(os.freemem() / 1048576),
      mem,
      ytdlp: ytdlpBinary(),
      jsRuntime: ytdlpJsRuntime(),
      ytdlpTimeoutMs: ytdlpTimeout(),
      resolveQueue: ytdlpQueue(),
      dns4: await timed(() => dns.lookup('www.youtube.com', { family: 4 })),
      dns6: await timed(() => dns.lookup('www.youtube.com', { family: 6 })),
      http: await timed(async () => {
        const r = await fetch('https://www.youtube.com/generate_204', { redirect: 'manual' });
        return r.status;
      }),
    };
    const rid = url.searchParams.get('resolve') || '';
    if (/^[A-Za-z0-9_-]{11}$/.test(rid)) {
      // ?timeout=120000 lets a slow Pi finish a cold resolve instead of cutting
      // it at the normal playback deadline. Useful only for diagnosis.
      const asked = Number(url.searchParams.get('timeout')) || 0;
      const tmo = asked ? Math.min(180_000, Math.max(5_000, asked)) : undefined;
      const t = Date.now();
      try {
        const info = await resolveHlsStream(rid, { height: 720, fresh: true, timeoutMs: tmo });
        out.resolve = {
          ms: Date.now() - t,
          js: ytdlpJsRuntime(),
          live: !!info.live,
          heights: info.heights || [],
          levels: info.variants ? info.variants.length : 0,
          title: (info.title || '').slice(0, 60),
        };
      } catch (e) {
        out.resolve = {
          ms: Date.now() - t,
          js: ytdlpJsRuntime(),
          error: String(e.message || e).slice(0, 160),
          killed: e.killed,
          stderr: String(e.stderr || '').replace(/\s+/g, ' ').slice(-400),
        };
      }
    }
    return json(res, 200, out);
  }

  // --- direct player probe ------------------------------------------------
  // /diag/fast?id=<video> tests the default VISIONOS fast path (player JSON +
  // HLS master) without falling back to yt-dlp. This is the path normal playback
  // uses, so its ms figure is the real startup resolve time.
  if (path === '/diag/fast') {
    const rid = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(rid)) return json(res, 400, { error: 'bad video id' });
    const t = Date.now();
    try {
      const p = await yt.visionosHls(rid);
      return json(res, 200, {
        ok: true,
        ms: Date.now() - t,
        signedIn: yt.signedIn(),
        live: p.live,
        title: (p.title || '').slice(0, 80),
        duration: p.duration,
        hlsHost: (() => { try { return new URL(p.hls).host; } catch { return '?'; } })(),
      });
    } catch (e) {
      return json(res, 200, {
        ok: false,
        ms: Date.now() - t,
        signedIn: yt.signedIn(),
        error: String(e.message || e).slice(0, 200),
      });
    }
  }

  // --- progress sync diagnostics -----------------------------------------
  // /diag/progress shows the cached YouTube history map. `?debug=1` also dumps
  // the tile overlay keys, which is the only way to see the signed-in history
  // renderer shape from a Mac without SSH.
  if (path === '/diag/progress') {
    const force = url.searchParams.get('force') === '1';
    const debug = url.searchParams.get('debug') === '1';
    const out = {
      signedIn: yt.signedIn(),
      cached: Object.keys(yt.progressCached()).length,
      stats: yt.progressStats(),
    };
    try {
      out.map = await yt.progressMap({ force });
      out.n = Object.keys(out.map).length;
      if (debug) out.debug = await yt.historyDebug();
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 200, {
        ok: false,
        ...out,
        map: yt.progressCached(),
        error: String(e.message).slice(0, 200),
      });
    }
  }

  // /diag/track?id=<video> confirms that the signed-in player response carries
  // YouTube's watchtime URLs. `?write=1&t=60` actually sends one partial ping.
  if (path === '/diag/track') {
    const rid = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(rid)) return json(res, 400, { error: 'bad video id' });
    const t = Math.max(0, Number(url.searchParams.get('t')) || 60);
    try {
      const tr = await yt.fetchTracking(rid);
      if (!tr) return json(res, 200, { ok: false, signedIn: yt.signedIn(), error: 'no tracking URLs' });
      const out = {
        ok: true,
        signedIn: yt.signedIn(),
        length: tr.length,
        playback: !!tr.playback,
        watchtime: !!tr.watchtime,
      };
      if (url.searchParams.get('write') === '1') {
        out.results = await yt.sendWatchStats({
          playback: tr.playback,
          watchtime: tr.watchtime,
          cpn: cpn(),
          st: 0,
          et: t,
          cmt: t,
          first: true,
          full: false,
        });
      }
      return json(res, 200, out);
    } catch (e) {
      return json(res, 200, {
        ok: false,
        signedIn: yt.signedIn(),
        error: String(e.message).slice(0, 200),
      });
    }
  }

  // Test-only proxy so /diag can check whether the proxy path itself works.
  if (path === '/api/probe') {
    const u = url.searchParams.get('u') || '';
    const ok = /(^|\.)(samplelib\.com|test-videos\.co\.uk|googleapis\.com|w3schools\.com)$/i;
    return proxyMedia(req, res, u, ok);
  }

  // Grid thumbnails. Same-origin, so the TV never has to reach i.ytimg.com and
  // does not depend on YouTube's signed ?sqp= URLs staying valid.
  //
  // q=sd (640x480) is for the grid. A tile is ~455 CSS px wide, so hq720
  // (1280x720) was decoded at 3x the pixels needed; four of those entering the
  // viewport on a row switch is what made the TV drop frames while scrolling.
  // sddefault's 60 px letterbox bars are cropped away by object-fit: cover.
  // The player keeps hq720.
  if (path === '/api/thumb') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    const q = url.searchParams.get('q');
    const wanted = q === 'mqdefault' ? 'mqdefault' : q === 'sd' ? 'sddefault' : 'hq720';
    const key = id + '/' + wanted;
    const hit = thumbCache.get(key);
    if (hit) {
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=86400',
        'content-length': hit.length,
      });
      return res.end(hit);
    }
    // Shorts and some old uploads have no sddefault/hq720; step down rather
    // than 404, so the tile always shows something.
    const variants =
      wanted === 'sddefault'
        ? ['sddefault', 'hq720', 'mqdefault']
        : wanted === 'hq720'
          ? ['hq720', 'sddefault', 'mqdefault']
          : ['mqdefault'];
    for (const v of variants) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      try {
        const up = await fetch(`https://i.ytimg.com/vi/${id}/${v}.jpg`, {
          headers: { 'user-agent': UA },
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (!up.ok) continue;
        const buf = Buffer.from(await up.arrayBuffer());
        if (!buf.length) continue;
        if (thumbCache.size > 400) thumbCache.clear();
        thumbCache.set(key, buf);
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=86400',
          'content-length': buf.length,
        });
        return res.end(buf);
      } catch (e) {
        clearTimeout(timer);
      }
    }
    return json(res, 404, { error: 'no thumbnail' });
  }

  // hls.js, served locally so the TV doesn't need internet for the player.
  if (path === '/player.js') {
    try {
      const js = fs.readFileSync(new URL('./public/player.js', import.meta.url));
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': js.length,
      });
      return res.end(js);
    } catch (e) {
      return json(res, 404, { error: 'player.js missing' });
    }
  }

  if (path === '/hls.js') {
    try {
      const js = fs.readFileSync(new URL('./public/hls.min.js', import.meta.url));
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=86400',
        'content-length': js.length,
      });
      return res.end(js);
    } catch {
      return json(res, 404, { error: 'hls.js missing' });
    }
  }

  // Master playlist for VOD MSE playback: every H.264 HLS rendition plus one
  // audio group, so hls.js has one <video> element *and* real ABR. Starting on
  // the lowest level is what makes the first frame appear quickly on a TV whose
  // Wi-Fi cannot sustain 1080p; hls.js steps up when the link allows.
  if (path === '/api/hls/master') {
    const entry = hlsTokens.get(url.searchParams.get('tok') || '');
    if (!entry) return json(res, 410, { error: 'stream expired' });
    const wrap = (u) => `/api/hls?u=${b64u(u)}`;
    const all = entry.variants && entry.variants.length
      ? entry.variants
      : [{
          height: entry.height,
          width: entry.width,
          codec: 'avc',
          vcodec: entry.vcodec,
          tbr: entry.tbr,
          playlist: entry.videoPlaylist,
        }];
    // One codec family per master. hls.js 0.14 uses a single MSE SourceBuffer,
    // so an ABR switch from H.264 to VP9 throws bufferAppendingError, flushes
    // the buffer and black-screens the TV. VP9-capable players get a VP9-only
    // master (1440/2160), everyone else an H.264 master (≤1080); the player can
    // fall back from one to the other with a normal reload.
    const family = entry.codec || 'avc';
    let list = all.filter((v) => (v.codec || 'avc') === family);
    if (!list.length) list = all.filter((v) => (v.codec || 'avc') === 'avc');
    if (!list.length) list = all;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="${wrap(entry.audioPlaylist)}"`,
    ];
    for (const v of list) {
      const bw = Math.max(300000, Math.round((v.tbr || 2000) * 1000));
      const resTag = v.width && v.height ? `RESOLUTION=${v.width}x${v.height},` : '';
      const codecs = [v.vcodec || entry.vcodec, entry.acodec].filter(Boolean).join(',');
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bw},${resTag}CODECS="${codecs}",AUDIO="aud"`
      );
      lines.push(wrap(v.playlist));
    }
    lines.push('');
    const body = lines.join('\n');
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (path === '/api/hls') {
    return proxyHls(req, res, unb64u(url.searchParams.get('u') || ''));
  }

  if (path === '/manifest.webmanifest') {
    return json(res, 200, {
      name: 'TubeTV',
      short_name: 'TubeTV',
      start_url: '/',
      display: 'fullscreen',
      background_color: '#0b0b0c',
      theme_color: '#0b0b0c',
    });
  }

  // --- YouTube watch-progress sync ---------------------------------------
  // Read: the signed-in history feed's resume overlay, cached for a few
  // minutes. The grid gets the cached map inlined; this endpoint is for the
  // first page after a cold start and for the diagnostic.
  if (path === '/api/progress') {
    const force = url.searchParams.get('force') === '1';
    const debug = url.searchParams.get('debug') === '1';
    // The player only needs the current video, which is always on the first
    // history page. One page keeps a resume check cheap on the Pi.
    const pages = Math.min(2, Math.max(1, Number(url.searchParams.get('pages')) || 2));
    if (!yt.signedIn()) return json(res, 200, { ok: true, signedIn: false, map: {} });
    try {
      const map = await yt.progressMap({ force, pages });
      const out = {
        ok: true,
        signedIn: true,
        n: Object.keys(map).length,
        stats: yt.progressStats(),
        map,
      };
      if (debug) {
        try {
          out.debug = await yt.historyDebug();
        } catch (e) {
          out.debug = { error: String(e.message).slice(0, 160) };
        }
      }
      return json(res, 200, out);
    } catch (e) {
      log('progress ERR', String(e.message).slice(0, 140));
      return json(res, 200, {
        ok: false,
        signedIn: true,
        n: Object.keys(yt.progressCached()).length,
        stats: yt.progressStats(),
        map: yt.progressCached(),
        error: String(e.message).slice(0, 140),
      });
    }
  }

  // Write: a tiny beacon from the player. Tracking URLs are looked up on the
  // first ping, so a video that is closed immediately sends nothing to
  // YouTube. Failure is always best-effort and never blocks playback.
  if (path === '/api/track') {
    const tok = url.searchParams.get('tok') || '';
    const rec = trackTokens.get(tok);
    if (!rec) return json(res, 200, { ok: false, disabled: true });
    if (rec.busy) return json(res, 200, { ok: true, pending: true });

    const t = Math.max(0, Number(url.searchParams.get('t')) || 0);
    const done = url.searchParams.get('done') === '1';
    const d = Math.max(0, Number(url.searchParams.get('d')) || 0);
    if (!(t > 0) && !done) return json(res, 200, { ok: true, skip: true });

    rec.busy = true;
    try {
      const info = await yt.fetchTracking(rec.id);
      if (!info) {
        trackTokens.delete(tok);
        return json(res, 200, { ok: false, disabled: true, reason: 'no tracking' });
      }
      const len = Math.round(info.length || d || 0);
      const et = done ? Math.max(0, len - 1) : Math.min(Math.round(t), Math.max(0, len - 1));
      const first = rec.sent === 0;
      const results = await yt.sendWatchStats({
        playback: info.playback,
        watchtime: info.watchtime,
        cpn: rec.cpn,
        st: 0,
        et,
        cmt: et,
        first,
        full: done,
      });
      rec.sent++;
      const ok = results.some((r) => r.status >= 200 && r.status < 300);
      if (!ok) rec.fails++;
      if (rec.fails >= 3) trackTokens.delete(tok);
      if (first || done || !ok) {
        log(
          'track',
          rec.id,
          done ? 'done' : 'progress',
          `${et}s/${len}s`,
          results.map((r) => `${r.url || '?'}:${r.status || r.error || '?'}`).join(' '),
          ok ? '' : `fails=${rec.fails}`
        );
      }
      return json(res, 200, { ok, results, disabled: rec.fails >= 3 });
    } catch (e) {
      rec.fails++;
      if (rec.fails >= 3) trackTokens.delete(tok);
      log('track ERR', rec.id, String(e.message).slice(0, 140));
      return json(res, 200, { ok: false, error: String(e.message).slice(0, 140), disabled: rec.fails >= 3 });
    } finally {
      rec.busy = false;
    }
  }

  // --- media proxy -------------------------------------------------------
  const media = path.match(/^\/api\/media\/([a-f0-9]+)\/(video|audio)$/);
  if (media) {
    const entry = tokens.get(media[1]);
    if (!entry) return json(res, 410, { error: 'stream expired' });
    const kind = media[2];
    const target = entry[kind];
    if (!target) return json(res, 404, { error: 'no stream' });
    return proxyMedia(req, res, target, undefined, async () => {
      if (!entry.id) return null;
      log('media refresh', entry.id, kind, entry.muxed ? 'muxed' : 'h' + entry.height);
      const info = await resolveStream(entry.id, {
        muxed: !!entry.muxed,
        height: entry.height || 1080,
        fresh: true,
      });
      if (!info || info.live || !info.video) return null;
      entry.video = info.video;
      entry.audio = info.audio;
      entry.height = info.height;
      return entry[kind];
    });
  }

  // --- resolve a video ---------------------------------------------------
  if (path === '/api/play') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    const muxed = url.searchParams.get('muxed') === '1';
    const fresh = url.searchParams.get('fresh') === '1';
    const useHls = url.searchParams.get('hls') === '1';
    const prefetch = url.searchParams.get('prefetch') === '1';
    // The player probes MediaSource for VP9 and only asks for the 1440p/2160p
    // levels when the TV can decode them. H.264 still carries everything ≤1080.
    const vp9 = url.searchParams.get('vp9') === '1';
    const h = Math.min(1080, Math.max(360, Number(url.searchParams.get('h')) || 1080));

    // Preferred path for TV browsers: one <video> element via MSE, with hls.js
    // reading a video playlist and an audio playlist. No second media element
    // and no giant open-ended progressive download.
    if (useHls) {
      try {
        const info = await resolveHlsStream(id, { height: h, fresh, prefetch });
        if (info.live) {
          // The HLS probe already identified the stream as live and handed
          // back the hls_variant master. Returning it here skips the second
          // yt-dlp resolve that made livestreams slow to start.
          if (prefetch) return json(res, 200, { ok: true, mode: 'live' });
          log('play live hls', id, ua(req));
          return json(res, 200, {
            live: true,
            title: info.title,
            hls: `/api/hls?u=${b64u(info.hls)}`,
            height: 0,
            channel: info.channel || '',
            channelId: info.channelId || '',
          });
        }
        if (prefetch) return json(res, 200, { ok: true, mode: 'mse', height: info.height });
        // A VP9 television gets the 1440/2160 master; everything else stays on
        // H.264 ≤1080. Mixing both in one master is what broke ABR.
        const codec =
          vp9 && (info.variants || []).some((v) => v.codec === 'vp9') ? 'vp9' : 'avc';
        const levels = (info.variants || []).filter((v) => v.codec === codec);
        const tok = makeHlsToken({ ...info, codec });
        log(
          'play hls',
          id,
          `${info.height}p`,
          `${levels.length || 1}lv ${codec}`,
          info.vcodec,
          info.acodec,
          info.audioLang || info.audioName
            ? `${info.audioLang || '?'}:${info.audioName || '?'}`
            : '',
          ua(req)
        );
        return json(res, 200, {
          title: info.title,
          duration: info.duration,
          hls: `/api/hls/master?tok=${tok}`,
          height: info.height,
          width: info.width,
          vcodec: info.vcodec,
          acodec: info.acodec,
          audioLang: info.audioLang || '',
          audioName: info.audioName || '',
          heights: [...new Set(levels.map((v) => v.height))].sort((a, b) => b - a),
          mode: 'mse',
          channel: info.channel || '',
          channelId: info.channelId || '',
          resume: progressFor(id),
          track: makeTrackToken(id),
        });
      } catch (e) {
        // A playback request cancelled this prefetch on purpose. Do not log it
        // as an error and do not fall through to a second (split) resolve.
        if (e.code === 'CANCELLED') {
          return json(res, 200, { ok: true, cancelled: true, mode: 'mse' });
        }
        // A timed-out lookup is final. Falling through to the split resolver
        // spent another full timeout and was why one failed play could block
        // the Pi for over a minute.
        if (e.timeout) {
          log('play timeout', id, e.killed || '', ua(req));
          return json(res, 504, { error: 'Stream lookup timed out', timeout: true });
        }
        log('hls ERR', id, String(e.message).slice(0, 100), ua(req));
      }
    }

    try {
      const info = await resolveStream(id, { muxed, height: h, fresh, prefetch });
      if (info.live) {
        log('play live', id, ua(req));
        return json(res, 200, {
          live: true,
          title: info.title,
          hls: `/api/hls?u=${b64u(info.hls)}`,
          height: 0,
          channel: info.channel || '',
          channelId: info.channelId || '',
        });
      }
      if (prefetch) return json(res, 200, { ok: true, mode: 'split', height: info.height });
      const tok = makeToken({
        video: info.video,
        audio: info.audio,
        id,
        height: info.height,
        muxed,
      });
      log(
        'play ok',
        id,
        muxed ? 'muxed' : `h${h}`,
        `${info.height}p`,
        info.vcodec || '-',
        info.acodec || '',
        ua(req)
      );
      return json(res, 200, {
        title: info.title,
        duration: info.duration,
        video: `/api/media/${tok}/video`,
        audio: info.audio ? `/api/media/${tok}/audio` : null,
        height: info.height,
        vcodec: info.vcodec || null,
        acodec: info.acodec || null,
        heights: info.heights || [],
        mode: 'split',
        channel: info.channel || '',
        channelId: info.channelId || '',
        resume: progressFor(id),
        track: makeTrackToken(id),
      });
    } catch (e) {
      if (e.code === 'CANCELLED') {
        return json(res, 200, { ok: true, cancelled: true, mode: 'split' });
      }
      log('play ERR', id, e.code || '', String(e.message).slice(0, 120), ua(req));
      if (e.code === 'live') {
        return json(res, 422, {
          error: 'This is a livestream. Live playback needs HLS/MSE, which is not supported yet.',
          live: true,
        });
      }
      return json(res, 502, { error: e.message || String(e) });
    }
  }

  // --- quality list (cogwheel) -------------------------------------------
  if (path === '/api/qualities') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    try {
      return json(res, 200, await resolveQualities(id));
    } catch (e) {
      log('qualities ERR', id, String(e.message).slice(0, 120));
      return json(res, 502, { error: 'formats unavailable' });
    }
  }

  // --- suggested / related videos ---------------------------------------
  if (path === '/api/related') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    try {
      const videos = await yt.relatedPage(id);
      return json(res, 200, { videos });
    } catch (e) {
      log('related ERR', id, String(e.message).slice(0, 140));
      return json(res, 502, { error: 'suggestions unavailable', videos: [] });
    }
  }

  // --- channel of a video --------------------------------------------------
  // The signed-in TV home feed nests its channel link where the card renderer
  // cannot see it, so the long-press menu asks for the channel when OK goes
  // down. VISIONOS carries it in videoDetails; a full resolve is the fallback.
  if (path === '/api/channel-of') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    const hit = chanOfCache.get(id);
    if (hit && Date.now() - hit.at < 12 * 60 * 60 * 1000) return json(res, 200, hit.data);
    const rememberChannelOf = (data) => {
      chanOfCache.set(id, { at: Date.now(), data });
      // Bound the map on a device that runs for weeks.
      if (chanOfCache.size > 1000) {
        const oldest = chanOfCache.keys().next().value;
        if (oldest) chanOfCache.delete(oldest);
      }
      return json(res, 200, data);
    };
    try {
      const info = await yt.visionosHls(id);
      const data = { channelId: info.channelId || '', channel: info.author || '' };
      if (!data.channelId) throw new Error('no channel id');
      return rememberChannelOf(data);
    } catch (e) {
      try {
        const info = await resolveHlsStream(id, { height: 720, timeoutMs: 6000 });
        const data = { channelId: info.channelId || '', channel: info.channel || '' };
        if (!data.channelId) throw new Error('no channel id');
        return rememberChannelOf(data);
      } catch (e2) {
        log('channel-of ERR', id, String(e2.message || e.message || '').slice(0, 120));
        return json(res, 200, { channelId: '', channel: '' });
      }
    }
  }

  // --- channel metadata ---------------------------------------------------
  // The player asks for the avatar/subscriber line after the first frame.
  // `?info=1` skips the video list (the page-one cache still makes a later
  // channel visit free).
  if (path === '/api/channel') {
    const id = url.searchParams.get('id') || '';
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(id)) return json(res, 400, { error: 'bad channel id' });
    try {
      const p = await yt.channelPage(id);
      if (url.searchParams.get('info') === '1') return json(res, 200, { info: p.info });
      return json(res, 200, {
        info: p.info,
        videos: p.videos,
        token: p.token,
      });
    } catch (e) {
      log('channel ERR', id, String(e.message).slice(0, 140));
      return json(res, 502, { error: 'channel unavailable' });
    }
  }

  // --- channel avatars ----------------------------------------------------
  // VIDAA drops third-party images, so channel avatars are proxied same-origin
  // like thumbnails. Only Google's image hosts are accepted.
  if (path === '/api/img') {
    const raw = url.searchParams.get('u') || '';
    let u;
    try {
      u = new URL(raw);
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    if (
      u.protocol !== 'https:' ||
      !/^(yt3\.googleusercontent\.com|yt3\.ggpht\.com|i\.ytimg\.com|lh3\.googleusercontent\.com)$/.test(
        u.hostname
      )
    ) {
      return json(res, 400, { error: 'host not allowed' });
    }
    const key = u.href;
    const hit = imgCache.get(key);
    if (hit) {
      res.writeHead(200, {
        'content-type': hit.type,
        'cache-control': 'public, max-age=86400',
        'content-length': hit.length,
      });
      return res.end(hit.body);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const up = await fetch(key, {
        headers: { 'user-agent': UA },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!up.ok) return json(res, 404, { error: 'image unavailable' });
      const type = String(up.headers.get('content-type') || 'image/jpeg');
      if (!/^image\//i.test(type)) return json(res, 404, { error: 'not an image' });
      const body = Buffer.from(await up.arrayBuffer());
      if (!body.length) return json(res, 404, { error: 'empty image' });
      if (imgCache.size > 300) imgCache.clear();
      imgCache.set(key, { type, body, length: body.length });
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'public, max-age=86400',
        'content-length': body.length,
      });
      return res.end(body);
    } catch (e) {
      clearTimeout(timer);
      return json(res, 502, { error: 'image fetch failed' });
    }
  }

  // --- comments ----------------------------------------------------------
  if (path === '/api/comments') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    const token = url.searchParams.get('token') || '';
    try {
      const p = await yt.commentsPage(id, token);
      if (p.disabled) return json(res, 200, { html: '', token: null, n: 0, error: 'comments off' });
      return json(res, 200, {
        html: p.comments.map(comment).join(''),
        token: p.token,
        n: p.comments.length,
      });
    } catch (e) {
      log('comments ERR', id, String(e.message).slice(0, 140));
      return json(res, 502, { error: 'comments unavailable' });
    }
  }

  // --- continuation (infinite scroll) ------------------------------------
  if (path === '/api/more') {
    const kind = url.searchParams.get('kind') || 'home';
    let token = url.searchParams.get('token') || '';
    const refresh = url.searchParams.get('refresh') === '1';
    const channelId = url.searchParams.get('channel') || '';
    if (!token && !refresh) return json(res, 400, { error: 'missing token' });
    if (kind === 'channel' && !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
      return json(res, 400, { error: 'bad channel' });
    }

    const browseId = { home: 'FEwhat_to_watch', subs: 'FEsubscriptions', history: 'FEhistory' }[kind];
    if (!browseId && kind !== 'search' && kind !== 'channel') {
      return json(res, 400, { error: 'bad kind' });
    }
    if (refresh && kind === 'search') return json(res, 400, { error: 'cannot refresh search' });
    const fetchPage = (tok) =>
      kind === 'search'
        ? yt.searchPage(null, tok)
        : kind === 'channel'
          ? yt.channelPage(channelId, tok)
          : yt.browsePage(browseId, tok, { skipShorts: kind === 'home' });

    // A TV keeps the grid open for hours; YouTube's page-tail continuation
    // token eventually goes stale. Fetch a fresh first page and return the
    // page *after* it, so the viewer keeps scrolling instead of hitting a
    // dead end. Search needs its query, which continuation requests do not
    // carry, so only the browse feeds can recover this way.
    const freshNext = async () => {
      const first =
        kind === 'channel'
          ? await yt.channelPage(channelId)
          : await yt.browsePage(browseId, null, {
              skipShorts: kind === 'home',
            });
      if (!first.token) return null;
      const next = await fetchPage(first.token);
      log('more refresh', kind, `${next.videos.length}v`);
      return next;
    };

    if (refresh) {
      try {
        const next = await freshNext();
        return json(res, 200, {
          html: next ? next.videos.map(card).join('') : '',
          token: (next && next.token) || null,
          n: next ? next.videos.length : 0,
          refreshed: true,
        });
      } catch (e) {
        const msg = String(e.message || e);
        if (/401|authentication/i.test(msg)) return json(res, 401, { error: 'signin' });
        log('more refresh ERR', kind, msg.slice(0, 120));
        return json(res, 502, { error: 'feed unavailable' });
      }
    }

    let page = { videos: [], token: null };
    let hops = 0;
    try {
      // A continuation token can point at a shelf rather than the page tail, or
      // at a shelf that is entirely Shorts (which the home feed filters). Hop
      // forward until real videos appear, so a Shorts-only stretch does not
      // look like the end of the feed.
      for (let i = 0; i < 8; i++) {
        page = await fetchPage(token);
        hops++;
        token = page.token;
        if (page.videos.length || !token) break;
      }
      // A healthy page (videos plus a next token) is the normal infinite-scroll
      // case; logging every one of them buried real errors under history spam.
      if (hops > 1 || !page.videos.length || !token) {
        log('more', kind, `${page.videos.length}v`, token ? 'next' : 'end', `${hops}hop`);
      }
    } catch (e) {
      const msg = String(e.message || e);
      if (/401|authentication/i.test(msg)) return json(res, 401, { error: 'signin' });
      log('more ERR', kind, msg.slice(0, 120));
      if (kind !== 'search') {
        try {
          const next = await freshNext();
          if (next) {
            return json(res, 200, {
              html: next.videos.map(card).join(''),
              token: next.token || null,
              n: next.videos.length,
              refreshed: true,
            });
          }
        } catch (e2) {
          log('more refresh ERR', kind, String(e2.message || e2).slice(0, 100));
        }
      }
      return json(res, 502, { error: 'feed unavailable' });
    }

    return json(res, 200, {
      html: page.videos.map(card).join(''),
      token: page.token || null,
      n: page.videos.length,
    });
  }

  // --- auth --------------------------------------------------------------
  if (path === '/api/login/start' && req.method === 'POST') {
    try {
      return json(res, 200, await auth.startLogin({ force: url.searchParams.get('new') === '1' }));
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (path === '/api/login/state') {
    return json(res, 200, auth.loginState());
  }
  if (path === '/api/login/poll') {
    try {
      return json(res, 200, await auth.pollLogin());
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (path === '/api/logout' && req.method === 'POST') {
    auth.signOut();
    return json(res, 200, { ok: true });
  }

  // --- pages -------------------------------------------------------------
  if (path === '/login') {
    const signedIn = yt.signedIn();
    const state = auth.loginState();
    const code = state.status === 'waiting' ? state.user_code : '…';
    const statusText =
      state.status === 'waiting'
        ? 'Waiting for you to approve on your phone…'
        : 'Requesting a code…';
    const body = signedIn
      ? `<div class="login">
           <h1>Signed in</h1>
           <p>TubeTV is using your YouTube account (recommendations, subscriptions, history).</p>
           <p><a class="btn" href="/diag">Run TV diagnostics</a></p>
           <button class="btn" onclick="fetch('/api/logout',{method:'POST'}).then(function(){location.reload()})">Sign out</button>
         </div>`
      : `<div class="login">
           <h1>Sign in to YouTube</h1>
           <p>On your phone or computer, open
             <a class="link" href="https://www.google.com/device" target="_blank" rel="noreferrer">google.com/device</a>
             and enter this code:</p>
           <div class="code" id="code">${esc(code)}</div>
           <div class="status" id="status">${esc(statusText)}</div>
           <p class="hint">This uses YouTube's official TV sign-in. You can revoke it any time at
             myaccount.google.com → Security → Third-party connections.</p>
           <p class="hint"><button class="btn" id="newcode" style="display:none"
             onclick="fetch('/api/login/start?new=1',{method:'POST'}).then(function(){location.reload()})">New code</button></p>
         </div>
         <script>${LOGIN_JS}</script>`;
    return html(res, 200, page({ title: 'Sign in', body, active: '', signedIn }));
  }

  if (path === '/channel') {
    const id = url.searchParams.get('id') || '';
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(id)) {
      return errorPage(res, new Error('Bad channel id'), 400);
    }
    let p;
    try {
      p = await yt.channelPage(id);
    } catch (e) {
      log('channel page ERR', id, String(e.message).slice(0, 140));
      return errorPage(res, new Error('Could not load this channel.'), 502);
    }
    yt.warmProgress();
    const body = `${channelHead(p.info)}${grid(p.videos.slice(0, 60), {
      kind: 'channel',
      token: p.token,
      channel: id,
    })}`;
    return html(
      res,
      200,
      page({
        title: (p.info && p.info.title) || 'Channel',
        body,
        active: '',
        signedIn: yt.signedIn(),
        ytProgress: yt.progressCached(),
      })
    );
  }

  if (path === '/watch') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return errorPage(res, new Error('Bad video id'), 400);
    const body = `<div class="watch">${playerMarkup()}</div>`;
    return html(res, 200, page({ title: 'Watch', body, active: '', signedIn: yt.signedIn(), cinema: true, ytProgress: yt.progressCached() }));
  }

  if (path === '/comments') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return errorPage(res, new Error('Bad video id'), 400);
    let p = { comments: [], token: null };
    let msg = '';
    try {
      p = await yt.commentsPage(id);
    } catch (e) {
      msg = 'Could not load comments.';
      log('comments page ERR', id, String(e.message).slice(0, 120));
    }
    const body = `<h1>Comments</h1>
      <p class="hint"><a class="btn" href="/watch?id=${esc(id)}">← Back to video</a></p>
      ${msg ? `<div class="empty">${esc(msg)}</div>` : ''}
      ${p.disabled ? '<div class="empty">Comments are disabled for this video.</div>' : ''}
      <div class="cmtlist">${p.comments.map(comment).join('')}</div>`;
    return html(res, 200, page({ title: 'Comments', body, active: '', signedIn: yt.signedIn(), ytProgress: yt.progressCached() }));
  }

  if (path === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    let p = { videos: [], token: null };
    let failed = false;
    if (q) {
      try {
        p = await yt.searchPage(q);
      } catch (e) {
        failed = true;
        log('search ERR', q, String(e.message).slice(0, 100));
      }
    }
    const body = `<h1>${q ? `Results for “${esc(q)}”` : 'Search'}</h1>${
      failed
        ? '<div class="empty">Search failed. Try again in a moment.</div>'
        : grid(p.videos.slice(0, 60), { kind: 'search', token: p.token })
    }`;
    return html(res, 200, page({ title: q || 'Search', body, active: 'search', signedIn: yt.signedIn(), ytProgress: yt.progressCached() }));
  }

  if (path === '/subs') {
    let p = { videos: [], token: null };
    try {
      p = await yt.browsePage('FEsubscriptions');
    } catch (e) {
      log('subs ERR', String(e.message).slice(0, 100));
    }
    const body = `<h1>Subscriptions</h1>${
      p.videos.length
        ? grid(p.videos.slice(0, 60), { kind: 'subs', token: p.token })
        : '<div class="empty">Sign in to see your subscriptions.</div>'
    }`;
    return html(res, 200, page({ title: 'Subscriptions', body, active: 'subs', signedIn: yt.signedIn(), ytProgress: yt.progressCached() }));
  }

  if (path === '/history') {
    let p = { videos: [], token: null };
    let signedOut = false;
    try {
      p = await yt.historyPage();
    } catch (e) {
      signedOut = /401|authentication/i.test(String(e.message));
      if (!signedOut) log('history ERR', String(e.message).slice(0, 100));
    }
    // Keep the resume map fresh in the background; the page itself is not
    // delayed by it, and the video tiles below already contain their bars.
    yt.warmProgress();
    const body = `<h1>History</h1>${
      p.videos.length
        ? grid(p.videos.slice(0, 60), { kind: 'history', token: p.token })
        : signedOut || !yt.signedIn()
          ? '<div class="empty">Sign in to see your watch history.</div>'
          : '<div class="empty">No watch history yet.</div>'
    }`;
    return html(res, 200, page({ title: 'History', body, active: 'history', signedIn: yt.signedIn(), ytProgress: yt.progressCached() }));
  }

  if (path === '/') {
    const p = await yt.homePage();
    yt.warmProgress();
    const body = `<h1>Recommended</h1>${grid(p.videos.slice(0, 60), {
      kind: p.kind,
      token: p.token,
    })}`;
    return html(res, 200, page({ title: 'Home', body, active: 'home', signedIn: yt.signedIn(), ytProgress: yt.progressCached() }));
  }

  return errorPage(res, new Error('Not found'), 404);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) errorPage(res, e);
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  log('start', `build ${BUILD}`, `port ${PORT}`);
  log('start', `yt-dlp ${ytdlpBinary()}`);
  log('start', `yt-dlp js ${ytdlpJsRuntime()}`, `timeout ${ytdlpTimeout()}ms`);
  ytdlpVersion().then((v) => log('start', `yt-dlp version ${v}`));
  const nets = os.networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  console.log(`TubeTV running`);
  console.log(`  local:   http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  TV:      http://${ip}:${PORT}`);
  if (!lan.length) console.log('  (no LAN address found — check Wi-Fi)');
});
