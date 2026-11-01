import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import * as auth from './lib/auth.js';
import * as yt from './lib/innertube.js';
import { resolve as resolveStream } from './lib/ytdlp.js';
import { page, grid, card, esc } from './lib/ui.js';

const PORT = Number(process.env.PORT || 8484);
const HOST = process.env.HOST || '0.0.0.0';
// Bumped by hand when behaviour changes, so /healthz shows what's deployed.
const BUILD = '2026-11-01.1';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Resolved googlevideo URLs are IP-locked and expire. Keep them server-side and
// hand the browser short opaque paths instead.
const tokens = new Map();

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

function ua(req) {
  return String(req.headers['user-agent'] || '?').slice(0, 90);
}

function makeToken({ video, audio }) {
  const t = crypto.randomBytes(12).toString('hex');
  tokens.set(t, { video, audio, at: Date.now() });
  const timer = setTimeout(() => tokens.delete(t), 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return t;
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

async function proxyMedia(req, res, url, hostOk = /(^|\.)googlevideo\.com$/) {
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

  const ac = new AbortController();
  const abort = setTimeout(() => ac.abort(), 20_000);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(abort);
    log('media ERR', target.hostname, e.name || e.message, ua(req));
    return json(res, 502, { error: 'upstream fetch failed: ' + e.message });
  }
  clearTimeout(abort);

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
    try {
      var p = t.play();
      if (p && p.catch) p.catch(function () { extra += ' autoplay-blocked'; });
    } catch (e) { extra += ' play-threw'; }

    setTimeout(function () {
      finish('TIMEOUT t=' + t.currentTime.toFixed(1) + ' rs=' + t.readyState + ' ns=' + t.networkState + extra);
    }, 15000);
  }

  // The real player uses a video-only element plus a separate audio element.
  // Test that exact combination: both must decode and advance together.
  function pair(j) {
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
    vv.src = j.video;
    if (j.audio) aa.src = j.audio;
    try { vv.play(); } catch (e) {}
    if (j.audio) { try { aa.play(); } catch (e) {} }
    setTimeout(function () {
      say('6. video+audio pair: v=' + vv.currentTime.toFixed(1) + 's rs=' + vv.readyState +
          ' verr=' + (vv.error ? vv.error.code : 0) +
          ' a=' + aa.currentTime.toFixed(1) + 's ars=' + aa.readyState +
          ' aerr=' + (aa.error ? aa.error.code : 0));
      report();
    }, 12000);
  }

  var DIRECT = 'https://download.samplelib.com/mp4/sample-5s.mp4';
  var PROXIED = '/api/probe?u=' + encodeURIComponent(DIRECT);
  var id = new URLSearchParams(location.search).get('id') || 'aqz-KE-bpKQ';

  test('1. direct mp4', DIRECT, function () {
    test('2. proxied mp4', PROXIED, function () {
      fetch('/api/play?id=' + id)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          say('3. /api/play: ' + JSON.stringify(j).slice(0, 300));
          if (j.video) {
            test('4. youtube video', j.video, function () { say('done'); });
            if (j.audio) test('5. youtube audio', j.audio, function () { say('done'); });
            pair(j);
          } else {
            say('done (no stream resolved)');
            report();
          }
        })
        .catch(function (e) { say('3. /api/play FAILED: ' + e); report(); });
    });
  });
})();
`;

const PLAYER_JS = `
(function () {
  var params = new URLSearchParams(location.search);
  var id = params.get('id');
  var v = document.getElementById('v');
  var a = document.getElementById('a');
  var err = document.getElementById('err');
  var ttl = document.getElementById('title');
  var startBtn = document.getElementById('start');
  var hud = document.getElementById('hud');
  var ov = document.getElementById('ov');
  var clock = document.getElementById('clock');

  var tiers = [{ h: 1080 }, { h: 720 }, { h: 480 }, { muxed: 1 }];
  var tier = 0;
  var mutedFallback = false;
  var hideTimer = null;
  var started = false;
  var isLive = false;
  var hls = null;

  // Remember the highest tier this TV could actually decode, so it doesn't
  // re-discover the limit on every video. Opening /watch?id=...&h=1080 resets it.
  var forced = parseInt(params.get('h') || '', 10);
  try {
    if (forced) {
      localStorage.removeItem('tubetv.tier');
      for (var i = 0; i < tiers.length; i++) {
        if (tiers[i].h === forced) { tier = i; break; }
      }
    } else {
      var saved = parseInt(localStorage.getItem('tubetv.tier') || '', 10);
      if (saved > 0 && saved < tiers.length) tier = saved;
    }
  } catch (e) {}

  function report(kind, data) {
    try {
      fetch('/api/log', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'player ' + kind + ' id=' + id + ' ' + JSON.stringify(data || {})
      });
    } catch (e) {}
  }

  function errName(code) {
    return { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'source not supported' }[code] || 'unknown';
  }

  function showErr(msg) {
    err.textContent = msg;
    err.style.display = 'block';
    report('error', { msg: msg, tier: tier, rs: v.readyState, ns: v.networkState,
      code: v.error ? v.error.code : 0, acode: a.error ? a.error.code : 0 });
  }

  function hint(msg, sticky) {
    hud.textContent = msg;
    hud.className = 'hud';
    if (hideTimer) clearTimeout(hideTimer);
    if (!sticky) hideTimer = setTimeout(function () { hud.className = 'hud hide'; }, 5000);
  }

  function showChrome() {
    if (ov) ov.className = 'ov';
    hud.className = 'hud';
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (!v.paused) {
        if (ov) ov.className = 'ov hide';
        hud.className = 'hud hide';
      }
    }, 4000);
  }

  function fullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen ||
             el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!fn) return false;
    try {
      var p = fn.call(el);
      if (p && p.catch) p.catch(function () {});
      return true;
    } catch (e) { return false; }
  }

  // TV browsers normally require a user gesture before real fullscreen; the
  // first remote key press counts as one.
  var fsTried = false;
  function fullscreenOnce() {
    if (fsTried || document.fullscreenElement || document.webkitFullscreenElement) return;
    fsTried = true;
    fullscreen();
  }

  function tryPlay() {
    var p;
    try { p = v.play(); } catch (e) { p = null; }
    if (!p || !p.then) { startBtn.style.display = 'none'; return; }
    p.then(function () {
      startBtn.style.display = 'none';
    }).catch(function () {
      if (mutedFallback) { startBtn.style.display = 'inline-block'; return; }
      // Sound autoplay blocked. Prove playback muted, then let one OK unmute.
      mutedFallback = true;
      v.muted = true;
      if (a.src) a.muted = true;
      var q;
      try { q = v.play(); } catch (e) { q = null; }
      if (q && q.then) {
        q.then(function () {
          startBtn.style.display = 'none';
          hint('Muted autoplay. Press OK / Play for sound.', true);
          report('muted-autoplay', {});
        }).catch(function () {
          startBtn.style.display = 'inline-block';
          report('autoplay-blocked', {});
        });
      } else {
        startBtn.style.display = 'inline-block';
      }
    });
  }

  function unmute() {
    v.muted = false;
    a.muted = false;
    a.volume = v.volume;
  }

  function attach(info) {
    started = true;
    ttl.textContent = info.title || id;
    document.title = (info.title || 'TubeTV') + ' · TubeTV';
    v.src = info.video;
    if (info.audio) {
      a.src = info.audio;
      a.volume = v.volume;
      a.muted = v.muted;
    }
    report('attached', { tier: tier, h: info.height, audio: !!info.audio });
    startWatchdog();
    tryPlay();
    showChrome();
    // Fullscreen usually needs a gesture; this is a free attempt on TV browsers
    // that allow it, and a CSS full-bleed layout covers the ones that don't.
    setTimeout(fullscreen, 400);
  }

  function loadHlsJs(cb) {
    if (window.Hls) return cb();
    var s = document.createElement('script');
    s.src = '/hls.js';
    s.onload = cb;
    s.onerror = function () { showErr('Could not load the live player (hls.js).'); };
    document.head.appendChild(s);
  }

  function attachLive(info) {
    started = true;
    isLive = true;
    ttl.textContent = info.title || 'Live';
    document.title = (info.title || 'Live') + ' · TubeTV';
    hint('LIVE', true);
    report('live-attach', { hasMSE: typeof window.MediaSource !== 'undefined' });

    if (window.MediaSource) {
      loadHlsJs(function () {
        if (!window.Hls || !window.Hls.isSupported()) {
          showErr('This browser has MediaSource but hls.js cannot use it.');
          return;
        }
        hls = new window.Hls({
          liveSyncDurationCount: 3,
          enableWorker: false,
          lowLatencyMode: false,
          capLevelToPlayerSize: true,
          abrEwmaDefaultEstimate: 2000000,
        });
        hls.on(window.Hls.Events.ERROR, function (ev, data) {
          report('hls-error', { type: data.type, details: data.details, fatal: !!data.fatal });
          if (!data.fatal) return;
          if (data.type === 'networkError') { hls.startLoad(); return; }
          if (data.type === 'mediaError') { hls.recoverMediaError(); return; }
          showErr('Live stream failed: ' + data.details);
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          // Start on the best level that isn't 4K, then hand control back to the
          // adaptive switcher so a slow link can still step down.
          var best = 0, bestH = 0;
          for (var i = 0; i < hls.levels.length; i++) {
            var lh = hls.levels[i].height || 0;
            if (lh <= 1080 && lh >= bestH) { bestH = lh; best = i; }
          }
          if (bestH > 0) {
            try { hls.startLevel = best; } catch (e) {}
            try { hls.currentLevel = best; } catch (e) {}
            setTimeout(function () {
              try { hls.currentLevel = -1; } catch (e) {}
            }, 10000);
          }
          tryPlay();
          showChrome();
        });
        hls.attachMedia(v);
        hls.loadSource(info.hls);
        hint('LIVE — starting…', true);
      });
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = info.hls;
      tryPlay();
      showChrome();
    } else {
      showErr('This TV browser cannot play livestreams (no MediaSource / HLS support).');
    }
  }

  function load() {
    err.style.display = 'none';
    var t = tiers[tier];
    var q = '/api/play?id=' + encodeURIComponent(id) + (t.muxed ? '&muxed=1' : '&h=' + t.h);
    report('request', { tier: tier, q: q });
    fetch(q)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.j && x.j.live && x.j.hls) { attachLive(x.j); return; }
        if (!x.ok || x.j.error || !x.j.video) {
          showErr(x.j.error || 'Could not load this video.');
          return;
        }
        attach(x.j);
      })
      .catch(function (e) { showErr('Request failed: ' + e); });
  }

  function seek(delta) {
    if (isLive) { hint('Live stream — no seeking', true); return; }
    try {
      v.currentTime = Math.max(0, v.currentTime + delta);
      if (a.src) a.currentTime = v.currentTime;
    } catch (e) {}
    hint((delta > 0 ? '+' : '') + delta + 's · ' + fmt(v.currentTime), true);
    showChrome();
  }

  function fmt(s) {
    s = Math.floor(s || 0);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function toggle() {
    if (startBtn.style.display !== 'none') { startBtn.click(); return; }
    if (v.muted && !v.paused) { unmute(); hint('Sound on'); showChrome(); return; }
    if (v.paused) {
      unmute();
      var p = v.play();
      if (p && p.catch) p.catch(function () { startBtn.style.display = 'inline-block'; });
      if (a.src) a.play().catch(function () {});
      hint('Playing');
    } else {
      v.pause();
      hint('Paused');
    }
    showChrome();
  }

  startBtn.addEventListener('click', function () {
    startBtn.style.display = 'none';
    mutedFallback = false;
    unmute();
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
    if (a.src) a.play().catch(function () {});
    fullscreen();
    showChrome();
  });

  // --- audio/video sync ------------------------------------------------
  v.addEventListener('play', function () { if (a.src) a.play().catch(function () {}); });
  v.addEventListener('playing', function () {
    startBtn.style.display = 'none';
    if (isLive) { lastClock = ''; updateClock(); hint('LIVE', true); }
    if (!a.src) return;
    if (Math.abs(a.currentTime - v.currentTime) > 0.25) {
      try { a.currentTime = v.currentTime; } catch (e) {}
    }
    a.play().catch(function () {});
  });
  v.addEventListener('pause', function () { a.pause(); showChrome(); });
  v.addEventListener('seeking', function () {
    if (a.src) { try { a.currentTime = v.currentTime; } catch (e) {} }
  });
  v.addEventListener('timeupdate', function () {
    if (a.src && !a.paused && Math.abs(a.currentTime - v.currentTime) > 0.3) {
      try { a.currentTime = v.currentTime; } catch (e) {}
    }
  });
  v.addEventListener('volumechange', function () { a.volume = v.volume; a.muted = v.muted; });
  v.addEventListener('ratechange', function () { a.playbackRate = v.playbackRate; });
  v.addEventListener('ended', function () { a.pause(); });

  // --- clock ------------------------------------------------------------
  var lastClock = '';
  function updateClock() {
    var s;
    if (isLive) {
      s = 'LIVE';
    } else if (!isFinite(v.duration) || v.duration <= 0) {
      s = fmt(v.currentTime);
    } else {
      var left = Math.max(0, v.duration - v.currentTime);
      s = fmt(v.currentTime) + ' / ' + fmt(v.duration) + '   −' + fmt(left);
    }
    if (s !== lastClock) {
      lastClock = s;
      clock.textContent = s;
    }
  }
  v.addEventListener('timeupdate', updateClock);
  v.addEventListener('loadedmetadata', updateClock);
  v.addEventListener('durationchange', updateClock);

  // No native controls (they steal arrow keys on TV browsers) — tap/click the
  // picture to play or pause.
  v.addEventListener('click', function () { fullscreenOnce(); toggle(); });

  // --- failure handling: step down quality, then give up with detail ----
  var watchdog = null;

  function stopWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  function stepDown(why) {
    if (isLive) return false;
    if (tier >= tiers.length - 1) return false;
    tier++;
    // Only a codec/decode failure (or a stall) says anything about this TV's
    // decoder; a network error should not permanently lower the quality.
    if (why === 'stalled' || /^(video|audio)-[34]$/.test(why)) {
      try { localStorage.setItem('tubetv.tier', String(tier)); } catch (e) {}
    }
    var t = tiers[tier];
    hint('Trying ' + (t.muxed ? 'the compatible stream' : t.h + 'p') + '…', true);
    report('step-down', { why: why, tier: tier });
    stopWatchdog();
    a.removeAttribute('src');
    v.removeAttribute('src');
    load();
    return true;
  }

  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(function () {
      if (!started || isLive || v.paused) return;
      if (v.currentTime > 0 || v.readyState >= 2) {
        stopWatchdog();
        return;
      }
      // Waiting for the viewer to press OK is legitimate — not a stall.
      if (startBtn.style.display !== 'none') return;
      if (stepDown('stalled')) return;
      stopWatchdog();
      showErr('Stalled: no data after 20s (readyState ' + v.readyState +
        ', networkState ' + v.networkState + '). Open /diag on this TV.');
    }, 20000);
  }

  v.addEventListener('error', function () {
    var e = v.error;
    var code = e ? e.code : 0;
    report('video-error', { code: code, rs: v.readyState, ns: v.networkState, tier: tier });
    if (stepDown('video-' + code)) return;
    showErr('Video failed (' + errName(code) + ', code ' + code +
      '). Open /diag on this TV for details.');
  });
  a.addEventListener('error', function () {
    var code = a.error ? a.error.code : 0;
    report('audio-error', { code: code, tier: tier });
    if (stepDown('audio-' + code)) return;
    showErr('Audio failed (' + errName(code) + '). Video may still play.');
  });

  // --- remote keys ------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    var k = e.key || '';
    var c = e.keyCode || e.which || 0;

    if (c === 8 || c === 27 || c === 4 || c === 461 || c === 10009 ||
        k === 'Escape' || k === 'Back' || k === 'Backspace' || k === 'GoBack') {
      e.preventDefault();
      if (window.history.length > 1) window.history.back();
      else window.location.href = '/';
      return;
    }

    fullscreenOnce();
    if ((c === 13 || k === 'Enter' || k === 'OK' || k === 'Select') && document.activeElement === document.body) {
      e.preventDefault();
      toggle();
      return;
    }
    if (k === ' ' || k === 'Spacebar' || c === 32) {
      e.preventDefault();
      toggle();
      return;
    }
    if (c === 179 || c === 415 || c === 10252 || k === 'MediaPlayPause' || k === 'Play' || k === 'MediaPlay') { toggle(); return; }
    if (c === 19 || c === 178 || k === 'MediaStop' || k === 'Pause') {
      if (!v.paused) toggle();
      return;
    }
    if (c === 37 || k === 'ArrowLeft' || k === 'Left') { e.preventDefault(); seek(-10); return; }
    if (c === 39 || k === 'ArrowRight' || k === 'Right') { e.preventDefault(); seek(10); return; }
    if (c === 38 || c === 40 || k === 'ArrowUp' || k === 'ArrowDown' || k === 'Up' || k === 'Down') {
      e.preventDefault();
      showChrome();
      return;
    }
    if (k === 'f' || k === 'F') { fullscreen(); return; }
    showChrome();
  });

  document.addEventListener('click', showChrome);
  document.addEventListener('mousemove', showChrome);
  window.addEventListener('load', function () { showChrome(); });

  load();
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
      <p class="hint">Runs playback tests in this TV's browser. Takes about 30 seconds.</p>
      <pre id="out" class="diagout">starting…</pre>
      <div id="videos" class="diagvideos"></div>
      <script>${DIAG_JS}</script>`;
    return html(res, 200, page({ title: 'Diagnostics', body, signedIn: yt.signedIn() }));
  }

  // Test-only proxy so /diag can check whether the proxy path itself works.
  if (path === '/api/probe') {
    const u = url.searchParams.get('u') || '';
    const ok = /(^|\.)(samplelib\.com|test-videos\.co\.uk|googleapis\.com|w3schools\.com)$/i;
    return proxyMedia(req, res, u, ok);
  }

  // hls.js, served locally so the TV doesn't need internet for the player.
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

  // --- media proxy -------------------------------------------------------
  const media = path.match(/^\/api\/media\/([a-f0-9]+)\/(video|audio)$/);
  if (media) {
    const entry = tokens.get(media[1]);
    if (!entry) return json(res, 410, { error: 'stream expired' });
    const target = media[2] === 'audio' ? entry.audio : entry.video;
    if (!target) return json(res, 404, { error: 'no stream' });
    return proxyMedia(req, res, target);
  }

  // --- resolve a video ---------------------------------------------------
  if (path === '/api/play') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'bad video id' });
    const muxed = url.searchParams.get('muxed') === '1';
    const h = Math.min(1080, Math.max(360, Number(url.searchParams.get('h')) || 1080));
    try {
      const info = await resolveStream(id, { muxed, height: h });
      if (info.live) {
        log('play live', id, ua(req));
        return json(res, 200, {
          live: true,
          title: info.title,
          hls: `/api/hls?u=${b64u(info.hls)}`,
          height: 0,
        });
      }
      const tok = makeToken({ video: info.video, audio: info.audio });
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
      });
    } catch (e) {
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

  // --- continuation (infinite scroll) ------------------------------------
  if (path === '/api/more') {
    const kind = url.searchParams.get('kind') || 'home';
    let token = url.searchParams.get('token') || '';
    if (!token) return json(res, 400, { error: 'missing token' });

    const browseId = { home: 'FEwhat_to_watch', subs: 'FEsubscriptions', history: 'FEhistory' }[kind];
    if (!browseId && kind !== 'search') return json(res, 400, { error: 'bad kind' });
    const fetchPage = (tok) =>
      kind === 'search' ? yt.searchPage(null, tok) : yt.browsePage(browseId, tok);

    let page = { videos: [], token: null };
    try {
      // A continuation token can point at a shelf rather than the page tail, in
      // which case it returns only already-seen videos. Hop a couple of times.
      for (let i = 0; i < 3; i++) {
        page = await fetchPage(token);
        token = page.token;
        if (page.videos.length || !token) break;
      }
    } catch (e) {
      const msg = String(e.message || e);
      if (/401|authentication/i.test(msg)) return json(res, 401, { error: 'signin' });
      log('more ERR', kind, msg.slice(0, 120));
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

  if (path === '/watch') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return errorPage(res, new Error('Bad video id'), 400);
    const body = `<div class="watch">
      <div class="ov" id="ov">
        <button class="btn" id="back" onclick="history.back()">← Back</button>
        <h1 id="title">Loading…</h1>
      </div>
      <video id="v" autoplay playsinline webkit-playsinline x5-playsinline preload="auto"></video>
      <audio id="a" preload="auto"></audio>
      <button id="start" class="start">▶ Play</button>
      <div class="hud hide" id="hud"></div>
      <div class="clock" id="clock"></div>
      <div class="err" id="err" style="display:none"></div>
      <p class="hint">OK play/pause · ← → seek 10s · Back to grid · F fullscreen</p>
    </div>
    <script>${PLAYER_JS}</script>`;
    return html(res, 200, page({ title: 'Watch', body, active: '', signedIn: yt.signedIn(), cinema: true }));
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
    return html(res, 200, page({ title: q || 'Search', body, active: 'search', signedIn: yt.signedIn() }));
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
    return html(res, 200, page({ title: 'Subscriptions', body, active: 'subs', signedIn: yt.signedIn() }));
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
    const body = `<h1>History</h1>${
      p.videos.length
        ? grid(p.videos.slice(0, 60), { kind: 'history', token: p.token })
        : signedOut || !yt.signedIn()
          ? '<div class="empty">Sign in to see your watch history.</div>'
          : '<div class="empty">No watch history yet.</div>'
    }`;
    return html(res, 200, page({ title: 'History', body, active: 'history', signedIn: yt.signedIn() }));
  }

  if (path === '/') {
    const p = await yt.homePage();
    const body = `<h1>Recommended</h1>${grid(p.videos.slice(0, 60), {
      kind: p.kind,
      token: p.token,
    })}`;
    return html(res, 200, page({ title: 'Home', body, active: 'home', signedIn: yt.signedIn() }));
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
