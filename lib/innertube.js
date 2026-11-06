import { getAccessToken, isSignedIn } from './auth.js';

// TVHTML5 is the client YouTube's own TV app uses. It is also the only client
// that still accepts the OAuth token minted by the TV device-code flow.
const UA =
  'Mozilla/5.0 (PS4; Leanback Shell) Cobalt/26.lts.0-qa; compatible;';

const CLIENT_NAME = 'TVHTML5';
const CLIENT_VERSION = '7.20250101.10.00';
const CLIENT_ID = '7';
const HL = process.env.YT_HL || 'en';
const GL = process.env.YT_GL || 'US';

function context() {
  return {
    client: {
      clientName: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
      hl: HL,
      gl: GL,
    },
  };
}

// The visitor id YouTube hands out for this session. yt-dlp can skip the 1 MB
// webpage download when it is given one, which is the difference between a
// ~20 s and a ~3 s resolve on the TV's Pi. Every InnerTube response carries it,
// so by the time a tile is opened (the home feed has already been fetched) the
// value is here for free. ytdlp.js reads it through visitorHint().
let lastVisitorData = '';
export function visitorHint() {
  return lastVisitorData;
}

function rememberVisitor(data) {
  const v = data?.responseContext?.visitorData;
  if (typeof v === 'string' && v.length >= 20 && v.length < 1200) lastVisitorData = v;
}

async function api(endpoint, body, { timeoutMs = 0 } = {}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': UA,
    origin: 'https://www.youtube.com',
    referer: 'https://www.youtube.com/tv',
    'accept-language': `${HL}-${GL},${HL};q=0.9`,
    'x-youtube-client-name': CLIENT_ID,
    'x-youtube-client-version': CLIENT_VERSION,
  };
  try {
    const token = await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  } catch {}

  const r = await fetch(`https://www.youtube.com${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ context: context(), ...body }),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`InnerTube ${endpoint} ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  rememberVisitor(data);
  return data;
}

// Comments are read with the web client: the TV surface does not expose them,
// and reading public comments needs no account.
const WEB_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20250101.00.00',
  hl: HL,
  gl: GL,
};

async function apiWeb(endpoint, body) {
  const headers = {
    'content-type': 'application/json',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    origin: 'https://www.youtube.com',
    referer: 'https://www.youtube.com/',
    'accept-language': `${HL}-${GL},${HL};q=0.9`,
    'x-youtube-client-name': '1',
    'x-youtube-client-version': WEB_CLIENT.clientVersion,
  };
  const r = await fetch(`https://www.youtube.com${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ context: { client: WEB_CLIENT }, ...body }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`InnerTube ${endpoint} ${r.status}: ${t.slice(0, 160)}`);
  }
  const data = await r.json();
  rememberVisitor(data);
  return data;
}

function firstToken(root) {
  let found = null;
  const walk = (n, depth) => {
    if (found || !n || typeof n !== 'object' || depth > 20) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    if (typeof n.continuationCommand?.token === 'string') {
      found = n.continuationCommand.token;
      return;
    }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(root, 0);
  return found;
}

function commentsPanelToken(root) {
  for (const p of root.engagementPanels || []) {
    const s = p.engagementPanelSectionListRenderer;
    if (s && s.panelIdentifier === 'engagement-panel-comments-section') return firstToken(s);
  }
  return null;
}

// The page-tail token sits on the last continuationItemRenderer of the
// continuation response; reply tokens live inside individual threads.
function nextCommentsToken(root) {
  const eps = root.onResponseReceivedEndpoints || [];
  for (let i = eps.length - 1; i >= 0; i--) {
    const cmd = eps[i].reloadContinuationItemsCommand || eps[i].appendContinuationItemsAction;
    const items = cmd?.continuationItems || [];
    for (let k = items.length - 1; k >= 0; k--) {
      const t = items[k].continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (t) return t;
    }
  }
  return null;
}

function commentPayloads(root) {
  const out = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 26) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    const p = n.commentEntityPayload;
    if (p && p.properties && !seen.has(p.properties.commentId)) {
      seen.add(p.properties.commentId);
      out.push(p);
    }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(root, 0);
  return out;
}

export async function commentsPage(videoId, token) {
  let tok = token;
  if (!tok) {
    const first = await apiWeb('/youtubei/v1/next', { videoId });
    tok = commentsPanelToken(first);
    if (!tok) return { comments: [], token: null, disabled: true };
  }

  const j = await apiWeb('/youtubei/v1/next', { continuation: tok });
  const comments = [];
  for (const c of commentPayloads(j)) {
    const text = c.properties?.content?.content || '';
    if (!text) continue;
    comments.push({
      id: c.properties.commentId,
      author: c.author?.displayName || '',
      text,
      published: c.properties.publishedTime || '',
      likes: c.toolbar?.likeCountNotliked || c.toolbar?.likeCountLiked || '',
      replies: c.toolbar?.replyCount || '',
      pinned: !!c.properties.pinnedText,
      owner: !!c.author?.isCreator,
    });
  }
  return { comments, token: nextCommentsToken(j), disabled: false };
}

function text(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v.simpleText) return v.simpleText;
  if (v.content) return v.content;
  if (Array.isArray(v.runs)) return v.runs.map((r) => r.text || '').join('');
  return '';
}

function thumb(list) {
  const items = (list || []).filter((t) => t && t.url);
  if (!items.length) return '';
  items.sort((a, b) => (a.width || 0) - (b.width || 0));
  const pick = items.find((t) => (t.width || 0) >= 320) || items[items.length - 1];
  return pick.url.startsWith('//') ? `https:${pick.url}` : pick.url;
}

function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (typeof obj[key] === 'string') return obj[key];
  for (const k of Object.keys(obj)) {
    const found = deepFind(obj[k], key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// "1:02:03" / "10:00" / "LIVE" -> seconds. YouTube's tile duration text is the
// only length available on some surfaces; 0 means "unknown".
export function durationSeconds(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length < 2 || parts.length > 3) return 0;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  return Math.round(nums.reduce((total, n) => total * 60 + n, 0));
}

// Watch history and "Continue watching" shelves mark partial playback with a
// resume overlay. Its exact home differs by surface (videoRenderer, TV tile,
// lockup, playlist row), but every variant carries `percentDurationWatched`
// somewhere inside the video's own node. Walk just that node, not the whole
// feed, so one video's bar can never be attributed to another.
export function progressOf(node) {
  let pct = 0;
  let start = 0;
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 14) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    const p = Number(n.percentDurationWatched);
    if (Number.isFinite(p) && p > 0) pct = Math.max(pct, p);
    const s = Number(n.startTimeSeconds ?? n.resumeTimeSeconds ?? n.startTime);
    if (Number.isFinite(s) && s > 0) start = Math.max(start, s);
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(node, 0);
  return pct > 0 || start > 0 ? { pct, start: Math.round(start) } : null;
}

// --- viewers -------------------------------------------------------------

// Classic web/related-video renderer.
function fromVideoRenderer(v) {
  if (!v || !v.videoId) return null;
  const owner = v.ownerText?.runs?.[0];
  const labels = (v.badges || [])
    .map((b) => text(b.metadataBadgeRenderer?.label) || text(b.metadataBadgeRenderer?.accessibilityData?.label))
    .filter(Boolean)
    .join(' ');
  return {
    id: v.videoId,
    title: text(v.title) || text(v.headline),
    channel: text(v.ownerText) || text(v.longBylineText) || text(v.shortBylineText),
    channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId || '',
    duration: text(v.lengthText),
    views: text(v.viewCountText) || text(v.shortViewCountText),
    published: text(v.publishedTimeText),
    thumb: thumb(v.thumbnail?.thumbnails),
    ad: AD_META_RE.test(labels),
    resume: progressOf(v),
  };
}

// TV surface tile (used by TVHTML5 home, subscriptions and channels).
function fromTile(t) {
  if (!t) return null;
  const id =
    t.onSelectCommand?.watchEndpoint?.videoId ||
    t.navigationEndpoint?.watchEndpoint?.videoId ||
    deepFind(t, 'videoId');
  if (!id || id.length !== 11) return null;

  const header = t.header?.tileHeaderRenderer;
  const meta = t.metadata?.tileMetadataRenderer;
  const lines = meta?.lines || [];

  const lineText = (i) => {
    const items = lines[i]?.lineRenderer?.items || [];
    return items.map((it) => text(it.lineItemRenderer?.text)).filter(Boolean).join(' ');
  };

  const overlays = header?.thumbnailOverlays || [];
  const time = overlays
    .map((o) => o.thumbnailOverlayTimeStatusRenderer?.text)
    .map(text)
    .find(Boolean);

  const allLines = lines.map((_, i) => lineText(i)).filter(Boolean).join(' ');
  return {
    id,
    title: text(meta?.title),
    channel: lineText(0),
    channelId: deepFind(lines[0], 'browseId') || '',
    duration: time || '',
    views: lineText(1),
    published: '',
    thumb: thumb(header?.thumbnail?.thumbnails),
    ad: AD_META_RE.test(allLines),
    resume: progressOf(t),
  };
}

// New lockup model (used by TVHTML5 search and newer surfaces).
function fromLockup(l) {
  if (!l || typeof l.contentId !== 'string' || l.contentId.length !== 11) return null;
  if (l.contentType && !String(l.contentType).startsWith('LOCKUP_CONTENT_TYPE_')) return null;

  const meta = l.metadata?.lockupMetadataViewModel;
  const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
  const parts = rows.flatMap((r) => (r.metadataParts || []).map((p) => text(p.text)));
  const img = l.contentImage?.thumbnailViewModel;
  const badges =
    img?.overlays
      ?.map((o) => o.thumbnailBottomOverlayViewModel?.badges || [])
      .flat()
      .map((b) => text(b.thumbnailBadgeViewModel?.text))
      .filter(Boolean) || [];

  return {
    id: l.contentId,
    title: text(meta?.title),
    channel: parts[0] || '',
    channelId: '',
    duration: badges[0] || '',
    views: parts.slice(1).join(' · '),
    published: '',
    thumb: thumb(img?.image?.sources),
    ad:
      parts.some((p) => AD_META_RE.test(p)) ||
      badges.some((b) => AD_META_RE.test(b)),
    resume: progressOf(l),
  };
}

// --- collection ----------------------------------------------------------

// YouTube's promoted tiles arrive as ordinary-looking videos: a brand name,
// often with a leading bullet, and sometimes a "Sponsored" metadata row. There
// is no player URL to resolve for them (and they are ads), so drop them before
// the grid is built. This is deliberately conservative: only a leading bullet
// or an explicit sponsored label is treated as an ad.
const AD_META_RE = /(^|[\s·•])(sponsored|promoted|advertisement|paid promotion)([\s·•]|$)/i;

function isAdTitle(title) {
  return /^[\s•·●○◦▪▫■□◆◇※]+/.test(String(title || ''));
}

function looksLikeAd(v) {
  if (!v) return false;
  if (v.ad) return true;
  if (isAdTitle(v.title)) return true;
  return AD_META_RE.test(String(v.channel || '') + ' ' + String(v.views || ''));
}

// Shorts appear in the TV home feed in several shapes depending on the
// surface: reel renderers, a LOCKUP_CONTENT_TYPE_SHORT lockup, or a regular
// tile whose select command is a reelWatchEndpoint. On a TV they show up as
// portrait tiles, often with no title, so the home feed skips them.
function isShortsNode(n) {
  if (!n || typeof n !== 'object') return false;
  if (n.reelItemRenderer || n.shortsLockupViewModel || n.reelWatchEndpoint) return true;

  const lockup = n.lockupViewModel;
  if (lockup) {
    if (/SHORT/i.test(String(lockup.contentType || ''))) return true;
    const tap = lockup.rendererContext?.commandContext?.onTap?.innertubeCommand;
    if (tap?.reelWatchEndpoint) return true;
  }

  const tile = n.tileRenderer;
  if (tile) {
    const cmd = tile.onSelectCommand || tile.navigationEndpoint || {};
    if (cmd.reelWatchEndpoint) return true;
    const overlays = tile.header?.tileHeaderRenderer?.thumbnailOverlays || [];
    if (overlays.some((o) => o?.thumbnailOverlayTimeStatusRenderer?.style === 'SHORTS')) {
      return true;
    }
  }

  // Some responses mark a short only with the SHORTS time-status style.
  const video = n.videoRenderer || n.gridVideoRenderer || n.compactVideoRenderer;
  const overlays = video?.thumbnailOverlays || [];
  if (overlays.some((o) => o?.thumbnailOverlayTimeStatusRenderer?.style === 'SHORTS')) {
    return true;
  }

  return false;
}

export function collectVideos(root, opts = {}) {
  const skipShorts = !!opts.skipShorts;
  const out = [];
  const seen = new Set();

  const push = (v) => {
    if (!v || !v.id || seen.has(v.id)) return;
    // A leftover home tile with neither a title nor a duration is a Short the
    // surface did not label. Real videos always have at least one.
    if (skipShorts && !v.title && !v.duration) return;
    if (looksLikeAd(v)) return;
    seen.add(v.id);
    out.push(v);
  };

  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (skipShorts && isShortsNode(n)) return;
    if (
      n.adSlotRenderer ||
      n.promotedSparklesWebRenderer ||
      n.promotedVideoRenderer ||
      n.compactPromotedVideoRenderer ||
      n.displayAdRenderer ||
      n.inFeedAdRenderer
    ) {
      return;
    }
    if (n.videoRenderer) push(fromVideoRenderer(n.videoRenderer));
    if (n.gridVideoRenderer) push(fromVideoRenderer(n.gridVideoRenderer));
    if (n.compactVideoRenderer) push(fromVideoRenderer(n.compactVideoRenderer));
    if (n.playlistVideoRenderer) push(fromVideoRenderer(n.playlistVideoRenderer));
    if (n.videoWithContextRenderer) push(fromVideoRenderer(n.videoWithContextRenderer));
    if (n.tileRenderer) push(fromTile(n.tileRenderer));
    if (n.lockupViewModel) push(fromLockup(n.lockupViewModel));
    for (const k of Object.keys(n)) walk(n[k]);
  };

  walk(root);
  return out;
}

// --- continuations -------------------------------------------------------

function tokenOf(cont) {
  if (!cont) return '';
  return (
    cont.continuationCommand?.token ||
    cont.nextContinuationData?.continuation ||
    cont.button?.buttonRenderer?.command?.continuationCommand?.token ||
    ''
  );
}

// A feed response can contain many continuation tokens (one per shelf). The one
// that extends the whole page lives on the section list; shelf tokens are the
// fallback, and a plain deep scan is the last resort.
function findToken(root) {
  const feed = [];
  const items = [];
  const any = [];

  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 14) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    for (const c of n.sectionListRenderer?.continuations || []) feed.push(tokenOf(c));
    if (n.continuationItemRenderer) {
      items.push(tokenOf(n.continuationItemRenderer.continuationEndpoint));
    }
    if (typeof n.continuationCommand?.token === 'string') any.push(n.continuationCommand.token);
    if (typeof n.nextContinuationData?.continuation === 'string') {
      any.push(n.nextContinuationData.continuation);
    }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };

  walk(root, 0);
  return feed.find(Boolean) || items.find(Boolean) || any[0] || null;
}

// --- watch progress (read from YouTube, write back best-effort) ----------
//
// Reading: the signed-in history feed marks partially watched videos with a
// resume overlay. Cache the resulting map so a grid paint costs no request.
// Writing: the TV player response carries YouTube's own playback/watchtime
// URLs. They are only fetched once a video has actually been watched for a
// while, so an abandoned tile costs nothing.
const PROGRESS_TTL = 10 * 60 * 1000;
const TRACK_TTL = 30 * 60 * 1000;
const trackCache = new Map();
const trackingBusy = new Map();
let progressState = {
  at: 0,
  map: {},
  busy: null,
  stats: { videos: 0, withProgress: 0, pageErrors: 0 },
};

export function progressCached() {
  return progressState.map || {};
}

export function progressStats() {
  return progressState.stats;
}

function trackingFromPlayer(videoId, j) {
  const pt = j.playbackTracking || {};
  const playback = pt.videostatsPlaybackUrl?.baseUrl || '';
  const watchtime = pt.videostatsWatchtimeUrl?.baseUrl || '';
  if (!playback && !watchtime) return null;
  let length = Number(j.videoDetails?.lengthSeconds) || 0;
  if (!length) {
    try {
      const q = new URL(watchtime || playback).searchParams;
      length = Number(q.get('len')) || 0;
    } catch {}
  }
  const rec = { id: videoId, playback, watchtime, length, at: Date.now() };
  trackCache.set(videoId, rec);
  return rec;
}

function cachedTracking(id) {
  const rec = trackCache.get(id);
  if (rec && Date.now() - rec.at < TRACK_TTL) return rec;
  return null;
}

// Ask the TV player endpoint for the tracking URLs of one video. This is only
// called after the viewer has watched long enough to be worth syncing, so it
// never sits on the critical path of starting a video.
export async function fetchTracking(id) {
  const hit = cachedTracking(id);
  if (hit) return hit;
  if (!isSignedIn()) return null;
  if (trackingBusy.has(id)) return trackingBusy.get(id);
  const p = (async () => {
    const j = await api(
      '/youtubei/v1/player',
      {
        videoId: id,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
        },
      },
      { timeoutMs: 5000 }
    );
    const st = j.playabilityStatus || {};
    if (st.status !== 'OK') throw new Error('tracking: ' + (st.reason || st.status));
    return trackingFromPlayer(id, j);
  })().finally(() => trackingBusy.delete(id));
  trackingBusy.set(id, p);
  return p;
}

// The stats endpoint is not an InnerTube JSON API: it is a beacon URL. Send
// the same parameters YouTube's player (and yt-dlp's --mark-watched) uses.
// `first` also sends the playback ping; `full` marks the video finished.
export async function sendWatchStats({
  playback,
  watchtime,
  cpn,
  st = 0,
  et = 0,
  cmt = 0,
  first = false,
  full = false,
}) {
  const token = await getAccessToken().catch(() => null);
  const targets = [];
  if (watchtime) targets.push(watchtime);
  if (playback && (first || full)) targets.push(playback);
  const results = [];
  for (const base of targets) {
    const label = /watchtime/i.test(base) ? 'watchtime' : 'playback';
    const authModes = token ? [true, false] : [false];
    for (const withAuth of authModes) {
      try {
        const u = new URL(base);
        u.searchParams.set('ver', '2');
        u.searchParams.set('cpn', cpn);
        u.searchParams.set('cmt', String(Math.max(0, Math.round(full ? et : cmt))));
        u.searchParams.set('st', String(Math.max(0, Math.round(st))));
        u.searchParams.set('et', String(Math.max(0, Math.round(et))));
        u.searchParams.set('el', 'detailpage');
        const headers = {
          'user-agent': UA,
          origin: 'https://www.youtube.com',
          referer: 'https://www.youtube.com/tv',
        };
        if (withAuth) headers.authorization = `Bearer ${token}`;
        const r = await fetch(u, { headers, signal: AbortSignal.timeout(5000) });
        results.push({ url: label, status: r.status, auth: withAuth });
        // A rejected token is not a reason to give up: the beacon URL itself
        // may carry enough context for the signed-in TV session.
        if (r.ok || (r.status !== 401 && r.status !== 403)) break;
      } catch (e) {
        results.push({ url: label, status: 0, error: String(e.message).slice(0, 80) });
        break;
      }
    }
  }
  return results;
}

// A history page only shows the recent past; two pages is plenty for "resume
// what I was watching" and keeps the background request cheap.
export async function progressMap({ force = false, pages = 2 } = {}) {
  if (!isSignedIn()) return {};
  if (!force && progressState.map && Date.now() - progressState.at < PROGRESS_TTL) {
    return progressState.map;
  }
  if (progressState.busy) return progressState.busy;

  const p = (async () => {
    const map = {};
    let token = null;
    let videos = 0;
    let withProgress = 0;
    let pageErrors = 0;
    for (let i = 0; i < pages; i++) {
      let page;
      try {
        page = await browsePage('FEhistory', token);
      } catch (e) {
        pageErrors++;
        break;
      }
      for (const v of page.videos) {
        videos++;
        const r = v.resume;
        if (!r) continue;
        withProgress++;
        const d = durationSeconds(v.duration);
        const t = r.start > 0 ? r.start : d > 0 ? Math.round((d * r.pct) / 100) : 0;
        map[v.id] = {
          p: Math.min(100, Math.round(r.pct)),
          t: Math.round(t),
          d: Math.round(d),
          at: Date.now(),
        };
      }
      token = page.token;
      if (!token) break;
    }
    progressState = {
      at: Date.now(),
      map,
      busy: null,
      stats: { videos, withProgress, pageErrors },
    };
    return map;
  })();

  progressState = { ...progressState, busy: p };
  try {
    return await p;
  } catch (e) {
    // Keep the last good map; retry sooner than a full TTL.
    progressState = {
      ...progressState,
      busy: null,
      at: Date.now() - PROGRESS_TTL + 60_000,
    };
    throw e;
  }
}

export function warmProgress() {
  return progressMap().catch(() => {});
}

// Diagnostic that does not depend on the tile parser guessing right: if the
// signed-in history feed hides resume data in a renderer shape we do not know,
// this shows the overlay keys and percentages actually present.
function overlaySummary(node) {
  const out = [];
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 14 || out.length >= 12) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    for (const key of Object.keys(n)) {
      if (/^thumbnailOverlay/.test(key) && n[key] && typeof n[key] === 'object') {
        const obj = n[key];
        const summary = { key, fields: Object.keys(obj).slice(0, 10) };
        const pct = Number(obj.percentDurationWatched);
        if (Number.isFinite(pct)) summary.percent = pct;
        const txt = text(obj.text);
        if (txt) summary.text = txt;
        out.push(summary);
      }
      walk(n[key], depth + 1);
    }
  };
  walk(node, 0);
  return out;
}

export async function historyDebug(limit = 8) {
  const j = await api('/youtubei/v1/browse', { browseId: 'FEhistory' });
  const rows = [];
  let videos = 0;
  let withProgress = 0;
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 24 || rows.length >= limit) return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1);
      return;
    }
    const vr =
      n.videoRenderer || n.gridVideoRenderer || n.compactVideoRenderer ||
      n.playlistVideoRenderer || n.videoWithContextRenderer;
    const tr = n.tileRenderer;
    const lk = n.lockupViewModel;
    if (vr || tr || lk) {
      videos++;
      const node = vr || tr || lk;
      const id =
        vr?.videoId ||
        tr?.onSelectCommand?.watchEndpoint?.videoId ||
        tr?.navigationEndpoint?.watchEndpoint?.videoId ||
        (typeof lk?.contentId === 'string' ? lk.contentId : '');
      const p = progressOf(node);
      if (p) withProgress++;
      if (id && rows.length < limit) {
        rows.push({
          id,
          kind: vr ? 'videoRenderer' : tr ? 'tileRenderer' : 'lockupViewModel',
          dur: text(vr?.lengthText),
          resume: p,
          overlays: overlaySummary(node).slice(0, 8),
        });
      }
      return;
    }
    for (const k of Object.keys(n)) walk(n[k], depth + 1);
  };
  walk(j, 0);
  return { topKeys: Object.keys(j), videos, withProgress, rows };
}

// --- direct player lookup ------------------------------------------------
//
// yt-dlp is the reliable resolver, but on the Pi it costs 8-20 s (Python
// startup, webpage, player JSON). The signed-in TV session can ask YouTube's
// own TV player endpoint for the HLS manifest in one request. Callers use this
// only as a fast path and fall back to yt-dlp on any surprise.
const playerFailUntil = new Map();
let playerOfflineUntil = 0;


export async function playerHls(videoId) {
  if (!isSignedIn()) throw new Error('player: signed out');
  if (Date.now() < playerOfflineUntil) throw new Error('player fast path cooling down');
  const until = playerFailUntil.get(videoId) || 0;
  if (Date.now() < until) throw new Error('player fast path failed for this video');

  let j;
  try {
    j = await api(
      '/youtubei/v1/player',
      {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        // Do not send `params: 'CgIQBg=='` here. That parameter made even
        // otherwise-working clients answer ERROR ("This video is
        // unavailable") while the TV session was signed in, which tripped the
        // global cooldown and hid every later attempt.
        playbackContext: {
          contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
        },
      },
      { timeoutMs: 5000 }
    );
  } catch (e) {
    // A network/timeout failure is not video-specific: stop trying for a bit
    // so a broken fast path never adds five seconds to every play.
    playerOfflineUntil = Date.now() + 2 * 60 * 1000;
    throw e;
  }

  const st = j.playabilityStatus || {};
  if (st.status !== 'OK') {
    const reason = String(st.reason || st.status || 'player error').slice(0, 120);
    // Only an auth/bot failure means the fast path itself is broken. A plain
    // ERROR is usually this one video (members-only, removed, region), so
    // remember it per video instead of disabling the path for everything.
    if (/LOGIN_REQUIRED|bot|sign in/i.test(reason)) {
      playerOfflineUntil = Date.now() + 5 * 60 * 1000;
    } else {
      playerFailUntil.set(videoId, Date.now() + 10 * 60 * 1000);
    }
    throw new Error('player: ' + reason);
  }

  // Keep the tracking URLs even when there is no HLS manifest. The TV player
  // answer is the only place we can get YouTube's own watchtime beacons.
  try {
    trackingFromPlayer(videoId, j);
  } catch {}

  const sd = j.streamingData || {};
  const hls = sd.hlsManifestUrl || '';
  if (!hls) {
    playerFailUntil.set(videoId, Date.now() + 10 * 60 * 1000);
    throw new Error('player: no HLS manifest');
  }

  const vd = j.videoDetails || {};
  const liveNow = !!j.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow;
  return {
    hls,
    title: vd.title || '',
    duration: Number(vd.lengthSeconds) || 0,
    live: liveNow,
  };
}



export async function searchPage(query, token, opts) {
  const j = await api(
    '/youtubei/v1/search',
    token ? { continuation: token } : { query }
  );
  return { videos: collectVideos(j, opts), token: findToken(j), kind: 'search' };
}

export async function browsePage(browseId, token, opts) {
  const j = await api(
    '/youtubei/v1/browse',
    token ? { continuation: token } : { browseId }
  );
  return { videos: collectVideos(j, opts), token: findToken(j) };
}

export async function historyPage(token) {
  return { ...(await browsePage('FEhistory', token)), kind: 'history' };
}

export async function homePage(token) {
  // The TV is a landscape screen: keep Shorts out of the home feed only.
  // Search and history still return whatever the surface gives them.
  const opts = { skipShorts: true };
  if (token) {
    try {
      const p = await browsePage('FEwhat_to_watch', token, opts);
      if (p.videos.length) return { ...p, kind: 'home' };
    } catch {}
  }

  let page = { videos: [], token: null };
  try {
    page = await browsePage('FEwhat_to_watch', null, opts);
  } catch {}

  // Signed out (or history paused) the TV home surface is empty. Fall back so
  // the page is never a dead end, and keep the continuation kind in sync.
  if (!token && page.videos.length < 6) {
    try {
      const seen = new Set(page.videos.map((v) => v.id));
      const fallback = await searchPage('popular this week', null, opts);
      const videos = [...page.videos];
      for (const v of fallback.videos) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          videos.push(v);
        }
      }
      return { videos, token: fallback.token, kind: 'search' };
    } catch {}
  }
  return { ...page, kind: 'home' };
}

export function signedIn() {
  return isSignedIn();
}
