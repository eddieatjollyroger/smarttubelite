// YouTube "TV" OAuth device-code flow.
// These are the public client credentials the YouTube TV app uses. No secret of yours.
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PENDING_FILE = path.join(DATA_DIR, 'pending.json');

let pending = loadPending();
// RFC 8628 grant type. Older YouTube builds used the legacy string; fall back
// automatically if the endpoint rejects the modern one.
let grantType = 'urn:ietf:params:oauth:grant-type:device_code';
const LEGACY_GRANT = 'http://oauth.net/grant_type/device/1.0';

export function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveAuth(a) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}

// The device code must survive a server restart: the user may approve it while
// the process is down, and a lost code means a confusing "nothing happened".
function loadPending() {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    if (p?.device_code && Date.now() - p.started < (p.expires_in || 1800) * 1000) return p;
  } catch {}
  return null;
}

function savePending(p) {
  try {
    if (!p) fs.unlinkSync(PENDING_FILE);
  } catch {}
  if (!p) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(p), { mode: 0o600 });
}

export function signOut() {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch {}
  pending = null;
  savePending(null);
}

export function isSignedIn() {
  return !!loadAuth()?.refresh_token;
}

async function post(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: new URLSearchParams(params),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} -> ${r.status}: ${text.slice(0, 200)}`);
  }
  return { status: r.status, json };
}

function publicPending() {
  return {
    user_code: pending.user_code,
    verification_url: pending.verification_url || 'https://www.google.com/device',
    expires_in: Math.max(0, Math.round(pending.expires_in - (Date.now() - pending.started) / 1000)),
    interval: pending.interval || 5,
  };
}

export function startLogin({ force = false } = {}) {
  // Reuse the in-flight code. Creating a new one on every page load silently
  // orphans whatever the user is about to approve on their phone.
  if (!force && pending && Date.now() - pending.started < pending.expires_in * 1000) {
    return Promise.resolve(publicPending());
  }
  return requestLogin();
}

async function requestLogin() {
  const { status, json } = await post('https://www.youtube.com/o/oauth2/device/code', {
    client_id: CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/youtube',
  });
  if (status !== 200 || !json.user_code) {
    throw new Error(json.error_description || json.error || `device code failed (${status})`);
  }
  pending = { ...json, started: Date.now() };
  savePending(pending);
  return publicPending();
}

export function loginState() {
  if (!pending) return { status: 'idle' };
  if (Date.now() - pending.started > pending.expires_in * 1000) {
    pending = null;
    savePending(null);
    return { status: 'expired' };
  }
  return { status: 'waiting', ...publicPending() };
}

export async function pollLogin() {
  if (!pending) return { status: 'idle' };
  if (Date.now() - pending.started > pending.expires_in * 1000) {
    pending = null;
    savePending(null);
    return { status: 'expired' };
  }

  const tokenParams = (gt) => {
    const p = {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: gt,
    };
    // RFC 8628 uses `device_code`; the legacy YouTube grant used `code`.
    if (gt === LEGACY_GRANT) p.code = pending.device_code;
    else p.device_code = pending.device_code;
    return p;
  };

  let { json } = await post('https://www.youtube.com/o/oauth2/token', tokenParams(grantType));
  if (json.error === 'unsupported_grant_type' && grantType !== LEGACY_GRANT) {
    grantType = LEGACY_GRANT;
    ({ json } = await post('https://www.youtube.com/o/oauth2/token', tokenParams(grantType)));
  }

  if (json.error === 'authorization_pending' || json.error === 'slow_down') {
    return {
      status: 'pending',
      interval: json.error === 'slow_down' ? 10 : pending.interval,
      ...publicPending(),
    };
  }
  if (json.error) {
    pending = null;
    savePending(null);
    return { status: 'error', error: json.error, description: json.error_description };
  }

  saveAuth({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000 - 60_000,
    obtained_at: Date.now(),
  });
  pending = null;
  savePending(null);
  return { status: 'ok' };
}

export async function getAccessToken() {
  const a = loadAuth();
  if (!a) return null;
  if (a.access_token && a.expires_at > Date.now() + 10_000) return a.access_token;
  if (!a.refresh_token) return null;

  const { json } = await post('https://www.youtube.com/o/oauth2/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: a.refresh_token,
    grant_type: 'refresh_token',
  });
  if (!json.access_token) return null;

  a.access_token = json.access_token;
  a.expires_at = Date.now() + (json.expires_in || 3600) * 1000 - 60_000;
  if (json.refresh_token) a.refresh_token = json.refresh_token;
  saveAuth(a);
  return a.access_token;
}
