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

// --- public API ----------------------------------------------------------

export async function search(query) {
  const j = await api('/youtubei/v1/search', { query });
  return collectVideos(j);
}

export async function subscriptions() {
  const j = await api('/youtubei/v1/browse', { browseId: 'FEsubscriptions' });
  return collectVideos(j);
}

export async function home() {
  let videos = [];
  try {
    const j = await api('/youtubei/v1/browse', { browseId: 'FEwhat_to_watch' });
    videos = collectVideos(j);
  } catch {}

  // Signed out (or history paused) the TV home surface is empty. Fall back so
  // the page is never a dead end.
  if (videos.length < 6) {
    try {
      const seen = new Set(videos.map((v) => v.id));
      for (const v of await search('popular this week')) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          videos.push(v);
        }
      }
    } catch {}
  }
  return videos;
}

export function signedIn() {
  return isSignedIn();
}
