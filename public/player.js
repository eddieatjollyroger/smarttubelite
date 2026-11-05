// TubeTV player.
//
// Loaded on every page. On a grid page it owns the hidden #stage overlay and
// opens videos *without navigating*, so the OK press that picked the tile is
// still a live user gesture when playback starts — that is what lets the
// browser unmute and go fullscreen (the same trick Jellyfin/Plex use).
// On /watch it boots directly, so deep links and reloads still work.
(function () {
  var v = document.getElementById('v');
  if (!v) return; // page without player markup

  var a = document.getElementById('a');
  var err = document.getElementById('err');
  var ttl = document.getElementById('title');
  var startBtn = document.getElementById('start');
  var hud = document.getElementById('hud');
  var ov = document.getElementById('ov');
  var bar = document.getElementById('ovb');
  var backBtn = document.getElementById('back');
  var clock = document.getElementById('clock');
  var prog = document.getElementById('prog');
  var progfill = document.getElementById('progfill');
  var playBtn = document.getElementById('ctlplay');
  var gearBtn = document.getElementById('ctlgear');
  var cmtBtn = document.getElementById('ctlcmt');
  var ctlBtns = [playBtn, gearBtn, cmtBtn];
  var panel = document.getElementById('panel');
  var panelTitle = document.getElementById('paneltitle');
  var panelBody = document.getElementById('panelbody');
  var stage = document.getElementById('stage');

  var tiers = [{ h: 720 }, { h: 480 }, { h: 360 }, { muxed: 1 }];
  var tier = 0;
  var resumeAt = 0;
  var userPaused = false;
  var soundBlocked = false;
  var hudTimer = null;
  var barTimer = null;
  var barOn = false;
  var panelKind = null;
  var cmtToken = null;
  var cmtLoading = false;
  var lastClock = '';
  var started = false;
  var isLive = false;
  var curHeights = null;
  var hls = null;
  var hlsOff = false;
  var hlsFatalRetries = 0;
  var hlsFatalBusy = false;
  var liveRetries = 0;
  var watchdog = null;
  var id = '';
  var active = false;
  var switching = false;
  var loadSeq = 0;
  var abortRetries = 0;
  var freshRetries = 0;
  var lastTime = 0;
  var audioRetries = 0;
  var audioGaveUp = false;
  var forceFresh = false;
  var forceAvc = false;
  var lastAnchor = null;
  var pushed = false;
  var lastScroll = 0;
  var prefetchTimer = null;
  var rampTimer = null;
  var prefetchId = '';
  var prefetchBusy = false;
  var prefetchQueued = '';
  var pinnedH = 0;
  var loadTimer = null;
  var loadStartedAt = 0;

  // YouTube only offers 1440p/2160p as VP9. Ask the browser once; if it can't
  // decode VP9 in MSE, /api/play never mentions those levels and the 4K quality
  // entries simply do not exist for this TV.
  var supportsVp9 = false;
  try {
    supportsVp9 = !!(window.MediaSource && (
      MediaSource.isTypeSupported('video/mp4; codecs="vp09.00.51.08"') ||
      MediaSource.isTypeSupported('video/mp4; codecs="vp09.00.50.08"')
    ));
  } catch (e) {}

  var CINEMA_PAGE = document.body.classList.contains('cinema');

  // The tile OK press is a real user gesture. If it is still active when the
  // stream is ready, start with sound instead of muting first and unmuting late
  // (VIDAA dislikes that dance). Prefetching keeps the gap short.
  function hasGesture() {
    try {
      var ua = navigator.userActivation;
      if (!ua) return false;
      // isActive is the ~5 s transient window: far shorter than a cold yt-dlp
      // resolve on the Pi. Chromium (VIDAA included) grants unmuted playback
      // for the rest of the page once the viewer has pressed any key, which is
      // what hasBeenActive records — the tile OK still counts.
      return !!(ua.isActive || ua.hasBeenActive);
    } catch (e) {
      return false;
    }
  }

  // Highest quality first, then everything below it, then the split fallback.
  function makeTiers(top) {
    var out = [{ h: top }];
    var all = [1080, 720, 480, 360];
    for (var i = 0; i < all.length; i++) {
      if (all[i] < top) out.push({ h: all[i] });
    }
    out.push({ muxed: 1 });
    return out;
  }

  // Closest HLS level at or below h; the lowest level if h is smaller than
  // everything on offer. -1 when hls.js is not driving the element.
  function levelIndexFor(h) {
    if (!hls || !hls.levels || !hls.levels.length) return -1;
    var best = -1;
    var bestH = -1;
    for (var i = 0; i < hls.levels.length; i++) {
      var lh = hls.levels[i].height || 0;
      if (lh > 0 && lh <= h && lh > bestH) { bestH = lh; best = i; }
    }
    if (best < 0) {
      for (var j = 0; j < hls.levels.length; j++) {
        var jh = hls.levels[j].height || 0;
        if (best < 0 || jh < (hls.levels[best].height || 0)) best = j;
      }
    }
    return best;
  }

  // Highest level ABR may climb to on its own. The master contains 1440p/2160p
  // only when this TV reported VP9 support, so the ceiling is simply the best
  // level on offer: 4K when the link and decoder keep up, otherwise ABR stays
  // lower by itself. A pinned 4K that cannot keep up is dropped by the watchdog.
  function autoCapIndex() {
    if (!hls || !hls.levels) return -1;
    var best = -1;
    var bestH = 0;
    for (var i = 0; i < hls.levels.length; i++) {
      var lh = hls.levels[i].height || 0;
      if (lh > 0 && lh >= bestH) { bestH = lh; best = i; }
    }
    return best;
  }

  // Lowest level in the current master. The master only carries one codec
  // family now, so this is the safe floor to hold briefly after a 4K stall.
  function lowestCap() {
    if (!hls || !hls.levels) return -1;
    var best = -1;
    var bestH = 0;
    for (var i = 0; i < hls.levels.length; i++) {
      var lh = hls.levels[i].height || 0;
      if (lh > 0 && (best < 0 || lh < bestH)) { bestH = lh; best = i; }
    }
    return best;
  }

  function isVp9Stream() {
    if (!hls || !hls.levels) return false;
    for (var i = 0; i < hls.levels.length; i++) {
      if (/^vp0?9/i.test(String(hls.levels[i].videoCodec || ''))) return true;
    }
    return false;
  }

  function clearRamp() {
    if (rampTimer) {
      clearTimeout(rampTimer);
      rampTimer = null;
    }
  }

  // Hand quality back to ABR without hls.js's *immediate* switch. Setting
  // currentLevel pauses the element and flushes the buffer, which is the black
  // screen seen when the 720p start released to ABR. loadLevel just clears the
  // manual pick; ABR switches at the next fragment while playback continues.
  function releaseAuto(cap) {
    clearRamp();
    try { hls.autoLevelCapping = cap; } catch (e) {}
    try { hls.loadLevel = -1; } catch (e) {}
  }

  // Hold ABR at a safe level briefly after a stall, then let it use the whole
  // current master again. Raising the cap keeps switches at fragment
  // boundaries; the master has one codec family, so there is no codec change.
  function rampUp(fullCap) {
    clearRamp();
    rampTimer = setTimeout(function () {
      rampTimer = null;
      if (pinnedH || !hls || isLive || v.ended) return;
      try { hls.autoLevelCapping = fullCap; } catch (e) {}
      report('abr-step', { h: (hls.levels[fullCap] || {}).height || 0 });
    }, 8000);
  }

  // Distinct live resolutions, best first. hls.js can expose the same height
  // twice (different codecs/bitrates in YouTube's live master), which would
  // otherwise produce duplicate rows in the quality sheet.
  function hlsHeights() {
    if (!hls || !hls.levels) return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < hls.levels.length; i++) {
      var h = hls.levels[i].height || 0;
      if (h > 0 && !seen[h]) { seen[h] = 1; out.push(h); }
    }
    return out.sort(function (a, b) { return b - a; });
  }

  // Warm the server's yt-dlp cache while the viewer browses the grid. The real
  // play request shares the in-flight resolve, so OK starts almost instantly.
  function prefetchHeight() {
    var t = tiers[tier] || tiers[0] || { h: 720 };
    return t.h || 720;
  }

  function prefetch(vid) {
    if (!vid || vid === prefetchId) return;
    // One yt-dlp run at a time on the Pi; remember only the latest tile the
    // remote stopped on.
    if (prefetchBusy) { prefetchQueued = vid; return; }
    prefetchId = vid;
    prefetchBusy = true;
    var u = '/api/play?prefetch=1&hls=1&id=' + encodeURIComponent(vid) +
      '&h=' + prefetchHeight();
    var done = function () {
      prefetchBusy = false;
      var next = prefetchQueued;
      prefetchQueued = '';
      if (next && next !== prefetchId) prefetch(next);
    };
    try {
      fetch(u, { cache: 'no-store' }).then(done, done);
    } catch (e) { done(); }
  }

  function schedulePrefetch(vid) {
    if (!vid || vid === prefetchId) return;
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(function () { prefetch(vid); }, 300);
  }

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
    stopElapsed();
    err.textContent = msg;
    err.style.display = 'block';
    report('error', { msg: msg, tier: tier, rs: v.readyState, ns: v.networkState,
      code: v.error ? v.error.code : 0, acode: a.error ? a.error.code : 0 });
  }

  // ms = how long to show it. `true` still means "keep it up", but almost
  // nothing should: a status that outlives the control bar looks like a bug.
  function hint(msg, ms) {
    hud.textContent = msg;
    hud.className = 'hud';
    if (hudTimer) clearTimeout(hudTimer);
    if (ms === true) return;
    var d = typeof ms === 'number' ? ms : 5000;
    hudTimer = setTimeout(function () { hud.className = 'hud hide'; }, d);
  }

  // A cold yt-dlp resolve used to take 20 s with no feedback, which looks like
  // a frozen TV. Count the seconds in the HUD so the wait is obviously alive.
  function startElapsed() {
    stopElapsed();
    loadStartedAt = Date.now();
    hint('Starting… 0s', true);
    loadTimer = setInterval(function () {
      if (!active || started) { stopElapsed(); return; }
      var s = Math.max(1, Math.round((Date.now() - loadStartedAt) / 1000));
      hint('Starting… ' + s + 's', true);
    }, 1000);
  }

  function stopElapsed() {
    if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
  }

  function fmt(s) {
    s = Math.floor(s || 0);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  // --- chrome (title bar + control bar) ---------------------------------
  function setBar(on) {
    barOn = on;
    ov.className = on ? 'ov' : 'ov hide';
    bar.className = on ? 'ovb' : 'ovb hide';
    // The time readout belongs to the control bar, not to the picture.
    clock.className = on ? 'clock' : 'clock hide';
    if (!on) {
      try { document.activeElement.blur(); } catch (e) {}
    }
  }

  function chrome() {
    if (!active) return;
    setBar(true);
    if (barTimer) clearTimeout(barTimer);
    barTimer = setTimeout(function () {
      if (!v.paused && !panelKind) setBar(false);
    }, 5000);
  }

  function focusBtn(i) {
    if (i < 0) i = 0;
    if (i > ctlBtns.length - 1) i = ctlBtns.length - 1;
    var b = ctlBtns[i];
    if (b) b.focus();
  }

  function syncPlayLabel() {
    playBtn.textContent = v.paused ? 'Play' : 'Pause';
  }

  function fullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen ||
             el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!fn) return false;
    try {
      var p = fn.call(el);
      if (p && p.then) {
        p.then(
          function () { report('fullscreen', { ok: true }); },
          function (e) { report('fullscreen', { ok: false, name: (e && e.name) || '?' }); }
        );
      }
      return true;
    } catch (e) { return false; }
  }

  // TV browsers normally require a user gesture before real fullscreen. On a
  // grid page the tile press is still active here, so this usually works.
  var fsTried = false;
  function fullscreenOnce() {
    if (fsTried || document.fullscreenElement || document.webkitFullscreenElement) return;
    fsTried = true;
    fullscreen();
  }

  // --- playback ---------------------------------------------------------
  // Start muted (always allowed), then try to switch sound on in the same
  // gesture window. If the browser refuses, keep playing muted rather than
  // parking the user on a Play button.
  function tryPlay() {
    var seq = loadSeq;
    var p;
    try { p = v.play(); } catch (e) { p = null; }
    if (!p || !p.then) {
      startBtn.style.display = 'none';
      maybeUnmute();
      return;
    }
    p.then(function () {
      if (seq !== loadSeq) return;
      abortRetries = 0;
      startBtn.style.display = 'none';
      report('playing', { tier: tier, muted: v.muted });
      maybeUnmute();
    }).catch(function (e) {
      if (seq !== loadSeq) return;
      var name = (e && e.name) || '?';
      report('autoplay-blocked', { name: name, muted: v.muted });
      // A play() racing a load reports AbortError; that is not a policy block.
      if (name === 'AbortError' && abortRetries++ < 3) {
        setTimeout(function () { if (seq === loadSeq) tryPlay(); }, 400);
        return;
      }
      abortRetries = 0;
      if (!v.muted) {
        // The failure may just be the sound: muted playback is always allowed.
        // Do not let maybeUnmute() immediately retry the unmute that was just
        // refused — one OK from the viewer will clear this.
        soundBlocked = true;
        v.muted = true;
        if (a.src) a.muted = true;
        setTimeout(function () { if (seq === loadSeq) tryPlay(); }, 250);
        return;
      }
      startBtn.style.display = 'inline-block';
      setTimeout(function () {
        if (seq === loadSeq && v.paused && !userPaused) tryPlay();
      }, 2000);
    });
  }

  function maybeUnmute() {
    if (!v.muted || soundBlocked) return;
    // Never turn sound on after the OK gesture has expired. That late unmute is
    // exactly what preceded VIDAA's media-stack hang; instead keep playing
    // (muted is always allowed) and let one OK press enable sound.
    if (!hasGesture()) {
      soundBlocked = true;
      hint('Sound off — press OK for sound', 9000);
      return;
    }
    v.muted = false;
    if (a.src) { a.muted = false; a.volume = v.volume; }
    setTimeout(function () {
      if (v.paused && !userPaused) {
        soundBlocked = true;
        v.muted = true;
        if (a.src) a.muted = true;
        retryMuted();
        hint('Sound off — press OK for sound', 9000);
      }
    }, 700);
  }

  function unmute() {
    soundBlocked = false;
    v.muted = false;
    if (a.src) { a.muted = false; a.volume = v.volume; }
  }

  // Chrome/VIDAA can pause a stream on its own (unmute without activation, a
  // stalled fragment, a decoder reset). Players like Jellyfin simply resume;
  // do the same unless the viewer asked for a pause.
  function retryMuted() {
    if (!active || !started || userPaused || v.ended) return;
    // A hidden page (background tab, TV screensaver) legitimately pauses
    // media; do not fight it or it looks like a stall and steps quality down.
    if (document.hidden) return;
    try {
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
    if (a.src) {
      try {
        var q = a.play();
        if (q && q.catch) q.catch(function () {});
      } catch (e) {}
    }
  }

  function attach(info) {
    stopElapsed();
    hint('Starting…', 8000);
    started = true;
    abortRetries = 0;
    audioGaveUp = false;
    curHeights = info.heights || null;
    ttl.textContent = info.title || id;
    document.title = (info.title || 'TubeTV') + ' · TubeTV';
    v.muted = !hasGesture();
    v.src = info.video;
    if (info.audio) {
      a.src = info.audio;
      a.muted = v.muted;
      a.volume = v.volume;
    }
    report('attached', { tier: tier, h: info.height, codec: info.vcodec, audio: !!info.audio, mode: active ? 'overlay' : 'page' });
    startWatchdog();
    tryPlay();
    chrome();
    setTimeout(fullscreen, 600);
  }

  function loadHlsJs(cb) {
    if (window.Hls) return cb();
    var s = document.createElement('script');
    s.src = '/hls.js';
    s.onload = cb;
    s.onerror = function () { showErr('Could not load the live player (hls.js).'); };
    document.head.appendChild(s);
  }

  function attachHls(info, live) {
    stopElapsed();
    started = true;
    isLive = !!live;
    liveRetries = 0;
    // Resolutions came with /api/play, so the cogwheel can paint instantly
    // instead of waiting on another yt-dlp run.
    curHeights = (!live && info.heights && info.heights.length) ? info.heights : null;
    ttl.textContent = info.title || (live ? 'Live' : id);
    document.title = (info.title || (live ? 'Live' : 'TubeTV')) + ' · TubeTV';
    prog.style.display = live ? 'none' : 'block';
    if (live) hint('LIVE', 4000);
    v.muted = !hasGesture();
    report(live ? 'live-attach' : 'hls-attach', {
      hasMSE: typeof window.MediaSource !== 'undefined',
      h: info.height,
      mode: info.mode
    });

    function fallback(why) {
      if (live) return;
      resumeAt = lastTime || v.currentTime || 0;
      // A VP9 master that keeps failing should fall back to H.264 HLS (≤1080)
      // before abandoning MSE entirely. That keeps the quality sheet and
      // seeking, and is much better than the progressive split path.
      if (supportsVp9 && !forceAvc && isVp9Stream()) {
        forceAvc = true;
        hlsFatalRetries = 0;
        hlsFatalBusy = false;
        hlsOff = false;
        pinnedH = 0;
        try { localStorage.removeItem('tubetv.h'); } catch (e) {}
        report('hls-avc-fallback', { why: why, at: resumeAt });
        loadSeq++;
        teardown();
        userPaused = false;
        load();
        return;
      }
      hlsOff = true;
      report('hls-fallback', { why: why, at: resumeAt });
      loadSeq++;
      teardown();
      userPaused = false;
      load();
    }

    if (window.MediaSource) {
      loadHlsJs(function () {
        if (!window.Hls || !window.Hls.isSupported()) {
          if (live) showErr('This browser has MediaSource but hls.js cannot use it.');
          else fallback('unsupported');
          return;
        }
        var cfg = {
          enableWorker: false,
          lowLatencyMode: false,
          // 4K is the automatic ceiling too. Capping by element size would
          // hide the 2160p level from a TV whose browser reports a 1080p CSS
          // viewport; autoCapIndex() below is the real ABR ceiling.
          capLevelToPlayerSize: false,
          // A 4K-capable TV still needs a sane first guess. 2 Mbps made ABR
          // start at 360p and crawl upward for 10-15 s; 4 Mbps starts around
          // 720p and still steps down fast on a weak link.
          abrEwmaDefaultEstimate: 4000000,
          // TV browsers have little spare memory. Keep the MSE buffer small;
          // hls.js evicts old fragments as playback advances.
          maxBufferLength: 20,
          maxMaxBufferLength: 30,
          backBufferLength: 30,
          maxBufferSize: 40 * 1000 * 1000,
          // Fetch the first fragment while the manifest is still settling;
          // saves a round trip on a cold start.
          startFragPrefetch: true
        };
        // Four fragments of slack keeps a live stream alive through a Wi-Fi
        // hiccup; three was tight enough to stall on the TV.
        if (live) cfg.liveSyncDurationCount = 4;
        hls = new window.Hls(cfg);
        window.__hls = hls;
        hls.on(window.Hls.Events.ERROR, function (ev, data) {
          report('hls-error', { type: data.type, details: data.details, fatal: !!data.fatal });
          if (!data.fatal) {
            // bufferStalledError just means "waiting for the next fragment" and
            // hls.js fixes it itself. Calling recoverMediaError() here (as .4
            // did for every media error) tears the SourceBuffer down mid-play —
            // that is what made playback stop every few seconds.
            if (data.details === 'bufferStalledError') return;
            if (data.type === 'mediaError' &&
                /buffer(Append|AddCodec|Incompatible)/i.test(String(data.details || ''))) {
              try { hls.recoverMediaError(); } catch (e) {}
            }
            return;
          }
          if (hlsFatalBusy) return;

          if (isLive) {
            if (liveRetries < 4 && (data.type === 'networkError' || data.type === 'mediaError')) {
              liveRetries++;
              report('live-retry', { details: data.details, n: liveRetries });
              setTimeout(function () {
                try {
                  if (data.type === 'mediaError') hls.recoverMediaError();
                  else hls.startLoad();
                } catch (e) {}
                retryMuted();
              }, 400);
              return;
            }
            showErr('Live stream failed: ' + data.details);
            return;
          }

          // VOD: a stale playlist URL is the most common fatal error. Re-resolve
          // once, then give up on MSE and use the split fallback at the same
          // position rather than losing the viewer's place.
          hlsFatalBusy = true;
          if (hlsFatalRetries < 1) {
            hlsFatalRetries++;
            resumeAt = lastTime || v.currentTime || 0;
            report('hls-retry', { details: data.details, at: resumeAt });
            setTimeout(function () {
              loadSeq++;
              teardown();
              hlsFatalBusy = false;
              forceFresh = true;
              userPaused = false;
              load();
            }, 0);
            return;
          }
          report('hls-fatal', { details: data.details });
          setTimeout(function () {
            hlsFatalBusy = false;
            fallback(data.details || 'fatal');
          }, 0);
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          liveRetries = 0;
          // Live levels only become known once the manifest is parsed. Fill in
          // the sheet here so the cogwheel can list and switch them, exactly
          // like the official TV app.
          if (live && hls.levels && hls.levels.length) {
            curHeights = hlsHeights();
          }
          var cap = autoCapIndex();
          if (live) {
            // Start at 1080p for four seconds, then hand control to ABR. Live
            // HLS is AVC-only (a single codec family), so ABR can switch at a
            // fragment boundary without touching the decoder pipeline.
            var start = levelIndexFor(1080);
            try { hls.autoLevelCapping = cap; } catch (e) {}
            report('live-start', { start: start, cap: cap, n: hls.levels.length });
            if (start >= 0) {
              try { hls.startLevel = start; } catch (e) {}
              try { hls.currentLevel = start; } catch (e) {}
              setTimeout(function () {
                if (!pinnedH) releaseAuto(cap);
              }, 4000);
            }
          } else {
            // The master carries exactly one codec family (H.264 ≤1080, or
            // VP9 1440/2160 on a VP9-capable TV). Never cross families during
            // playback: hls.js 0.14 cannot change the MSE SourceBuffer codec,
            // and the failed append used to flush the buffer and black the
            // screen right after the 720p start. So start on the best level of
            // the one family and let ABR only move within it.
            try { hls.autoLevelCapping = cap; } catch (e) {}
            var idx = pinnedH ? levelIndexFor(pinnedH) : cap;
            if (pinnedH && idx >= 0) {
              // A saved 1080p pick on a VP9-only master is not a real level.
              // Pin the closest one the master actually has.
              var actual = hls.levels[idx].height || 0;
              if (actual && actual !== pinnedH) {
                pinnedH = actual;
                try { localStorage.setItem('tubetv.h', String(actual)); } catch (e) {}
              }
            }
            if (idx >= 0) {
              try { hls.startLevel = idx; } catch (e) {}
              try { hls.currentLevel = idx; } catch (e) {}
            }
            report('hls-start', {
              h: idx >= 0 ? (hls.levels[idx].height || 0) : 0,
              pinned: !!pinnedH,
              n: hls.levels.length
            });
            // Give the first fragments a moment, then let ABR step down if the
            // link cannot sustain the starting level. Same codec, so the switch
            // is seamless; the watchdog handles a full stall.
            setTimeout(function () {
              if (!pinnedH && hls && !isLive) releaseAuto(cap);
            }, 4000);
            if (resumeAt > 1) {
              try { v.currentTime = resumeAt; } catch (e) {}
            }
          }
          startWatchdog();
          tryPlay();
          chrome();
          if (!live) setTimeout(fullscreen, 600);
        });
        hls.attachMedia(v);
        hls.loadSource(info.hls);
        hint(live ? 'LIVE — starting…' : 'Starting…', live ? 4000 : 8000);
      });
    } else if (live && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = info.hls;
      tryPlay();
      chrome();
    } else if (live) {
      showErr('This TV browser cannot play livestreams (no MediaSource / HLS support).');
    } else {
      fallback('no-mse');
    }
  }

  function load() {
    err.style.display = 'none';
    var t = tiers[tier] || { h: 720 };
    var useHls = !t.muxed && !hlsOff;
    var q = '/api/play?id=' + encodeURIComponent(id) +
      (t.muxed ? '&muxed=1' : '&h=' + (t.h || 720)) +
      (useHls ? '&hls=1' : '') +
      (useHls && supportsVp9 && !forceAvc ? '&vp9=1' : '') +
      (forceFresh ? '&fresh=1' : '');
    forceFresh = false;
    report('request', { tier: tier, q: q });
    startElapsed();
    var seq = loadSeq;
    fetch(q)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (seq !== loadSeq) return;
        var j = x.j || {};
        if (j.live && j.hls) { attachHls(j, true); return; }
        if (j.hls && (j.mode === 'mse' || !j.video)) { attachHls(j, false); return; }
        // The server fell back to the split path because this video has no HLS
        // pair (or HLS failed). Do not pay for the HLS probe again per tier.
        if (useHls && j.video) {
          hlsOff = true;
          report('hls-unavailable', { h: j.height, mode: j.mode });
        }
        if (!x.ok || j.error || !j.video) {
          showErr(j.error || 'Could not load this video.');
          return;
        }
        attach(j);
      })
      .catch(function (e) { if (seq === loadSeq) showErr('Request failed: ' + e); });
  }

  function teardown() {
    stopWatchdog();
    stopElapsed();
    clearRamp();
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }
    started = false;
    isLive = false;
    switching = true;
    try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {}
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    switching = false;
  }

  function restart() {
    loadSeq++;
    teardown();
    userPaused = false;
    err.style.display = 'none';
    startBtn.style.display = 'none';
    prog.style.display = 'block';
    load();
  }

  function setQuality(h) {
    try { localStorage.setItem('tubetv.h', String(h)); } catch (e) {}
    pinnedH = h;
    tiers = makeTiers(h);
    tier = 0;
    // The master playlist already carries every rendition, so switching is
    // instant: no second resolve, no re-buffer, no restart. Live works the same
    // way — hls.js switches at the next fragment.
    if (hls) {
      var idx = levelIndexFor(h);
      if (idx >= 0) {
        clearRamp();
        try {
          hls.autoLevelCapping = autoCapIndex();
          hls.nextLevel = idx;
        } catch (e) {}
        closePanel();
        hint('Quality: ' + (hls.levels[idx].height || h) + 'p', 4000);
        report('quality', { h: h, level: idx });
        chrome();
        return;
      }
    }
    resumeAt = v.currentTime || 0;
    lastTime = resumeAt;
    hlsOff = false;
    hlsFatalRetries = 0;
    closePanel();
    restart();
    hint('Quality: ' + h + 'p', 4000);
  }

  function seek(delta) {
    if (isLive) { hint('Live stream — no seeking', 3000); return; }
    try {
      v.currentTime = Math.max(0, v.currentTime + delta);
      if (a.src) a.currentTime = v.currentTime;
    } catch (e) {}
    hint((delta > 0 ? '+' : '') + delta + 's · ' + fmt(v.currentTime), 2500);
    chrome();
  }

  function toggle() {
    if (startBtn.style.display !== 'none') { startBtn.click(); return; }
    if (v.muted && !v.paused) { unmute(); hint('Sound on'); chrome(); return; }
    if (v.paused) {
      userPaused = false;
      unmute();
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      if (a.src) a.play().catch(function () {});
      hint('Playing');
    } else {
      userPaused = true;
      v.pause();
      hint('Paused');
    }
    syncPlayLabel();
    chrome();
  }

  // --- panels (quality / comments) --------------------------------------
  function openPanel(kind) {
    panelKind = kind;
    panel.className = 'panel ' + (kind === 'comments' ? 'cmt' : 'qual');
    panelBody.scrollTop = 0;
    if (barTimer) clearTimeout(barTimer);
    setBar(false);
    if (kind === 'quality') renderQuality();
    else renderComments(true);
    try { panel.focus(); } catch (e) {}
    report('panel', { kind: kind });
  }

  function closePanel() {
    panelKind = null;
    panel.className = 'panel hide';
    panelBody.innerHTML = '';
    try { document.activeElement.blur(); } catch (e) {}
    chrome();
  }

  function paintQuality(hs) {
    var curH = pinnedH;
    if (!curH && hls && hls.currentLevel >= 0) {
      curH = (hls.levels[hls.currentLevel] || {}).height || 0;
    }
    // Automatic ABR keeps currentLevel at -1. Show the rendition actually on
    // screen so the "current" marker is true for live and VOD alike.
    if (!curH && v.videoHeight) curH = v.videoHeight;
    if (!curH) curH = tiers[tier].h;
    var html = '';
    for (var i = 0; i < hs.length; i++) {
      var label = hs[i] + 'p' + (hs[i] >= 2160 ? ' (4K)' : '');
      html += '<button class="row" data-h="' + hs[i] + '"><span>' + label + '</span>' +
        (hs[i] === curH ? '<span class="chk">current</span>' : '') + '</button>';
    }
    if (!html) html = '<div class="pnote">No selectable formats for this video.</div>';
    html += '<button class="row" id="qauto"><span>Automatic</span><span class="chk">adaptive</span></button>';
    panelBody.innerHTML = html;

    var rows = panelBody.querySelectorAll('button[data-h]');
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener('click', function () {
        setQuality(parseInt(this.getAttribute('data-h'), 10));
      });
    }
    var auto = document.getElementById('qauto');
    if (auto) {
      auto.addEventListener('click', function () {
        try { localStorage.removeItem('tubetv.h'); } catch (e) {}
        pinnedH = 0;
        tiers = makeTiers(720);
        tier = 0;
        if (hls) {
          releaseAuto(autoCapIndex());
          closePanel();
          hint('Quality: automatic', 4000);
          chrome();
          return;
        }
        hlsOff = false;
        hlsFatalRetries = 0;
        closePanel();
        restart();
        hint('Quality: automatic (720p)', 4000);
      });
    }
    var first = panelBody.querySelector('button.row');
    if (first) first.focus();
  }

  function renderQuality() {
    panelTitle.textContent = 'Quality';
    if (isLive) {
      // The levels arrived with the manifest, so switching is instant; there is
      // nothing to resolve. Only before MANIFEST_PARSED is there no list yet.
      if (hls && hls.levels && hls.levels.length) {
        curHeights = hlsHeights();
      }
      if (curHeights && curHeights.length) {
        paintQuality(curHeights);
        return;
      }
      panelBody.innerHTML = '<div class="pnote">Checking available formats…</div>';
      setTimeout(function () {
        if (panelKind === 'quality' && isLive) renderQuality();
      }, 400);
      return;
    }
    // Fast path: /api/play already told us the resolutions, so there is nothing
    // to wait for. Re-resolve only when this video arrived without them.
    if (curHeights && curHeights.length) {
      paintQuality(curHeights);
      return;
    }
    panelBody.innerHTML = '<div class="pnote">Checking available formats…</div>';
    fetch('/api/qualities?id=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (panelKind !== 'quality') return;
        if (j && j.live) {
          panelBody.innerHTML = '<div class="pnote">Livestream: quality follows the network automatically.</div>';
          return;
        }
        var hs = (j && j.heights) || [];
        if (hs.length) curHeights = hs;
        paintQuality(hs);
      })
      .catch(function () {
        if (panelKind === 'quality') panelBody.innerHTML = '<div class="pnote">Could not list formats.</div>';
      });
  }

  function renderComments(reset) {
    if (cmtLoading) return;
    if (reset) {
      panelTitle.textContent = 'Comments';
      cmtToken = null;
      panelBody.innerHTML = '<div class="pnote">Loading comments…</div>';
    }
    cmtLoading = true;
    var u = '/api/comments?id=' + encodeURIComponent(id) +
      (cmtToken ? '&token=' + encodeURIComponent(cmtToken) : '');
    fetch(u, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        cmtLoading = false;
        if (panelKind !== 'comments') return;
        if (reset) panelBody.innerHTML = '';
        if (j && j.error) {
          panelBody.innerHTML = '<div class="pnote">' +
            (j.error === 'comments off' ? 'Comments are turned off for this video.' : 'Could not load comments.') +
            '</div>';
          return;
        }
        if (!j || !j.html) {
          panelBody.innerHTML = '<div class="pnote">No comments yet.</div>';
          return;
        }
        var box = document.createElement('div');
        box.innerHTML = j.html;
        while (box.firstChild) panelBody.appendChild(box.firstChild);
        cmtToken = j.token || null;
      })
      .catch(function () {
        cmtLoading = false;
        if (panelKind === 'comments' && reset) {
          panelBody.innerHTML = '<div class="pnote">Could not load comments.</div>';
        }
      });
  }

  panelBody.addEventListener('scroll', function () {
    if (panelKind !== 'comments' || !cmtToken || cmtLoading) return;
    if (panelBody.scrollTop + panelBody.clientHeight > panelBody.scrollHeight - 500) renderComments(false);
  });

  // --- audio/video sync -------------------------------------------------
  v.addEventListener('play', function () {
    if (a.src) a.play().catch(function () {});
    syncPlayLabel();
  });
  v.addEventListener('playing', function () {
    startBtn.style.display = 'none';
    if (!isLive && hud.textContent === 'Starting…') hud.className = 'hud hide';
    if (isLive) { lastClock = ''; updateClock(); hint('LIVE', 4000); }
    if (!a.src) return;
    if (Math.abs(a.currentTime - v.currentTime) > 0.25) {
      try { a.currentTime = v.currentTime; } catch (e) {}
    }
    a.play().catch(function () {});
  });
  v.addEventListener('pause', function () {
    a.pause();
    syncPlayLabel();
    chrome();
    // Unexpected pause (browser policy, decoder reset): resume unless the
    // viewer paused or we are changing quality.
    if (active && started && !userPaused && !switching && !v.ended &&
        !document.hidden && startBtn.style.display === 'none') {
      setTimeout(retryMuted, 400);
    }
  });
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

  // --- clock + progress -------------------------------------------------
  function updateClock() {
    var s;
    if (isLive) {
      s = 'LIVE';
    } else if (!isFinite(v.duration) || v.duration <= 0) {
      s = fmt(v.currentTime);
    } else {
      s = fmt(v.currentTime) + ' / ' + fmt(v.duration) + '   −' + fmt(Math.max(0, v.duration - v.currentTime));
    }
    if (s !== lastClock) {
      lastClock = s;
      clock.textContent = s;
    }
    if (started && v.readyState >= 2 && isFinite(v.duration) && v.duration > 0) {
      lastTime = v.currentTime || 0;
    }
    if (!isLive && isFinite(v.duration) && v.duration > 0 && progfill) {
      progfill.style.width = Math.min(100, (v.currentTime / v.duration) * 100).toFixed(2) + '%';
    }
  }
  v.addEventListener('timeupdate', updateClock);
  v.addEventListener('durationchange', updateClock);
  v.addEventListener('loadedmetadata', function () {
    if (resumeAt > 1 && isFinite(v.duration) && resumeAt < v.duration - 5) {
      try { v.currentTime = resumeAt; } catch (e) {}
      if (a.src) { try { a.currentTime = resumeAt; } catch (e) {} }
    }
    resumeAt = 0;
    updateClock();
    // Some TV browsers only honour play() once metadata exists.
    if (v.paused && !userPaused && startBtn.style.display === 'none') tryPlay();
  });

  // No native controls (they steal arrow keys on TV browsers) — tap/click the
  // picture to play or pause.
  v.addEventListener('click', function () { fullscreenOnce(); toggle(); });

  // --- failure handling: step down quality, then give up with detail ----
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
    // A frozen MSE pipeline is not going to improve by re-resolving the same
    // HLS master. On a VP9 stream prefer the H.264 HLS master (≤1080) before
    // dropping all the way to the progressive split path; otherwise fall back
    // to split at the next tier.
    if (hls) {
      if (supportsVp9 && !forceAvc && isVp9Stream()) {
        forceAvc = true;
        hlsFatalRetries = 0;
        pinnedH = 0;
        try { localStorage.removeItem('tubetv.h'); } catch (e) {}
        report('step-avc', { why: why, tier: tier });
      } else if (why === 'frozen') {
        // A slow first frame on a loaded Pi is not proof that MSE is broken.
        // Stay on HLS while a lower HLS tier remains; only the final muxed
        // tier (or a decoder error) should send playback to the split path.
        // Jumping straight to split here cost a second 10-20 s resolve and was
        // the "playback error, trying a compatible format" moment on the TV.
        var next = tiers[tier];
        if (!next || next.muxed) hlsOff = true;
      }
    }
    // A frozen stream is the strongest signal that this TV's decoder (or its
    // video-only pipeline) cannot handle the format, so remember the tier.
    if (why === 'frozen' || why === 'stalled' || /^(video|audio)-[34]$/.test(why)) {
      try { localStorage.setItem('tubetv.tier', String(tier)); } catch (e) {}
    }
    var t = tiers[tier];
    freshRetries = 0;
    audioRetries = 0;
    hint('Trying ' + (t.muxed ? 'the compatible stream' : t.h + 'p') + '…', 8000);
    report('step-down', { why: why, tier: tier });
    loadSeq++;
    teardown();
    tiers[tier] = tiers[tier] || { h: 480 };
    load();
    return true;
  }

  // Some TV browsers (including VIDAA) fetch a stream, report readyState 4 and
  // then never advance the clock — no error, no frames, just a frozen picture.
  // So the watchdog watches *progress*, not readiness.
  function startWatchdog() {
    stopWatchdog();
    // Start from the real clock, not -1: with -1 the first sample (t=0 while
    // the first segment is still being buffered) looked like progress, so a
    // slow start could be misread as a freeze and step down to the split path.
    var lastT = v.currentTime || 0;
    var progressed = false;
    var lastMove = Date.now();
    var warned = false;

    watchdog = setInterval(function () {
      if (!started || !active) return;
      if (document.hidden) { lastMove = Date.now(); return; }
      if (panelKind) { lastMove = Date.now(); return; }
      if (userPaused) { lastMove = Date.now(); return; }
      // Waiting on a Play button is not a stall — but it must not last either:
      // muted playback is always allowed, so nudge it back to life.
      if (startBtn && startBtn.style.display !== 'none') {
        lastMove = Date.now();
        retryMuted();
        return;
      }
      if (v.paused) {
        lastMove = Date.now();
        retryMuted();
        return;
      }

      var now = Date.now();
      var t = v.currentTime || 0;
      if (t < lastT - 1) {
        // A backwards seek is not a stall; re-baseline instead.
        lastT = t;
        lastMove = now;
        warned = false;
        return;
      }
      if (t > lastT + 0.05) {
        lastT = t;
        lastMove = now;
        progressed = true;
        warned = false;
        return;
      }

      // Live has no quality cascade to step down to. If the clock has not
      // moved for 12 s, ask hls.js to reload the live playlist and retry.
      if (isLive) {
        if (now - lastMove > 12000) {
          lastMove = now;
          report('live-stall', { rs: v.readyState, ns: v.networkState, t: t, pinned: pinnedH });
          if (pinnedH) {
            // A manually pinned live level that cannot keep up goes back to
            // ABR instead of freezing the stream.
            pinnedH = 0;
            try { localStorage.removeItem('tubetv.h'); } catch (e) {}
            releaseAuto(autoCapIndex());
            hint('Live quality stalled — automatic', 5000);
          } else {
            hint('Reconnecting live…', 5000);
          }
          try { hls.startLoad(); } catch (e) {}
          retryMuted();
        }
        return;
      }

      var idle = now - lastMove;
      // Before the first frame, and while there is not enough data, a slow
      // network is the likely cause. Give it 20 s instead of 8, so a loaded
      // Pi or a cold segment cannot trigger a quality step-down by itself.
      var limit = (!progressed || v.readyState < 3) ? 20000 : 8000;

      if (!warned && idle > 4000) {
        warned = true;
        hint('Loaded, but playback is not starting — trying a compatible format…', 8000);
        report('frozen', { rs: v.readyState, ns: v.networkState, tier: tier, t: t });
      }

      if (idle < limit) return;
      // A 4K picture that cannot keep up (pinned or chosen by ABR) drops to the
      // lowest level in the same codec master and climbs back gradually,
      // instead of tearing down HLS or crossing into another codec.
      if (hls && !isLive) {
        var lh = pinnedH || v.videoHeight || 0;
        var floor = lowestCap();
        if (lh > 1080 && floor >= 0 && floor !== autoCapIndex()) {
          report('uhd-drop', { from: lh, pinned: !!pinnedH, rs: v.readyState, floor: hls.levels[floor].height });
          pinnedH = 0;
          try { localStorage.removeItem('tubetv.h'); } catch (e) {}
          releaseAuto(floor);
          rampUp(autoCapIndex());
          hint('Playback stalled — adapting quality', 6000);
          lastT = -1;
          lastMove = Date.now();
          warned = false;
          return;
        }
      }
      if (stepDown(v.readyState >= 3 ? 'frozen' : 'stalled')) {
        lastT = -1;
        lastMove = Date.now();
        warned = false;
        return;
      }
      stopWatchdog();
      showErr('This TV could not play any of the available formats (readyState ' +
        v.readyState + ', networkState ' + v.networkState + '). Open /diag on this TV.');
    }, 2000);
  }

  // A resolved URL can go stale server-side (or the 6 h token can expire).
  // Ask for a freshly resolved one once, before blaming the codec.
  v.addEventListener('error', function () {
    var e = v.error;
    var code = e ? e.code : 0;
    report('video-error', { code: code, rs: v.readyState, ns: v.networkState, tier: tier });
    if (switching) return;
    // hls.js owns the media element in MSE mode; its ERROR handler decides
    // whether to retry, recover, or fall back.
    if (hls) return;
    if (!isLive && started && freshRetries < 1) {
      freshRetries++;
      report('src-refresh', { why: 'video-' + code, tier: tier });
      resumeAt = lastTime || v.currentTime || 0;
      loadSeq++;
      teardown();
      forceFresh = true;
      userPaused = false;
      load();
      return;
    }
    if (stepDown('video-' + code)) return;
    showErr('Video failed (' + errName(code) + ', code ' + code +
      '). Open /diag on this TV for details.');
  });

  // Losing the audio track must never cost the viewer their resolution: the
  // picture is fine. Re-resolve the audio once, then continue video-only.
  a.addEventListener('error', function () {
    var code = a.error ? a.error.code : 0;
    report('audio-error', { code: code, tier: tier,
      vrs: v.readyState, verr: v.error ? v.error.code : 0 });
    if (switching || audioGaveUp || !started) return;
    if (!isLive && audioRetries < 1) {
      audioRetries++;
      refreshAudio();
      return;
    }
    audioGaveUp = true;
    audioOnly();
  });

  function refreshAudio() {
    var t = tiers[tier] || { h: 720 };
    var u = '/api/play?id=' + encodeURIComponent(id) +
      (t.muxed ? '&muxed=1' : '&h=' + t.h) + '&fresh=1';
    report('audio-refresh', { tier: tier });
    fetch(u, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!active || !started || !j || j.live || !j.audio) { audioGaveUp = true; audioOnly(); return; }
        var at = v.currentTime || 0;
        a.muted = v.muted;
        a.volume = v.volume;
        a.src = j.audio;
        try { a.load(); } catch (e) {}
        try { a.currentTime = at; } catch (e) {}
        var p = a.play();
        if (p && p.catch) p.catch(function () {});
        report('audio-refreshed', { tier: tier });
      })
      .catch(function () { audioGaveUp = true; audioOnly(); });
  }

  function audioOnly() {
    try {
      a.pause();
      a.removeAttribute('src');
      a.load();
    } catch (e) {}
    hint('Sound unavailable for this stream', 8000);
  }

  // --- buttons ----------------------------------------------------------
  document.getElementById('back').addEventListener('click', function () { goBack(); });
  playBtn.addEventListener('click', toggle);
  gearBtn.addEventListener('click', function () { openPanel('quality'); });
  cmtBtn.addEventListener('click', function () { openPanel('comments'); });
  startBtn.addEventListener('click', function () {
    startBtn.style.display = 'none';
    unmute();
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
    if (a.src) a.play().catch(function () {});
    fullscreen();
    chrome();
    syncPlayLabel();
  });

  // --- open / close on grid pages ---------------------------------------
  function resetChrome() {
    stopElapsed();
    if (hudTimer) clearTimeout(hudTimer);
    if (barTimer) clearTimeout(barTimer);
    err.style.display = 'none';
    startBtn.style.display = 'none';
    hud.className = 'hud hide';
    hud.textContent = '';
    clock.textContent = '';
    lastClock = '';
    prog.style.display = 'block';
    progfill.style.width = '0%';
    panel.className = 'panel hide';
    panelBody.innerHTML = '';
    panelKind = null;
    setBar(false);
  }

  function open(id2, anchor) {
    if (active && id === id2) return;
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }
    resetChrome();
    id = id2;
    active = true;
    started = false;
    isLive = false;
    userPaused = false;
    soundBlocked = false;
    fsTried = false;
    tier = 0;
    resumeAt = 0;
    lastTime = 0;
    freshRetries = 0;
    audioRetries = 0;
    audioGaveUp = false;
    forceFresh = false;
    forceAvc = false;
    hlsOff = false;
    hlsFatalRetries = 0;
    hlsFatalBusy = false;
    loadSeq++;
    lastAnchor = anchor || lastAnchor;
    lastScroll = window.pageYOffset || 0;
    prefetchId = id2;
    // One-time migration for the adaptive-level build. Older builds saved a
    // forced split quality and a cascade position; both would bypass the new
    // multi-level HLS master. Clear them so the TV starts adaptive once.
    try {
      if (localStorage.getItem('tubetv.prefver') !== '3') {
        localStorage.removeItem('tubetv.h');
        localStorage.removeItem('tubetv.tier');
        localStorage.setItem('tubetv.prefver', '3');
      }
    } catch (e) {}
    // Every new video starts in Automatic. A manual pick belongs to the video
    // it was made on (or to an explicit /watch?...&h= URL), not to everything
    // opened afterwards: persisting it meant one 1440p/2160p pick forced every
    // later video to start pinned at a level the Pi could not sustain, and a
    // past freeze silently saved a degraded tier for later videos.
    pinnedH = 0;
    tiers = makeTiers(720);
    tier = 0;
    try {
      localStorage.removeItem('tubetv.h');
      localStorage.removeItem('tubetv.tier');
    } catch (e) {}
    if (stage) stage.className = 'stage';
    document.body.classList.add('cinema');
    document.body.classList.add('watch-open');
    document.documentElement.style.overflow = 'hidden';
    report('open', { id: id, mode: stage ? 'overlay' : 'page', tier: tier,
      vp9: supportsVp9, mse: !!window.MediaSource });
    load();
  }

  function close() {
    if (!active) return;
    stopElapsed();
    loadSeq++;
    teardown();
    active = false;
    id = '';
    if (stage) {
      stage.className = 'stage hide';
      document.body.classList.remove('cinema');
      document.body.classList.remove('watch-open');
      document.documentElement.style.overflow = '';
      var sy = lastScroll || 0;
      (window.requestAnimationFrame || setTimeout)(function () {
        try { window.scrollTo(0, sy); } catch (e) {}
      });
      if (lastAnchor) { try { lastAnchor.focus(); } catch (e) {} }
      else { try { document.activeElement.blur(); } catch (e) {} }
    }
    document.title = 'TubeTV';
  }

  function goBack() {
    if (panelKind) { closePanel(); return; }
    if (barOn) { setBar(false); return; }
    if (!CINEMA_PAGE && pushed) {
      try { history.back(); return; } catch (e) {}
    }
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/';
  }

  // --- remote keys ------------------------------------------------------
  function isBack(c, k) {
    return c === 8 || c === 27 || c === 4 || c === 461 || c === 10009 ||
      k === 'Escape' || k === 'Back' || k === 'Backspace' || k === 'GoBack';
  }
  function isUp(c, k) { return c === 38 || k === 'ArrowUp' || k === 'Up'; }
  function isDown(c, k) { return c === 40 || k === 'ArrowDown' || k === 'Down'; }
  function isLeft(c, k) { return c === 37 || k === 'ArrowLeft' || k === 'Left'; }
  function isRight(c, k) { return c === 39 || k === 'ArrowRight' || k === 'Right'; }
  function isOk(c, k) {
    return c === 13 || c === 23 || k === 'Enter' || k === 'OK' || k === 'Select' || k === 'Accept';
  }

  document.addEventListener('keydown', function (e) {
    if (!active) return;
    var k = e.key || '';
    var c = e.keyCode || e.which || 0;

    if (isBack(c, k)) {
      e.preventDefault();
      goBack();
      return;
    }

    fullscreenOnce();

    // Panel takes every key while it is open — except the two shortcuts, which
    // switch sheets instead of forcing a close first.
    if (panelKind) {
      if (k === 's' || k === 'S') { e.preventDefault(); openPanel('quality'); return; }
      if (k === 'c' || k === 'C') { e.preventDefault(); openPanel('comments'); return; }
      var rows = panelBody.querySelectorAll('button.row');
      if (isUp(c, k) || isDown(c, k)) {
        e.preventDefault();
        if (rows.length) {
          var idx = Array.prototype.indexOf.call(rows, document.activeElement);
          var delta = isDown(c, k) ? 1 : -1;
          if (idx < 0) idx = delta > 0 ? -1 : 0;
          var nxt = rows[Math.max(0, Math.min(rows.length - 1, idx + delta))];
          if (nxt) nxt.focus();
        } else {
          panelBody.scrollTop += isDown(c, k) ? 320 : -320;
        }
        return;
      }
      if (isOk(c, k)) {
        e.preventDefault();
        if (document.activeElement && document.activeElement.className.indexOf('row') >= 0) {
          document.activeElement.click();
        } else if (rows.length) {
          rows[0].focus();
        }
        return;
      }
      return;
    }

    // Sound-off is the most common first interaction after a cold autoplay.
    // Make OK turn sound on from anywhere except a focused control or sheet row.
    if (isOk(c, k) && v.muted && !v.paused &&
        startBtn.style.display === 'none' &&
        ctlBtns.indexOf(document.activeElement) < 0 &&
        document.activeElement !== prog && document.activeElement !== backBtn) {
      e.preventDefault();
      unmute();
      hint('Sound on');
      chrome();
      return;
    }

    // Control bar visible: Left/Right move along the bottom row, Up climbs to
    // the timeline and then to Back, Down comes back down.
    if (barOn) {
      var bi = ctlBtns.indexOf(document.activeElement);
      var onProg = document.activeElement === prog;
      var onBack = document.activeElement === backBtn;
      if (isUp(c, k)) {
        e.preventDefault();
        if (onBack) { /* already at the top */ }
        else if (onProg) backBtn.focus();
        else if (prog.style.display !== 'none') prog.focus();
        else backBtn.focus();
        chrome();
        return;
      }
      if (isDown(c, k)) {
        e.preventDefault();
        if (onBack) { if (prog.style.display !== 'none') prog.focus(); else focusBtn(0); }
        else if (onProg) focusBtn(0);
        else { setBar(false); return; }
        chrome();
        return;
      }
      if (onBack) {
        if (isOk(c, k)) { e.preventDefault(); backBtn.click(); }
        return;
      }
      if (onProg) {
        if (isLeft(c, k)) { e.preventDefault(); seek(-10); return; }
        if (isRight(c, k)) { e.preventDefault(); seek(10); return; }
        if (isOk(c, k)) { e.preventDefault(); toggle(); return; }
        return;
      }
      if (isLeft(c, k)) { e.preventDefault(); focusBtn(bi < 0 ? 0 : bi - 1); chrome(); return; }
      if (isRight(c, k)) { e.preventDefault(); focusBtn(bi < 0 ? 0 : bi + 1); chrome(); return; }
      if (isOk(c, k)) {
        e.preventDefault();
        if (bi >= 0) ctlBtns[bi].click();
        else focusBtn(0);
        chrome();
        return;
      }
    }

    if (isUp(c, k) || isDown(c, k)) {
      e.preventDefault();
      chrome();
      if (isUp(c, k)) {
        if (prog.style.display !== 'none') prog.focus();
        else backBtn.focus();
      } else focusBtn(0);
      return;
    }
    if (isLeft(c, k)) { e.preventDefault(); seek(-10); return; }
    if (isRight(c, k)) { e.preventDefault(); seek(10); return; }

    if (isOk(c, k) || k === ' ' || k === 'Spacebar' || c === 32) {
      e.preventDefault();
      toggle();
      return;
    }
    if (c === 179 || c === 415 || c === 10252 || k === 'MediaPlayPause' || k === 'Play' || k === 'MediaPlay') {
      toggle();
      return;
    }
    if (c === 19 || c === 178 || k === 'MediaStop' || k === 'Pause') {
      if (!v.paused) toggle();
      return;
    }
    if (k === 's' || k === 'S') { e.preventDefault(); openPanel('quality'); return; }
    if (k === 'c' || k === 'C') { e.preventDefault(); openPanel('comments'); return; }
    if (k === 'f' || k === 'F') { fullscreen(); return; }

    chrome();
  });

  document.addEventListener('click', function (e) {
    if (!active) return;
    if (e.target === v) return;
    chrome();
  });
  document.addEventListener('mousemove', function () { if (active) chrome(); });

  // --- grid integration -------------------------------------------------
  if (stage) {
    // Warm the stream for whichever tile the remote is sitting on.
    document.addEventListener('focusin', function (e) {
      if (active) return;
      var el = e.target;
      if (!el || el.tagName !== 'A') return;
      var m = /^\/watch\?(?:.*&)?id=([A-Za-z0-9_-]{11})/.exec(el.getAttribute('href') || '');
      if (m) schedulePrefetch(m[1]);
    }, true);

    // Start warming the first tile as soon as the grid exists. The old code
    // waited for window `load`, which on the TV could be many seconds late
    // because it also waits for every thumbnail; the remote is usually already
    // sitting on the first card by then.
    function warmFirst() {
      if (active) return;
      var first = document.querySelector('.card');
      if (!first) return;
      var m = /^\/watch\?(?:.*&)?id=([A-Za-z0-9_-]{11})/.exec(first.getAttribute('href') || '');
      if (m) setTimeout(function () { if (!active) prefetch(m[1]); }, 150);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', warmFirst);
    } else {
      setTimeout(warmFirst, 0);
    }

    document.addEventListener('click', function (e) {
      if (active) return;
      var el = e.target;
      while (el && el !== document) {
        if (el.tagName === 'A' && el.getAttribute('href')) {
          var m = /^\/watch\?(?:.*&)?id=([A-Za-z0-9_-]{11})/.exec(el.getAttribute('href'));
          if (m && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            if (history.pushState) {
              history.pushState({ tubetv: m[1] }, '', '/watch?id=' + m[1]);
              pushed = true;
            }
            open(m[1], el);
          }
          return;
        }
        el = el.parentNode;
      }
    }, true);

    window.addEventListener('popstate', function (e) {
      var m = /[?&]id=([A-Za-z0-9_-]{11})/.exec(location.search);
      if (active && !m) { pushed = false; close(); return; }
      if (active && m && m[1] !== id) { pushed = false; open(m[1]); return; }
      if (!active && m) { pushed = false; open(m[1]); }
    });

    var initial = /[?&]id=([A-Za-z0-9_-]{11})/.exec(location.search);
    if (initial && /^\/watch/.test(location.pathname)) {
      pushed = false;
      open(initial[1]);
    }
  } else {
    // Standalone /watch page.
    var mm = /[?&]id=([A-Za-z0-9_-]{11})/.exec(location.search);
    if (mm) {
      active = true;
      id = mm[1];
      try {
        localStorage.removeItem('tubetv.h');
        localStorage.removeItem('tubetv.tier');
      } catch (e) {}
      try {
        var qh = parseInt(new URLSearchParams(location.search).get('h') || '', 10);
        if (qh) {
          localStorage.removeItem('tubetv.tier');
          tiers = makeTiers(qh);
          pinnedH = qh;
        }
      } catch (e) {}
      resetChrome();
      stage = null;
      document.documentElement.style.overflow = 'hidden';
      load();
    }
  }

  syncPlayLabel();
})();
