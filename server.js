import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import * as auth from './lib/auth.js';
import * as yt from './lib/innertube.js';
import { resolve as resolveStream } from './lib/ytdlp.js';
import { page, grid, esc } from './lib/ui.js';

const PORT = Number(process.env.PORT || 8484);
const HOST = process.env.HOST || '0.0.0.0';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Resolved googlevideo URLs are IP-locked and expire. Keep them server-side and
// hand the browser short opaque paths instead.
const tokens = new Map();

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

async function proxyMedia(req, res, url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return json(res, 400, { error: 'bad url' });
  }
  if (!/(^|\.)googlevideo\.com$/.test(target.hostname)) {
    return json(res, 403, { error: 'host not allowed' });
  }

  const headers = { 'user-agent': UA };
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];

  let upstream;
  try {
    upstream = await fetch(url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers });
  } catch (e) {
    return json(res, 502, { error: 'upstream fetch failed: ' + e.message });
  }

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

const PLAYER_JS = `
(function () {
  var params = new URLSearchParams(location.search);
  var id = params.get('id');
  var v = document.getElementById('v');
  var a = document.getElementById('a');
  var err = document.getElementById('err');
  var ttl = document.getElementById('title');
  var startBtn = document.getElementById('start');
  var retried = false;

  function play() {
    var p = v.play();
    if (p && p.catch) p.catch(function () { startBtn.style.display = 'inline-block'; });
  }

  startBtn.addEventListener('click', function () {
    startBtn.style.display = 'none';
    v.play().catch(function () {});
    if (a.src) a.play().catch(function () {});
  });

  function showErr(msg) {
    err.textContent = msg;
    err.style.display = 'block';
  }

  function attach(info) {
    ttl.textContent = info.title || id;
    document.title = (info.title || 'TubeTV') + ' · TubeTV';
    v.src = info.video;
    if (info.audio) {
      a.src = info.audio;
      a.volume = v.volume;
      a.muted = v.muted;
    }
    play();
  }

  function load(muxed) {
    err.style.display = 'none';
    fetch('/api/play?id=' + encodeURIComponent(id) + (muxed ? '&muxed=1' : ''))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok || x.j.error) { showErr(x.j.error || 'Could not load this video.'); return; }
        attach(x.j);
      })
      .catch(function (e) { showErr(String(e)); });
  }

  v.addEventListener('play', function () { if (a.src) a.play().catch(function () {}); });
  v.addEventListener('playing', function () {
    startBtn.style.display = 'none';
    if (!a.src) return;
    if (Math.abs(a.currentTime - v.currentTime) > 0.25) {
      try { a.currentTime = v.currentTime; } catch (e) {}
    }
    a.play().catch(function () {});
  });
  v.addEventListener('pause', function () { a.pause(); });
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
  v.addEventListener('error', function () {
    if (!retried && a.src) { retried = true; a.removeAttribute('src'); load(true); return; }
    showErr('Playback error. Reload the page to retry.');
  });
  a.addEventListener('error', function () {
    if (!retried) { retried = true; a.removeAttribute('src'); load(true); }
  });

  load(false);
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

  if (path === '/healthz') return json(res, 200, { ok: true, signedIn: yt.signedIn() });

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
    try {
      const info = await resolveStream(id, { muxed: url.searchParams.get('muxed') === '1' });
      const tok = makeToken({ video: info.video, audio: info.audio });
      return json(res, 200, {
        title: info.title,
        duration: info.duration,
        video: `/api/media/${tok}/video`,
        audio: info.audio ? `/api/media/${tok}/audio` : null,
        height: info.height,
      });
    } catch (e) {
      return json(res, 502, { error: e.message || String(e) });
    }
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
      <div class="bar">
        <button class="btn" onclick="history.back()">← Back</button>
        <h1 id="title">Loading…</h1>
      </div>
      <video id="v" controls autoplay playsinline preload="auto"></video>
      <audio id="a" preload="auto"></audio>
      <button id="start" class="start" style="display:none">▶ Play</button>
      <div class="err" id="err" style="display:none"></div>
      <p class="hint">Playback goes through this machine. If audio and video drift, pause/play once.</p>
    </div>
    <script>${PLAYER_JS}</script>`;
    return html(res, 200, page({ title: 'Watch', body, active: '', signedIn: yt.signedIn() }));
  }

  if (path === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    let videos = [];
    if (q) videos = (await yt.search(q)).slice(0, 60);
    const body = `<h1>${q ? `Results for “${esc(q)}”` : 'Search'}</h1>${grid(videos)}`;
    return html(res, 200, page({ title: q || 'Search', body, active: 'search', signedIn: yt.signedIn() }));
  }

  if (path === '/subs') {
    const videos = (await yt.subscriptions()).slice(0, 60);
    const body = `<h1>Subscriptions</h1>${
      videos.length ? grid(videos) : '<div class="empty">Sign in to see your subscriptions.</div>'
    }`;
    return html(res, 200, page({ title: 'Subscriptions', body, active: 'subs', signedIn: yt.signedIn() }));
  }

  if (path === '/') {
    const videos = (await yt.home()).slice(0, 60);
    return html(
      res,
      200,
      page({ title: 'Home', body: `<h1>Recommended</h1>${grid(videos)}`, active: 'home', signedIn: yt.signedIn() })
    );
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
