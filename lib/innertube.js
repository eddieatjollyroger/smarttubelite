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

async function api(endpoint, body) {
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
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`InnerTube ${endpoint} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
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

// --- viewers -------------------------------------------------------------

// Classic web/related-video renderer.
function fromVideoRenderer(v) {
  if (!v || !v.videoId) return null;
  const owner = v.ownerText?.runs?.[0];
  return {
    id: v.videoId,
    title: text(v.title) || text(v.headline),
    channel: text(v.ownerText) || text(v.longBylineText) || text(v.shortBylineText),
    channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId || '',
    duration: text(v.lengthText),
    views: text(v.viewCountText) || text(v.shortViewCountText),
    published: text(v.publishedTimeText),
    thumb: thumb(v.thumbnail?.thumbnails),
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

  return {
    id,
    title: text(meta?.title),
    channel: lineText(0),
    channelId: deepFind(lines[0], 'browseId') || '',
    duration: time || '',
    views: lineText(1),
    published: '',
    thumb: thumb(header?.thumbnail?.thumbnails),
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
  };
}

// --- collection ----------------------------------------------------------

export function collectVideos(root) {
  const out = [];
  const seen = new Set();

  const push = (v) => {
    if (!v || !v.id || seen.has(v.id)) return;
    seen.add(v.id);
    out.push(v);
  };

  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
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

// --- public API ----------------------------------------------------------

export async function searchPage(query, token) {
  const j = await api(
    '/youtubei/v1/search',
    token ? { continuation: token } : { query }
  );
  return { videos: collectVideos(j), token: findToken(j), kind: 'search' };
}

export async function browsePage(browseId, token) {
  const j = await api(
    '/youtubei/v1/browse',
    token ? { continuation: token } : { browseId }
  );
  return { videos: collectVideos(j), token: findToken(j) };
}

export async function historyPage(token) {
  return { ...(await browsePage('FEhistory', token)), kind: 'history' };
}

export async function homePage(token) {
  if (token) {
    try {
      const p = await browsePage('FEwhat_to_watch', token);
      if (p.videos.length) return { ...p, kind: 'home' };
    } catch {}
  }

  let page = { videos: [], token: null };
  try {
    page = await browsePage('FEwhat_to_watch');
  } catch {}

  // Signed out (or history paused) the TV home surface is empty. Fall back so
  // the page is never a dead end, and keep the continuation kind in sync.
  if (!token && page.videos.length < 6) {
    try {
      const seen = new Set(page.videos.map((v) => v.id));
      const fallback = await searchPage('popular this week');
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
