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
  var hideTimer = null;
  var barOn = false;
  var panelKind = null;
  var cmtToken = null;
  var cmtLoading = false;
  var lastClock = '';
  var started = false;
  var isLive = false;
  var hls = null;
  var hlsOff = false;
  var hlsFatalRetries = 0;
  var hlsFatalBusy = false;
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
  var lastAnchor = null;
  var pushed = false;
  var lastScroll = 0;
  var prefetchTimer = null;
  var prefetchId = '';
  var prefetchBusy = false;
  var prefetchQueued = '';

  var CINEMA_PAGE = document.body.classList.contains('cinema');

  // The tile OK press is a real user gesture. If it is still active when the
  // stream is ready, start with sound instead of muting first and unmuting late
  // (VIDAA dislikes that dance). Prefetching keeps the gap short.
  function hasGesture() {
    try {
      return !!(navigator.userActivation && navigator.userActivation.isActive);
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
    if (!on) {
      try { document.activeElement.blur(); } catch (e) {}
    }
  }

  function chrome() {
    if (!active) return;
    setBar(true);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
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
      hint('Sound off — press OK for sound', true);
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
        hint('Sound off — press OK for sound', true);
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
    started = true;
    abortRetries = 0;
    audioGaveUp = false;
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
    started = true;
    isLive = !!live;
    ttl.textContent = info.title || (live ? 'Live' : id);
    document.title = (info.title || (live ? 'Live' : 'TubeTV')) + ' · TubeTV';
    prog.style.display = live ? 'none' : 'block';
    if (live) hint('LIVE', true);
    v.muted = !hasGesture();
    report(live ? 'live-attach' : 'hls-attach', {
      hasMSE: typeof window.MediaSource !== 'undefined',
      h: info.height,
      mode: info.mode
    });

    function fallback(why) {
      if (live) return;
      hlsOff = true;
      resumeAt = lastTime || v.currentTime || 0;
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
          capLevelToPlayerSize: true,
          abrEwmaDefaultEstimate: 2000000,
          // TV browsers have little spare memory. Keep the MSE buffer small;
          // hls.js evicts old fragments as playback advances.
          maxBufferLength: 20,
          maxMaxBufferLength: 30,
          backBufferLength: 30,
          maxBufferSize: 40 * 1000 * 1000
        };
        if (live) cfg.liveSyncDurationCount = 3;
        hls = new window.Hls(cfg);
        hls.on(window.Hls.Events.ERROR, function (ev, data) {
          report('hls-error', { type: data.type, details: data.details, fatal: !!data.fatal });
          if (!data.fatal) {
            // A single bad fragment is normal; hls.js retries on its own.
            if (data.type === 'mediaError') {
              try { hls.recoverMediaError(); } catch (e) {}
            }
            return;
          }
          if (hlsFatalBusy) return;

          if (isLive) {
            if (data.type === 'networkError') { try { hls.startLoad(); } catch (e) {} return; }
            if (data.type === 'mediaError') { try { hls.recoverMediaError(); } catch (e) {} return; }
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
          if (live) {
            // Start on the best level that isn't 4K, then hand control back to
            // the adaptive switcher so a slow link can still step down.
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
          } else if (resumeAt > 1) {
            try { v.currentTime = resumeAt; } catch (e) {}
          }
          startWatchdog();
          tryPlay();
          chrome();
          if (!live) setTimeout(fullscreen, 600);
        });
        hls.attachMedia(v);
        hls.loadSource(info.hls);
        hint(live ? 'LIVE — starting…' : 'Starting…', !!live);
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
      (forceFresh ? '&fresh=1' : '');
    forceFresh = false;
    report('request', { tier: tier, q: q });
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
    resumeAt = v.currentTime || 0;
    lastTime = resumeAt;
    tiers = makeTiers(h);
    tier = 0;
    hlsOff = false;
    hlsFatalRetries = 0;
    closePanel();
    restart();
    hint('Quality: ' + h + 'p', true);
  }

  function seek(delta) {
    if (isLive) { hint('Live stream — no seeking', true); return; }
    try {
      v.currentTime = Math.max(0, v.currentTime + delta);
      if (a.src) a.currentTime = v.currentTime;
    } catch (e) {}
    hint((delta > 0 ? '+' : '') + delta + 's · ' + fmt(v.currentTime), true);
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
    if (hideTimer) clearTimeout(hideTimer);
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

  function renderQuality() {
    panelTitle.textContent = 'Quality';
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
        var html = '';
        for (var i = 0; i < hs.length; i++) {
          html += '<button class="row" data-h="' + hs[i] + '"><span>' + hs[i] + 'p</span>' +
            (hs[i] === tiers[tier].h ? '<span class="chk">current</span>' : '') + '</button>';
        }
        if (!html) html = '<div class="pnote">No selectable formats for this video.</div>';
        html += '<button class="row" id="qauto"><span>Automatic</span><span class="chk">720p, step down</span></button>';
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
            tiers = makeTiers(720);
            tier = 0;
            hlsOff = false;
            hlsFatalRetries = 0;
            closePanel();
            restart();
            hint('Quality: automatic (720p)', true);
          });
        }
        var first = panelBody.querySelector('button.row');
        if (first) first.focus();
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
    if (isLive) { lastClock = ''; updateClock(); hint('LIVE', true); }
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
    // A frozen stream is the strongest signal that this TV's decoder (or its
    // video-only pipeline) cannot handle the format, so remember the tier.
    if (why === 'frozen' || why === 'stalled' || /^(video|audio)-[34]$/.test(why)) {
      try { localStorage.setItem('tubetv.tier', String(tier)); } catch (e) {}
    }
    var t = tiers[tier];
    freshRetries = 0;
    audioRetries = 0;
    hint('Trying ' + (t.muxed ? 'the compatible stream' : t.h + 'p') + '…', true);
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
    var lastT = -1;
    var lastMove = Date.now();
    var warned = false;

    watchdog = setInterval(function () {
      if (!started || isLive || !active) return;
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
      if (t > lastT + 0.05) {
        lastT = t;
        lastMove = now;
        warned = false;
        return;
      }

      var idle = now - lastMove;
      // Not enough data yet is a network problem: give it longer.
      var limit = v.readyState >= 3 ? 8000 : 20000;

      if (!warned && idle > 4000) {
        warned = true;
        hint('Loaded, but playback is not starting — trying a compatible format…', true);
        report('frozen', { rs: v.readyState, ns: v.networkState, tier: tier, t: t });
      }

      if (idle < limit) return;
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
    hint('Sound unavailable for this stream', true);
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
    hlsOff = false;
    hlsFatalRetries = 0;
    hlsFatalBusy = false;
    loadSeq++;
    lastAnchor = anchor || lastAnchor;
    lastScroll = window.pageYOffset || 0;
    prefetchId = id2;
    // One-time migration: older builds saved a forced split quality (often
    // 720p) and a tier position that would bypass the new single-pipeline HLS
    // path. Clear it so the TV starts on the safer MSE path once.
    try {
      if (localStorage.getItem('tubetv.prefver') !== '2') {
        localStorage.removeItem('tubetv.h');
        localStorage.removeItem('tubetv.tier');
        localStorage.setItem('tubetv.prefver', '2');
      }
    } catch (e) {}
    // ?h=/manual pick wins, then the cascade position this TV settled on.
    try {
      var savedH = parseInt(localStorage.getItem('tubetv.h') || '', 10);
      var saved = parseInt(localStorage.getItem('tubetv.tier') || '', 10);
      tiers = makeTiers(savedH || 720);
      if (!savedH && saved > 0 && saved < tiers.length) tier = saved;
    } catch (e) {}
    if (stage) stage.className = 'stage';
    document.body.classList.add('cinema');
    document.body.classList.add('watch-open');
    document.documentElement.style.overflow = 'hidden';
    report('open', { id: id, mode: stage ? 'overlay' : 'page', tier: tier });
    load();
  }

  function close() {
    if (!active) return;
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
        ctlBtns.indexOf(document.activeElement) < 0) {
      e.preventDefault();
      unmute();
      hint('Sound on');
      chrome();
      return;
    }

    // Control bar visible: arrows move between buttons, Enter activates.
    if (barOn) {
      var bi = ctlBtns.indexOf(document.activeElement);
      if (isLeft(c, k)) { e.preventDefault(); focusBtn(bi < 0 ? 0 : bi - 1); return; }
      if (isRight(c, k)) { e.preventDefault(); focusBtn(bi < 0 ? 0 : bi + 1); return; }
      if (isUp(c, k) || isDown(c, k)) { e.preventDefault(); setBar(false); return; }
      if (isOk(c, k)) {
        e.preventDefault();
        if (bi >= 0) ctlBtns[bi].click();
        else focusBtn(0);
        return;
      }
    }

    if (isUp(c, k) || isDown(c, k)) {
      e.preventDefault();
      chrome();
      focusBtn(0);
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

    window.addEventListener('load', function () {
      if (active) return;
      var first = document.querySelector('.card');
      if (!first) return;
      var m = /^\/watch\?(?:.*&)?id=([A-Za-z0-9_-]{11})/.exec(first.getAttribute('href') || '');
      if (m) setTimeout(function () { if (!active) prefetch(m[1]); }, 250);
    });

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
        var qh = parseInt(new URLSearchParams(location.search).get('h') || '', 10);
        if (qh) {
          localStorage.removeItem('tubetv.tier');
          tiers = makeTiers(qh);
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
