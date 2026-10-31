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
  font-size: 18px;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
img { display: block; }

.top {
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 16px 34px;
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(11, 11, 12, 0.94);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid #232329;
}
.brand { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; white-space: nowrap; }
.brand span { color: var(--accent); }
nav { display: flex; gap: 8px; }
.navlink {
  padding: 10px 16px;
  border-radius: 10px;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
.navlink:hover, .navlink:focus, .navlink.active {
  background: var(--panel-2);
  color: var(--text);
  outline: none;
}
.search { margin-left: auto; flex: 0 1 420px; }
.search input {
  width: 100%;
  padding: 12px 18px;
  font-size: 17px;
  color: var(--text);
  background: var(--panel);
  border: 2px solid #2c2c33;
  border-radius: 12px;
  outline: none;
}
.search input:focus { border-color: #6e6e7a; background: #1d1d21; }
.acct {
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--panel-2);
  font-weight: 600;
  white-space: nowrap;
}

main { padding: 26px 34px 80px; }
h1 { font-size: 26px; margin: 0 0 20px; font-weight: 700; }
h2 { font-size: 21px; margin: 0 0 16px; color: var(--muted); font-weight: 600; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 26px 22px;
}
.card {
  display: block;
  border-radius: 14px;
  padding: 6px;
  outline: none;
  transition: transform 120ms ease, background 120ms ease;
}
.card .thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel-2);
}
.card .thumb img { width: 100%; height: 100%; object-fit: cover; }
.card .dur {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.85);
  font-size: 14px;
  font-weight: 700;
}
.card .meta { padding: 10px 4px 2px; }
.card .t {
  font-size: 17px;
  font-weight: 600;
  line-height: 1.28;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card .c { margin-top: 5px; font-size: 14px; color: var(--muted); }
.card:focus, .card:focus-visible {
  background: var(--panel-2);
  transform: scale(1.035);
  box-shadow: 0 0 0 4px #fff;
}

.watch { max-width: 1500px; margin: 0 auto; }
.bar { display: flex; align-items: center; gap: 20px; margin-bottom: 18px; }
.bar h1 { margin: 0; font-size: 20px; color: var(--muted); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn {
  padding: 11px 18px;
  border-radius: 10px;
  background: var(--panel-2);
  font-weight: 700;
  white-space: nowrap;
}
.btn:focus, .btn:hover { box-shadow: 0 0 0 3px #fff; outline: none; }
video {
  width: 100%;
  max-height: 78vh;
  background: #000;
  border-radius: 14px;
  display: block;
}
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
.hint { margin-top: 14px; color: var(--muted); font-size: 14px; }
.start {
  display: none;
  margin: 26px auto 0;
  padding: 18px 40px;
  font-size: 22px;
  font-weight: 800;
  color: #000;
  background: #fff;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}
.start:focus { box-shadow: 0 0 0 5px var(--accent); outline: none; }

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

kbd {
  background: #2a2a30;
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 0.85em;
}
`;

// Remote-friendly spatial navigation: arrow keys move focus geometrically.
const NAV_JS = `
(function () {
  var SEL = 'a[href], button, input, [tabindex="0"]';
  function items() {
    return Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(function (el) {
      return el.offsetParent !== null && !el.disabled;
    });
  }
  document.addEventListener('keydown', function (e) {
    var map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    var d = map[e.key];
    if (!d) return;
    var ae = document.activeElement;
    if (ae && ae.tagName === 'INPUT' && d[0] !== 0) return;
    var list = items();
    if (!list.length) return;
    if (!ae || list.indexOf(ae) === -1) { e.preventDefault(); list[0].focus(); return; }
    var r = ae.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === ae) continue;
      var q = el.getBoundingClientRect();
      var dx = q.left + q.width / 2 - cx;
      var dy = q.top + q.height / 2 - cy;
      if (d[0] && Math.sign(dx) !== d[0]) continue;
      if (d[1] && Math.sign(dy) !== d[1]) continue;
      var score = (d[0] ? Math.abs(dx) : Math.abs(dy)) +
                  (d[0] ? Math.abs(dy) : Math.abs(dx)) * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) {
      e.preventDefault();
      best.focus();
      if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
})();
`;

export function page({ title, body, active = '', signedIn = false, extraHead = '' }) {
  const nav = [
    ['home', '/', 'Home'],
    ['subs', '/subs', 'Subscriptions'],
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
<body>
<header class="top">
  <a class="brand" href="/">Tube<span>TV</span></a>
  <nav>${nav}</nav>
  <form class="search" action="/search" method="get">
    <input name="q" type="search" placeholder="Search YouTube" autocomplete="off" spellcheck="false">
  </form>
  <a class="acct" href="/login">${signedIn ? 'Account' : 'Sign in'}</a>
</header>
<main>${body}</main>
<script>${NAV_JS}</script>
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

export function grid(videos) {
  if (!videos.length) return '<div class="empty">Nothing here yet.</div>';
  return `<div class="grid">${videos.map(card).join('')}</div>`;
}
