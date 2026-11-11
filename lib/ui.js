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
  /* Sticky and near-opaque: a backdrop blur here repainted the whole grid
     behind it on every remote-driven scroll frame, which the TV GPU cannot
     keep up with. 0.97 looks the same without the per-frame blur. */
  background: rgba(11, 11, 12, 0.97);
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
  /* Only transform is animated: it can be composited. Animating background or
     box-shadow here forced a full repaint of the tile (and its blurred glow)
     on every frame, so the highlight visibly lagged the selection on the TV. */
  transition: transform 120ms ease;
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
/* Red "watched" bar, like YouTube's: drawn by NAV_JS from the TV's saved
   positions so the grid shows where playback stopped. */
.card .thumb .wbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 7px;
  background: rgba(255, 255, 255, 0.28);
}
.card .thumb .wbar i {
  display: block;
  height: 100%;
  background: #f00;
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
  /* Solid ring only: the old 18px/40px blurred drop shadow had to be
     rasterised on every focus move and is what made arrows feel sluggish. */
  box-shadow: 0 0 0 6px #fff;
}

/* Channel page header (avatar, name, handle, subscriber count). */
.chhead {
  display: flex;
  align-items: center;
  gap: 30px;
  margin: 0 0 34px;
  padding: 6px 4px;
}
.chhead img, .chhead .chav {
  width: 148px;
  height: 148px;
  border-radius: 50%;
  object-fit: cover;
  flex: 0 0 auto;
  background: var(--panel-2);
}
.chhead .chinfo { min-width: 0; }
.chhead h1 {
  margin: 0 0 8px;
  font-size: 42px;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chhead .chsub { font-size: 20px; color: var(--muted); }
.chhead .chdesc {
  margin-top: 10px;
  font-size: 17px;
  color: var(--muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-width: 1100px;
}

/* Long-press menu on a grid tile (Go to channel / Play). */
.holdmenu {
  position: fixed;
  z-index: 55;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 460px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid #2b2b33;
  background: #101014;
  box-shadow: 0 26px 80px rgba(0, 0, 0, 0.8);
}
.holdmenu .holdtitle {
  padding: 10px 14px 16px;
  font-size: 16px;
  color: var(--muted);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.holdmenu .row { font-size: 20px; font-weight: 600; padding: 17px 18px; }

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
/* While the overlay is up, take the grid out of the render tree entirely. This
   is the main memory relief on VIDAA; scroll position and focus are restored on
   close because the player remembers them. */
body.watch-open main, body.watch-open .top { display: none; }
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
  transition: opacity 200ms ease;
}
.clock.hide { opacity: 0; }

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
  outline: none;
  transition: box-shadow 120ms ease, height 120ms ease;
}
.prog:focus {
  height: 10px;
  box-shadow: 0 0 0 4px var(--accent);
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
/* Channel identity in the player control row: avatar, name, subscriber count,
   and a direct route to the channel page. It sits at the right end of the
   button row so it adds no extra height to the bar. */
.chanrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 0 auto;
  padding: 7px 14px 7px 7px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.10);
  color: #fff;
  font: inherit;
  text-align: left;
  cursor: pointer;
  max-width: 100%;
}
.chanrow .chanav {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  flex: 0 0 auto;
  background: #333;
}
.chanrow .channame {
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}
.chanrow .chansubs { font-size: 13px; color: var(--muted); white-space: nowrap; }
.chanrow .changoto { margin-left: 4px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.chanrow:focus, .chanrow:hover {
  background: #fff;
  color: #000;
  outline: none;
  box-shadow: 0 0 0 4px var(--accent);
}
.chanrow:focus .chansubs, .chanrow:focus .changoto,
.chanrow:hover .chansubs, .chanrow:hover .changoto { color: #444; }

/* End screen: YouTube-style suggestions over the last frame. Same-origin
   thumbnails, four across, reachable with the remote's arrows. */
.endscreen {
  position: fixed;
  inset: 0;
  z-index: 35;
  display: flex;
  flex-direction: column;
  padding: 4vh 4vw 6vh;
  background: linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.92));
}
.endscreen.hide { display: none; }
.endscreen-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  font-size: 26px;
  font-weight: 700;
}
.endscreen-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  overflow-y: auto;
  flex: 1 1 auto;
  padding: 6px;
}
.relcard {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.relcard img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
  background: #000;
}
.relcard .rt {
  padding: 10px 12px 2px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.25;
  max-height: 3.8em;
  overflow: hidden;
}
.relcard .rc {
  padding: 0 12px 12px;
  font-size: 14px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.relcard:focus, .relcard:focus-visible {
  outline: none;
  box-shadow: 0 0 0 4px #fff, 0 0 0 8px var(--accent);
  transform: scale(1.03);
}

/* Related list inside the sheet (opened with the Suggested button). */
.row.relrow { justify-content: flex-start; gap: 14px; }
.row.relrow img {
  width: 120px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 8px;
  flex: 0 0 auto;
  background: #000;
}
.row.relrow .reltxt { display: flex; flex-direction: column; min-width: 0; gap: 4px; }
.row.relrow .rt { font-size: 17px; font-weight: 600; line-height: 1.25; }
.row.relrow .rc { font-size: 14px; color: var(--muted); }

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

  // --- long press OK on a tile -----------------------------------------
  // A focused link activates on Enter immediately, so a capture listener owns
  // the OK key: a short press opens the video as before, a ~700 ms hold opens a
  // small menu with "Go to channel".
  var holdEl = null, holdCard = null, holdTimer = null, holdFired = false;
  // Channel ids are normally carried on the card, but the signed-in TV home
  // feed nests its channel link where it cannot be read from the tile. Look the
  // channel up from the video id when the viewer starts holding OK, so the
  // menu always offers "Go to channel".
  var chanOfCache = {}, chanOfBusy = {}, holdChanTimer = null;
  // The OK that opened the menu is still held down. TV remotes repeat keydown
  // while held, and those repeats used to activate the first menu row ("Play
  // video") immediately, opening the video the viewer was trying to long-press.
  // Ignore OK until the key is released, then treat the next press as a choice.
  var holdWaitRelease = false;
  // When the OK key went down. A busy page (thumbnail decode, continuation
  // render) can delay the 700 ms timer past the release; the elapsed time lets
  // keyup still tell a real hold from a tap.
  var holdAt = 0;
  function isOkKey(e) {
    var k = e.key || '';
    var c = e.keyCode || e.which || 0;
    return c === 13 || c === 23 || k === 'Enter' || k === 'OK' ||
      k === 'Select' || k === 'Accept';
  }
  function videoIdOf(card) {
    var m = /[?&]id=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(
      (card && card.getAttribute('href')) || ''
    );
    return m ? m[1] : '';
  }
  function applyChannel(card, data) {
    if (!card || !data || !data.channelId) return;
    card.setAttribute('data-channel', data.channelId);
    if (data.channel) card.setAttribute('data-channel-name', data.channel);
  }
  // Cache per video id. Calls made while a lookup is in flight share it.
  function ensureChannel(card, cb) {
    var ch = card && card.getAttribute('data-channel');
    if (ch) { if (cb) cb({ channelId: ch, channel: card.getAttribute('data-channel-name') || '' }); return; }
    var vid = videoIdOf(card);
    if (!vid) { if (cb) cb(null); return; }
    if (chanOfCache[vid] !== undefined) {
      var hit = chanOfCache[vid];
      applyChannel(card, hit);
      if (cb) cb(hit);
      return;
    }
    if (chanOfBusy[vid]) { if (cb) chanOfBusy[vid].push(cb); return; }
    var waiters = chanOfBusy[vid] = cb ? [cb] : [];
    fetch('/api/channel-of?id=' + encodeURIComponent(vid), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var data = j && j.channelId
          ? { channelId: j.channelId, channel: j.channel || '' }
          : null;
        // Do not cache a miss: a transient failure should be retried on the
        // next hold instead of hiding "Go to channel" for the whole session.
        if (data) chanOfCache[vid] = data;
        delete chanOfBusy[vid];
        applyChannel(card, data);
        for (var i = 0; i < waiters.length; i++) waiters[i](data);
      })
      .catch(function () {
        delete chanOfBusy[vid];
        for (var i = 0; i < waiters.length; i++) waiters[i](null);
      });
  }
  function holdEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function closeHold(refocus) {
    if (holdEl && holdEl.parentNode) holdEl.parentNode.removeChild(holdEl);
    holdEl = null;
    var c = holdCard;
    holdCard = null;
    holdFired = false;
    holdWaitRelease = false;
    if (holdChanTimer) { clearTimeout(holdChanTimer); holdChanTimer = null; }
    if (refocus && c) { try { c.focus(); } catch (e) {} }
  }
  // Insert the channel row at the top of an open menu. Safe to call again.
  function addChannelRow(el, ch, focusIt) {
    if (!el || !ch || el.querySelector('[data-act="channel"]')) return null;
    var row = document.createElement('button');
    row.className = 'row';
    row.setAttribute('data-act', 'channel');
    row.innerHTML = '<span>Go to channel</span><span class="chk">›</span>';
    var first = el.querySelector('.row');
    el.insertBefore(row, first || null);
    if (focusIt) { try { row.focus(); } catch (e) {} }
    return row;
  }
  function openHold(card) {
    closeHold(false);
    holdCard = card;
    var ch = card.getAttribute('data-channel') || '';
    var title = card.querySelector('.t');
    var el = document.createElement('div');
    el.className = 'holdmenu';
    el.innerHTML =
      '<div class="holdtitle">' + holdEsc(title ? title.textContent : '') + '</div>' +
      '<button class="row" data-act="play"><span>Play video</span><span class="chk">OK</span></button>' +
      '<button class="row" data-act="cancel"><span>Cancel</span><span class="chk">Back</span></button>';
    document.body.appendChild(el);
    holdEl = el;
    if (ch) addChannelRow(el, ch, true);
    el.addEventListener('click', function (e) {
      var b = e.target;
      while (b && b !== el && !(b.getAttribute && b.getAttribute('data-act'))) b = b.parentNode;
      var act = b && b.getAttribute ? b.getAttribute('data-act') : '';
      if (act === 'channel') {
        var cc = holdCard ? holdCard.getAttribute('data-channel') : '';
        if (cc) window.location.href = '/channel?id=' + encodeURIComponent(cc);
        return;
      }
      if (act === 'play') {
        var c = holdCard;
        closeHold(false);
        if (c) c.click();
        return;
      }
      closeHold(true);
    });
    if (!ch) {
      // The lookup usually finished during the hold (it starts 250 ms in). If
      // not, slot the row in when it lands; keep an already-moved focus put.
      ensureChannel(card, function (data) {
        if (!data || !holdEl || holdCard !== card) return;
        var was = document.activeElement;
        var play = holdEl.querySelector('[data-act="play"]');
        var row = addChannelRow(holdEl, data.channelId, false);
        if (row && (!was || was === document.body || was === play)) {
          try { row.focus(); } catch (e) {}
        }
      });
    }
    var first = el.querySelector('.row');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  document.addEventListener('keydown', function (e) {
    if (document.body.classList.contains('cinema')) return;

    if (holdEl) {
      var hk = keyOf(e);
      if (hk === 'back') {
        e.preventDefault();
        e.stopPropagation();
        closeHold(true);
        return;
      }
      var hrows = holdEl.querySelectorAll('.row');
      if (hk === 'up' || hk === 'down') {
        e.preventDefault();
        e.stopPropagation();
        if (hrows.length) {
          var hi = Array.prototype.indexOf.call(hrows, document.activeElement);
          var hd = hk === 'down' ? 1 : -1;
          if (hi < 0) hi = hd > 0 ? -1 : 0;
          var hn = hrows[Math.max(0, Math.min(hrows.length - 1, hi + hd))];
          if (hn) hn.focus();
        }
        return;
      }
      if (isOkKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        // Still the same held OK that opened this menu: its key repeats must
        // not choose anything. Wait for the release (see keyup below).
        if (holdWaitRelease) return;
        if (document.activeElement && /row/.test(document.activeElement.className)) {
          document.activeElement.click();
        } else if (hrows.length) {
          hrows[0].click();
        }
        return;
      }
      if (hk) { e.preventDefault(); e.stopPropagation(); }
      return;
    }

    var ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('card')) {
      if (holdCard && !isOkKey(e)) {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = null;
        if (holdChanTimer) { clearTimeout(holdChanTimer); holdChanTimer = null; }
        holdCard = null;
        holdFired = false;
      }
      if (isOkKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        holdCard = ae;
        holdFired = false;
        holdAt = Date.now();
        // Start the channel lookup only once this looks like a hold: a short
        // tap never pays for it, and by 700 ms the answer is usually ready.
        if (holdChanTimer) clearTimeout(holdChanTimer);
        holdChanTimer = setTimeout(function () {
          holdChanTimer = null;
          if (holdCard === ae) ensureChannel(ae);
        }, 250);
        holdTimer = setTimeout(function () {
          holdTimer = null;
          if (!holdCard) return;
          holdFired = true;
          openHold(holdCard);
          holdWaitRelease = true;
        }, 700);
      }
    }
  }, true);

  document.addEventListener('keyup', function (e) {
    if (isOkKey(e) && holdWaitRelease) {
      // The long press that opened the menu is over. Swallow this release so
      // it cannot also activate the focused row.
      holdWaitRelease = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isOkKey(e) && holdEl) {
      // A fresh OK press already activated the focused row on keydown. Swallow
      // the browser's synthetic click on keyup so it cannot fire twice.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!holdCard || holdEl || !isOkKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdChanTimer) { clearTimeout(holdChanTimer); holdChanTimer = null; }
    var card = holdCard;
    var fired = holdFired;
    var held = Date.now() - holdAt;
    holdCard = null;
    holdFired = false;
    if (fired) return;
    if (held >= 600) {
      // The timer was throttled behind a busy page; the viewer still held OK
      // long enough for the menu, so open it now instead of playing the video.
      openHold(card);
      holdWaitRelease = false;
      return;
    }
    if (card) card.click();
  }, true);

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

  // --- watch progress ---------------------------------------------------
  // The player saves {t,d} per video under tubetv.hist; this paints the red
  // "watched" bar under each thumbnail. Done here (not in the server HTML) so
  // the grid updates the instant you come back from a video, and appended
  // pages get the same treatment.
  var HKEY = 'tubetv.hist';
  // YouTube's own resume positions arrive inlined with the page. Both sources
  // are merged exactly like the player does, so the bar matches what pressing
  // the tile will actually do (see resumeOf below).
  var Y = window.TUBETV_YT_PROGRESS || {};
  var ytReq = false;

  function histLoad() {
    try {
      var h = JSON.parse(localStorage.getItem(HKEY) || '{}');
      return h && typeof h === 'object' ? h : {};
    } catch (e) { return {}; }
  }

  // These four helpers are deliberate line-for-line copies of the player's
  // resume rules (public/player.js: rawPosOf, resumePosOf, localBlocksYt and
  // the merge in restorePosition). The tile may only paint a bar for a video
  // the player will actually resume; if the two disagree you get a red bar
  // under a video that then starts at 0:00. Change both files together.
  function rawPosOf(r) {
    if (!r) return 0;
    var t = Number(r.t) || 0;
    var d = Number(r.d) || 0;
    var p = Number(r.p) || 0;
    if (!(t > 0) && p > 0 && d > 0) t = Math.round((d * p) / 100);
    return Math.max(0, Math.round(t));
  }

  function resumePosOf(r) {
    if (!r) return null;
    var d = Number(r.d) || 0;
    var t = Number(r.t) || 0;
    var p = Number(r.p) || 0;
    if (!(t > 0) && p > 0 && d > 0) t = Math.round((d * p) / 100);
    if (!(t > 0)) return null;
    if (p >= 95) return null;
    if (t <= 30) return null;
    if (d > 0 && t >= d - 30) return null;
    return { t: Math.round(t), d: Math.round(d) };
  }

  // A local record can deliberately mean "start from the top" (finished,
  // within 30 s of either end, or restarted and barely watched). In that case
  // YouTube's older middle position must not be shown or used.
  function localBlocksYt(r) {
    if (!r) return false;
    if (r.done) return true;
    var raw = rawPosOf(r);
    var d = Number(r.d) || 0;
    if (d > 0 && raw >= d - 30) return true;
    if (raw > 0 && raw <= 30) return true;
    return !resumePosOf(r);
  }

  // The exact position the player will open with, or null when it starts from
  // the top. Mirrors restorePosition: the further valid position wins unless
  // the local record is terminal.
  function resumeOf(local, yt) {
    if (localBlocksYt(local)) return null;
    var lp = resumePosOf(local);
    var yp = resumePosOf(yt);
    var pos = null;
    if (yp && (!lp || yp.t >= lp.t + 15)) pos = yp;
    else if (lp) pos = lp;
    else if (yp) pos = yp;
    if (!pos) return null;
    // A position without a duration cannot be drawn as a percentage. Fall
    // back to whichever record still knows the length.
    var d = pos.d || Number(local && local.d) || Number(yt && yt.d) || 0;
    if (!(d > 0)) return null;
    return { t: pos.t, d: d };
  }

  function percent(r) {
    if (!r) return 0;
    var p = (r.t / r.d) * 100;
    return p < 2 ? 2 : p > 99 ? 99 : p;
  }

  function paint() {
    var cards = document.querySelectorAll('a.card[href]');
    if (!cards.length) return;
    var h = histLoad();
    for (var i = 0; i < cards.length; i++) {
      var m = /[?&]id=([^&]+)/.exec(cards[i].getAttribute('href') || '');
      if (!m) continue;
      var vid = decodeURIComponent(m[1]);
      var rec = resumeOf(h[vid], Y[vid]);
      var thumb = cards[i].querySelector('.thumb');
      if (!thumb) continue;
      var bar = thumb.querySelector('.wbar');
      var p = percent(rec);
      if (!p) {
        if (bar) thumb.removeChild(bar);
        continue;
      }
      if (!bar) {
        bar = document.createElement('span');
        bar.className = 'wbar';
        bar.appendChild(document.createElement('i'));
        thumb.appendChild(bar);
      }
      bar.firstChild.style.width = p.toFixed(1) + '%';
    }
  }

  // A cold server cache means the page was rendered before the first history
  // fetch finished. Ask once; subsequent pages carry the map inline. When the
  // TV app comes back to the foreground, force a one-page refresh: if the
  // viewer watched further on a phone while the TV was away, their newer
  // position must be visible before the next tile is pressed.
  var ytAt = Date.now();
  function refreshYt(force) {
    if (ytReq || !window.TUBETV_SIGNED_IN) return;
    if (!force && Object.keys(Y).length) return;
    if (force && Date.now() - ytAt < 60000) return;
    ytReq = true;
    ytAt = Date.now();
    fetch('/api/progress' + (force ? '?force=1&pages=1' : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.map && typeof j.map === 'object') {
          Y = j.map;
          window.TUBETV_YT_PROGRESS = Y;
          paint();
        }
      })
      .catch(function () {})
      .then(function () { ytReq = false; });
  }

  window.tubetvProgress = {
    load: histLoad,
    paint: paint,
    setYt: function (m) { Y = m || {}; window.TUBETV_YT_PROGRESS = Y; paint(); },
  };
  paint();
  refreshYt();
  window.addEventListener('load', paint);
  window.addEventListener('pageshow', function (e) { if (e.persisted) paint(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshYt(true);
  });
  window.addEventListener('focus', function () { refreshYt(true); });

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
  var channel = more.getAttribute('data-channel') || '';
  var loading = false;
  var misses = 0;
  var maxMisses = 10;
  var failures = 0;
  var triedRefresh = false;
  // A TV scroll/focus burst fires many events per second. Without a throttle
  // each one can start another continuation request as soon as the previous
  // page lands, which made the history feed walk dozens of pages while the
  // viewer was only moving a few tiles. One page per second is plenty.
  var lastLoadAt = 0;
  var lastCheck = 0;

  function nearEnd() {
    var last = grid.lastElementChild;
    if (!last) return false;
    var r = last.getBoundingClientRect();
    return r.top < window.innerHeight + 800;
  }

  // The saved continuation token can go stale while the TV sits on the grid
  // for hours. The server can rebuild one from a fresh first page; ask it to
  // do that once instead of leaving the viewer at a dead end.
  function recover() {
    if (triedRefresh) return false;
    triedRefresh = true;
    failures = 0;
    load(true);
    return true;
  }

  function load(refresh) {
    if (loading) return;
    if (!refresh && (!token || misses >= maxMisses || failures >= 3)) return;
    if (!refresh && Date.now() - lastLoadAt < 1000) return;
    lastLoadAt = Date.now();
    loading = true;
    var prevToken = token;
    var url = '/api/more?kind=' + encodeURIComponent(kind) +
      (channel ? '&channel=' + encodeURIComponent(channel) : '') +
      (refresh ? '&refresh=1' : '&token=' + encodeURIComponent(token));
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        loading = false;
        if (!j || j.error) {
          // Keep the token: one 502 from YouTube's continuation endpoint used
          // to clear it, which made the TV grid a dead end until a full page
          // reload. Retry the same token a couple of times first.
          if (refresh) { token = ''; return; }
          failures++;
          if (failures >= 3) { if (recover()) return; token = ''; }
          else setTimeout(maybe, 1200);
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
        if (window.tubetvProgress) window.tubetvProgress.paint();
        token = j.token || '';
        if (added) {
          misses = 0;
          maxMisses = 10;
          failures = 0;
          setTimeout(maybe, 400);
        } else if (refresh && token && token !== prevToken) {
          // A fresh page 2 can be entirely made of cards the viewer already
          // has. Keep walking with the fresh token (dedupe drops duplicates)
          // until new cards appear or a few pages come back empty.
          misses = 0;
          maxMisses = 15;
          setTimeout(maybe, 600);
        } else if (refresh) {
          token = '';
        } else if (token && token !== prevToken) {
          // The continuation hopped to another (often all-Shorts) shelf and
          // handed back a fresh token. Keep going instead of stopping at the
          // first empty page, which is what made the TV grid look like it had
          // lost infinite scroll.
          setTimeout(maybe, 800);
        } else {
          misses++;
        }
      })
      .catch(function () {
        loading = false;
        if (refresh) { token = ''; return; }
        failures++;
        if (failures >= 3) { if (!recover()) token = ''; }
        else setTimeout(maybe, 1500);
      });
  }

  function maybe() {
    var now = Date.now();
    if (now - lastCheck < 700) return;
    lastCheck = now;
    if (nearEnd()) load();
  }

  window.addEventListener('scroll', maybe);
  document.addEventListener('focusin', maybe);
  window.addEventListener('load', maybe);
  // Some TV browsers do not emit scroll for remote-driven focus moves. Poll
  // while the grid is still visible near the bottom so the feed never remains
  // a dead end.
  setInterval(maybe, 2500);
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
        <div class="prog" id="prog" tabindex="0"><div id="progfill"></div></div>
        <div class="btns">
          <button class="ctl" id="ctlplay">Pause</button>
          <button class="ctl" id="ctlgear">Quality</button>
          <button class="ctl" id="ctlcmt">Comments</button>
          <button class="ctl" id="ctlrel">Suggested</button>
          <button class="chanrow" id="chanrow">
            <img class="chanav" id="chanimg" alt="" style="display:none">
            <span class="channame" id="channame">Channel</span>
            <span class="chansubs" id="chansubs"></span>
            <span class="changoto">Go to channel ›</span>
          </button>
        </div>
      </div>
      <div class="endscreen hide" id="endscreen" tabindex="-1">
        <div class="endscreen-head">
          <span>Up next</span>
          <span class="panel-hint">Arrow keys to choose · OK to play · Back to close</span>
        </div>
        <div class="endscreen-grid" id="endgrid"></div>
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

export function page({ title, body, active = '', signedIn = false, extraHead = '', cinema = false, ytProgress = null }) {
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
  // The signed-in history resume map rides along with the page so the grid and
  // the player can use it without an extra request. It is small (a few KB) and
  // contains only video ids, percentages and second offsets.
  const progressJson = ytProgress && typeof ytProgress === 'object'
    ? JSON.stringify(ytProgress).replace(/</g, '\\u003c')
    : '{}';
  const progressScript =
    `<script>window.TUBETV_SIGNED_IN=${signedIn ? 'true' : 'false'};` +
    `window.TUBETV_YT_PROGRESS=${progressJson};</script>`;

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
${progressScript}
<script>${NAV_JS}</script>
<script>${MORE_JS}</script>
<script src="/player.js"></script>
</body>
</html>`;
}

export function card(v) {
  const meta = [v.channel, v.views].filter(Boolean).join(' · ');
  // Same-origin thumbnails: VIDAA's browser was dropping every third-party
  // image. onerror steps down to the small, always-available variant.
  const id = esc(v.id);
  const img = `/api/thumb?id=${encodeURIComponent(v.id)}&q=hq720`;
  const fallback = `/api/thumb?id=${encodeURIComponent(v.id)}&q=mqdefault`;
  const ch = v.channelId
    ? ` data-channel="${esc(v.channelId)}" data-channel-name="${esc(v.channel || '')}"`
    : '';
  return `<a class="card" href="/watch?id=${id}"${ch}>
  <div class="thumb">
    <img src="${img}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${fallback}'">
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

export function channelHead(info) {
  const i = info || {};
  const meta = [i.handle, i.subs, i.videos].filter(Boolean).join(' · ');
  const avatar = i.avatar
    ? `<img src="/api/img?u=${encodeURIComponent(i.avatar)}" alt="" onerror="this.onerror=null;this.style.display='none'">`
    : '<div class="chav"></div>';
  return `<div class="chhead">
  ${avatar}
  <div class="chinfo">
    <h1>${esc(i.title || 'Channel')}</h1>
    ${meta ? `<div class="chsub">${esc(meta)}</div>` : ''}
    ${i.description ? `<div class="chdesc">${esc(i.description)}</div>` : ''}
  </div>
</div>`;
}

export function grid(videos, more) {
  const cards = videos.length
    ? videos.map(card).join('')
    : '<div class="empty">Nothing here yet.</div>';
  const ch = more && more.channel
    ? ` data-channel="${esc(more.channel)}"`
    : '';
  const marker =
    more && more.token
      ? `<div id="more" data-kind="${esc(more.kind || 'home')}" data-token="${esc(more.token)}"${ch}></div>`
      : '';
  return `<div class="grid" id="grid">${cards}</div>${marker}`;
}
