export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const CSS = `
:root {
  --bg: #0b0b0c;
  --panel: #17171a;
  --panel-2: #202024;
  --text: #f2f2f4;
  --muted: #a0a0aa;
  --accent: #ff2d55;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 21px;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
img { display: block; }
/* Keep the focused tile clear of the sticky header when the browser scrolls it
   into view (some TV browsers put it right under the header otherwise). */
a, button, input { scroll-margin: 120px 20px 120px; }

.top {
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 18px 40px;
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(11, 11, 12, 0.94);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid #232329;
}
.brand { font-size: 30px; font-weight: 800; letter-spacing: -0.5px; white-space: nowrap; }
.brand span { color: var(--accent); }
nav { display: flex; gap: 8px; }
.navlink {
  padding: 14px 22px;
  border-radius: 10px;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
  font-size: 19px;
}
.navlink:hover, .navlink:focus, .navlink.active {
  background: var(--panel-2);
  color: var(--text);
  outline: none;
}
.navlink:focus { box-shadow: 0 0 0 4px #fff; }
.search { margin-left: auto; flex: 0 1 420px; }
.search input {
  width: 100%;
  padding: 13px 18px;
  font-size: 19px;
  color: var(--text);
  background: var(--panel);
  border: 2px solid #2c2c33;
  border-radius: 12px;
  outline: none;
}
.search input:focus { border-color: #6e6e7a; background: #1d1d21; }
.acct {
  padding: 12px 18px;
  border-radius: 10px;
  background: var(--panel-2);
  font-weight: 600;
  white-space: nowrap;
  font-size: 18px;
}
.acct:focus { box-shadow: 0 0 0 4px #fff; outline: none; }

main { padding: 30px 40px 90px; }
h1 { font-size: 32px; margin: 0 0 24px; font-weight: 700; }
h2 { font-size: 21px; margin: 0 0 16px; color: var(--muted); font-weight: 600; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 34px 26px;
}
.card {
  display: block;
  border-radius: 16px;
  padding: 8px;
  outline: none;
  scroll-margin: 110px;
  transition: transform 120ms ease, background 120ms ease, box-shadow 120ms ease;
}
.card .thumb {
  /* padding hack instead of aspect-ratio: VIDAA's Chromium predates it */
  position: relative;
  padding-top: 56.25%;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel-2);
}
.card .thumb img {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.card .dur {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.85);
  font-size: 16px;
  font-weight: 700;
}
.card .meta { padding: 10px 4px 2px; }
.card .t {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card .c { margin-top: 6px; font-size: 16px; color: var(--muted); }
.card:focus, .card:focus-visible {
  background: var(--panel-2);
  transform: scale(1.05);
  box-shadow: 0 0 0 6px #fff, 0 18px 40px rgba(0, 0, 0, 0.65);
}

.watch { max-width: 1500px; margin: 0 auto; }
.bar { display: flex; align-items: center; gap: 20px; margin-bottom: 18px; }
.bar h1 { margin: 0; font-size: 20px; color: var(--muted); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn {
  padding: 12px 20px;
  border-radius: 10px;
  background: var(--panel-2);
  font-weight: 700;
  white-space: nowrap;
}
.btn:focus, .btn:hover { box-shadow: 0 0 0 4px #fff; outline: none; }
video {
  width: 100%;
  max-height: 78vh;
  background: #000;
  border-radius: 14px;
  display: block;
}

/* Cinema mode: no page chrome, video fills the panel. */
body.cinema, body.watch-open { overflow: hidden; }
/* The overlay keeps the grid underneath, so it must not re-layout main. */
body.cinema:not(.watch-open) .top { display: none; }
body.cinema:not(.watch-open) main { padding: 0; height: 100vh; }
body.cinema .watch { max-width: none; height: 100vh; }

/* In-page player overlay (grid pages open videos here, without navigating). */
.stage {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: #000;
}
.stage.hide { display: none; }
.stage video {
  width: 100vw;
  height: 100vh;
  max-height: none;
  border-radius: 0;
  object-fit: contain;
  cursor: pointer;
}
body.cinema video {
  width: 100vw;
  height: 100vh;
  max-height: none;
  border-radius: 0;
  object-fit: contain;
}
.ov {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 18px 30px 40px;
  background: linear-gradient(rgba(0,0,0,0.85), rgba(0,0,0,0));
  transition: opacity 200ms ease;
}
.ov.hide { opacity: 0; pointer-events: none; }
.ov h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hud {
  position: fixed;
  left: 50%;
  bottom: 112px;
  transform: translateX(-50%);
  z-index: 26;
  padding: 10px 20px;
  border-radius: 999px;
  background: rgba(0,0,0,0.8);
  color: var(--muted);
  font-size: 15px;
  white-space: nowrap;
  transition: opacity 200ms ease;
}
.hud.hide { opacity: 0; }
.clock {
  position: fixed;
  right: 34px;
  bottom: 112px;
  z-index: 26;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.7);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.9);
  pointer-events: none;
}

/* bottom control bar (Leanback style) */
.ovb {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 25;
  padding: 40px 34px 26px;
  background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.9));
  transition: opacity 200ms ease;
}
.ovb.hide { opacity: 0; pointer-events: none; }
.prog {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.22);
  margin: 0 0 18px;
}
.prog > div { height: 100%; width: 0%; border-radius: 3px; background: #fff; }
.btns { display: flex; gap: 14px; flex-wrap: wrap; }
.ctl {
  font: inherit;
  font-size: 19px;
  font-weight: 600;
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  border: 0;
  border-radius: 10px;
  padding: 15px 24px;
  cursor: pointer;
}
.ctl:focus, .ctl:hover {
  background: #fff;
  color: #000;
  outline: none;
  box-shadow: 0 0 0 4px var(--accent);
}

/* settings / comments sheet */
.panel {
  position: fixed;
  z-index: 40;
  background: #101014;
  color: var(--text);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.75);
}
.panel.hide { display: none; }
.panel.qual {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 560px;
  max-height: 74vh;
  border-radius: 16px;
  border: 1px solid #26262c;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel.cmt {
  right: 0; top: 0; bottom: 0;
  width: 46%;
  border-left: 1px solid #26262c;
  display: flex;
  flex-direction: column;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding: 20px 24px;
  font-size: 22px;
  font-weight: 700;
  border-bottom: 1px solid #26262c;
  flex: 0 0 auto;
}
.panel-hint { font-size: 14px; color: var(--muted); font-weight: 500; white-space: nowrap; }
.panel-body { overflow-y: auto; padding: 12px; flex: 1 1 auto; }
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 19px;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 10px;
  padding: 16px 18px;
  cursor: pointer;
}
.row:focus, .row:hover { background: #fff; color: #000; outline: none; box-shadow: 0 0 0 3px var(--accent); }
.row .chk { font-size: 14px; opacity: 0.65; }
.pnote { padding: 18px; color: var(--muted); font-size: 17px; line-height: 1.45; }
.cmt-item { padding: 16px 14px; border-bottom: 1px solid #1e1e24; }
.cmt-h { font-size: 16px; color: var(--muted); margin-bottom: 6px; }
.cmt-h b { color: #fff; font-weight: 700; }
.cmt-t { font-size: 18px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.cmt-f { margin-top: 8px; font-size: 15px; color: var(--muted); }
.pill {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--panel-2);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  vertical-align: middle;
}
.cmtlist { max-width: 900px; }
body.cinema video { cursor: pointer; }
.err {
  margin-top: 18px;
  padding: 16px 20px;
  border-radius: 12px;
  background: #2a1417;
  border: 1px solid #5c2229;
  color: #ffb3bf;
  line-height: 1.45;
  white-space: pre-wrap;
}
body.cinema .err { position: fixed; left: 30px; right: 30px; bottom: 30px; margin: 0; z-index: 30; }
.hint { margin-top: 14px; color: var(--muted); font-size: 14px; }
body.cinema .hint { display: none; }
.start {
  display: none;
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 30;
  padding: 22px 54px;
  font-size: 26px;
  font-weight: 800;
  color: #000;
  background: #fff;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}
.start:focus { box-shadow: 0 0 0 6px var(--accent); outline: none; }

.login { max-width: 720px; margin: 6vh auto; text-align: center; }
.code {
  font-size: 64px;
  font-weight: 800;
  letter-spacing: 8px;
  margin: 26px 0;
  padding: 22px;
  background: var(--panel);
  border-radius: 18px;
  border: 1px solid #2c2c33;
}
.login p { color: var(--muted); line-height: 1.5; }
.login a.link { color: #7db7ff; text-decoration: underline; }
.status { margin-top: 22px; font-size: 18px; }
.spin { color: var(--muted); }

.empty { color: var(--muted); padding: 40px 0; }

.diagout {
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.55;
  background: var(--panel);
  border: 1px solid #2c2c33;
  border-radius: 12px;
  padding: 18px 20px;
  font-family: ui-monospace, Menlo, monospace;
}
.diagvideos { display: flex; flex-wrap: wrap; margin-top: 16px; }

kbd {
  background: #2a2a30;
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 0.85em;
}
`;

// Remote-friendly spatial navigation: arrow keys move focus geometrically.
// Handles both modern (e.key) and old TV remotes (keyCode / legacy key names).
const NAV_JS = `
(function () {
  var SEL = 'a[href], button, input, [tabindex="0"]';

  function items() {
    var all = document.querySelectorAll(SEL);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.offsetParent !== null && !el.disabled) out.push(el);
    }
    return out;
  }

  function keyOf(e) {
    var k = e.key || '';
    var c = e.keyCode || e.which || 0;
    if (k === 'ArrowLeft' || k === 'Left' || c === 37) return 'left';
    if (k === 'ArrowRight' || k === 'Right' || c === 39) return 'right';
    if (k === 'ArrowUp' || k === 'Up' || c === 38) return 'up';
    if (k === 'ArrowDown' || k === 'Down' || c === 40) return 'down';
    if (c === 8 || c === 27 || c === 4 || c === 461 || c === 10009 ||
        k === 'Escape' || k === 'Back' ||
        k === 'GoBack' || k === 'BrowserBack' || k === 'Backspace') return 'back';
    return '';
  }

  // scrollIntoView({block:'center'}) is ignored by old Chromium, so do it by hand.
  function center(el) {
    var r = el.getBoundingClientRect();
    var y = window.pageYOffset + r.top - (window.innerHeight - r.height) / 2;
    window.scrollTo(0, y < 0 ? 0 : y);
  }

  document.addEventListener('keydown', function (e) {
    var ae = document.activeElement;
    var inInput = ae && ae.tagName === 'INPUT';

    // The watch page handles every key itself (play/seek/panels/back).
    if (document.body.classList.contains('cinema')) return;

    // Diagnostics from anywhere: the account menu is not always reachable.
    if ((e.key === 'd' || e.key === 'D') && !inInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      window.location.href = '/diag';
      return;
    }

    var k = keyOf(e);
    if (!k) return;

    if (k === 'back') {
      // A focused text field would otherwise swallow Back forever.
      if (inInput) {
        e.preventDefault();
        ae.blur();
        return;
      }
      e.preventDefault();
      if (window.history.length > 1) window.history.back();
      else window.location.href = '/';
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    var d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[k];
    if (!d) return;
    // In the search box ←/→ move the caret; only leave it at the edges, so the
    // items either side of the field stay reachable.
    if (inInput && d[0] !== 0) {
      var pos = ae.selectionStart || 0;
      var end = ae.selectionEnd || 0;
      var len = (ae.value || '').length;
      if (len && ((d[0] > 0 && end < len) || (d[0] < 0 && pos > 0))) return;
    }

    var list = items();
    if (!list.length) return;
    if (!ae || list.indexOf(ae) === -1) {
      e.preventDefault();
      list[0].focus();
      center(list[0]);
      return;
    }

    var r = ae.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === ae) continue;
      var q = el.getBoundingClientRect();
      var dx = q.left + q.width / 2 - cx;
      var dy = q.top + q.height / 2 - cy;
      var score;
      if (d[0]) {
        // Left/right must stay in the same row — otherwise the remote jumps to
        // the top menu from the middle of the grid.
        if (dx === 0 || (dx > 0 ? 1 : -1) !== d[0]) continue;
        if (Math.abs(dy) > Math.max(r.height, q.height) * 0.75) continue;
        score = Math.abs(dx) + Math.abs(dy) * 3;
      } else {
        // Up/down prefers the same column.
        if (dy === 0 || (dy > 0 ? 1 : -1) !== d[1]) continue;
        score = Math.abs(dy) + Math.abs(dx) * 2.5;
      }
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      e.preventDefault();
      best.focus();
      center(best);
    }
  });

  // Put the remote's cursor on the first tile instead of nowhere.
  window.addEventListener('load', function () {
    if (document.body.classList.contains('cinema')) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    var first = document.querySelector('.card') || document.querySelector('.navlink');
    if (first) first.focus();
  });
})();
`;

// Loads the next page of the grid when the remote reaches the last row (or the
// page is scrolled near the bottom). New cards are appended in place so focus
// never moves, and duplicates are dropped.
const MORE_JS = `
(function () {
  var grid = document.getElementById('grid');
  var more = document.getElementById('more');
  if (!grid || !more) return;

  var kind = more.getAttribute('data-kind') || 'home';
  var token = more.getAttribute('data-token') || '';
  var loading = false;
  var misses = 0;
  var failures = 0;

  function nearEnd() {
    var last = grid.lastElementChild;
    if (!last) return false;
    var r = last.getBoundingClientRect();
    return r.top < window.innerHeight + 800;
  }

  function load() {
    if (loading || !token || misses >= 2 || failures >= 3) return;
    loading = true;
    fetch('/api/more?kind=' + encodeURIComponent(kind) + '&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        loading = false;
        if (!j || j.error) {
          failures++;
          token = '';
          return;
        }
        var box = document.createElement('div');
        box.innerHTML = j.html || '';
        var added = 0;
        while (box.firstChild) {
          var el = box.firstChild;
          box.removeChild(el);
          var href = el.getAttribute ? el.getAttribute('href') : null;
          if (href && grid.querySelector('a[href="' + href + '"]')) continue;
          grid.appendChild(el);
          added++;
        }
        if (added) { misses = 0; failures = 0; } else { misses++; }
        token = j.token || '';
        if (added) setTimeout(maybe, 60);
      })
      .catch(function () {
        loading = false;
        failures++;
      });
  }

  function maybe() {
    if (nearEnd()) load();
  }

  window.addEventListener('scroll', maybe);
  document.addEventListener('focusin', maybe);
  window.addEventListener('load', maybe);
})();
`;

// One player markup, used both by /watch (standalone, deep links) and by the
// hidden #stage overlay every grid page carries, so a tile press can start
// playback without a page load.
export function playerMarkup() {
  return `<video id="v" autoplay muted playsinline webkit-playsinline x5-playsinline preload="auto"></video>
      <audio id="a" preload="auto" muted></audio>
      <div class="ov hide" id="ov">
        <button class="btn" id="back">← Back</button>
        <h1 id="title">Loading…</h1>
      </div>
      <div class="ovb hide" id="ovb">
        <div class="prog" id="prog"><div id="progfill"></div></div>
        <div class="btns">
          <button class="ctl" id="ctlplay">Pause</button>
          <button class="ctl" id="ctlgear">Quality</button>
          <button class="ctl" id="ctlcmt">Comments</button>
        </div>
      </div>
      <button id="start" class="start">▶ Play</button>
      <div class="hud hide" id="hud"></div>
      <div class="clock" id="clock"></div>
      <div class="panel hide" id="panel" tabindex="-1">
        <div class="panel-head">
          <span id="paneltitle">Quality</span>
          <span class="panel-hint">Back to close</span>
        </div>
        <div class="panel-body" id="panelbody"></div>
      </div>
      <div class="err" id="err" style="display:none"></div>`;
}

export function page({ title, body, active = '', signedIn = false, extraHead = '', cinema = false }) {
  const nav = [
    ['home', '/', 'Home'],
    ['subs', '/subs', 'Subscriptions'],
    ['history', '/history', 'History'],
  ]
    .map(
      ([key, href, label]) =>
        `<a class="navlink ${active === key ? 'active' : ''}" href="${href}">${label}</a>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · TubeTV</title>
<meta name="theme-color" content="#0b0b0c">
<link rel="manifest" href="/manifest.webmanifest">
<style>${CSS}</style>
${extraHead}
</head>
<body class="${cinema ? 'cinema' : ''}">
<header class="top">
  <a class="brand" href="/">Tube<span>TV</span></a>
  <nav>${nav}</nav>
  <form class="search" action="/search" method="get">
    <input name="q" type="search" placeholder="Search YouTube" autocomplete="off" spellcheck="false">
  </form>
  <a class="acct" href="/login">${signedIn ? 'Account' : 'Sign in'}</a>
</header>
<main>${body}</main>
${cinema ? '' : `<div id="stage" class="stage hide">${playerMarkup()}</div>`}
<script>${NAV_JS}</script>
<script>${MORE_JS}</script>
<script src="/player.js"></script>
</body>
</html>`;
}

export function card(v) {
  const meta = [v.channel, v.views].filter(Boolean).join(' · ');
  const img = v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
  return `<a class="card" href="/watch?id=${esc(v.id)}">
  <div class="thumb">
    <img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">
    ${v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ''}
  </div>
  <div class="meta">
    <div class="t">${esc(v.title || 'Untitled')}</div>
    ${meta ? `<div class="c">${esc(meta)}</div>` : ''}
  </div>
</a>`;
}

export function comment(c) {
  const bits = [];
  if (c.published) bits.push(esc(c.published));
  const meta = bits.join(' · ');
  const stats = [];
  if (c.likes) stats.push(`${esc(c.likes)} likes`);
  if (c.replies) stats.push(`${esc(c.replies)} replies`);
  return `<div class="cmt-item">
  <div class="cmt-h"><b>${esc(c.author || 'Unknown')}</b>${meta ? ` · ${meta}` : ''}${
    c.owner ? '<span class="pill">Creator</span>' : ''
  }${c.pinned ? '<span class="pill">Pinned</span>' : ''}</div>
  <div class="cmt-t">${esc(c.text || '')}</div>
  ${stats.length ? `<div class="cmt-f">${stats.join(' · ')}</div>` : ''}
</div>`;
}

export function grid(videos, more) {
  const cards = videos.length
    ? videos.map(card).join('')
    : '<div class="empty">Nothing here yet.</div>';
  const marker =
    more && more.token
      ? `<div id="more" data-kind="${esc(more.kind || 'home')}" data-token="${esc(more.token)}"></div>`
      : '';
  return `<div class="grid" id="grid">${cards}</div>${marker}`;
}
