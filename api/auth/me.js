// GET /api/auth/me
// Returns { signed_in: true, email } if a valid session cookie exists,
// otherwise { signed_in: false }.

export const config = { api: { bodyParser: false }, maxDuration: 5 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  if (!result) return null;
  if (typeof result !== 'string') return result;
  // `handle:*` keys store plain email strings; `user:*` etc. store JSON.
  try { return JSON.parse(result); } catch { return result; }
}

const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'd', 'dreams', 'inbox', 'library', 'login', 'logout',
  'me', 'new', 'profile', 'settings', 'signin', 'signout', 'signup', 'u', 'user',
  'about', 'help', 'home', 'public', 'static', 'images', 'assets', 'support',
  'mail', 'message', 'messages', 'team', 'root',
]);

async function pickHandle(email) {
  const base = (email.split('@')[0] || 'dreamer')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+/, '')
    .slice(0, 20) || 'dreamer';
  const candidates = [base, ...Array.from({ length: 30 }, (_, i) => `${base}${i + 1}`)];
  for (const cand of candidates) {
    if (cand.length < 3) continue;
    if (RESERVED_HANDLES.has(cand)) continue;
    const taken = await kvGet(`handle:${cand}`);
    if (!taken) return cand;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 24);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return res.status(200).json({ signed_in: false });

  const session = await kvGet(`session:${token}`);
  if (!session || !session.email) {
    // Stale cookie — clear it
    res.setHeader('Set-Cookie', 'dreams_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ signed_in: false });
  }

  // Also fetch user record for selfie + handle + display name
  let user = (await kvGet(`user:${session.email}`)) || {};

  // Lazy handle-backfill: any existing user without a handle gets one assigned
  // on their next /api/auth/me call. The verify.js path only fires on sign-in,
  // which excludes users who were created before the handle system existed.
  if (!user.handle) {
    const handle = await pickHandle(session.email);
    if (handle) {
      user.email = user.email || session.email;
      user.handle = handle;
      if (!user.display_name) user.display_name = session.email.split('@')[0];
      user.created_at = user.created_at || new Date().toISOString();
      await fetch(`${KV_URL}/set/user:${encodeURIComponent(session.email)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      });
      await fetch(`${KV_URL}/set/handle:${encodeURIComponent(handle)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(session.email),
      });
    }
  }

  // Pull unread inbox count (best-effort; never block the auth response on it)
  let unread_count = 0;
  try {
    const r = await fetch(`${KV_URL}/lrange/inbox:${encodeURIComponent(session.email)}/0/99`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (r.ok) {
      const { result } = await r.json();
      if (Array.isArray(result)) {
        for (const s of result) {
          try {
            const m = typeof s === 'string' ? JSON.parse(s) : s;
            if (m && !m.read) unread_count++;
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  return res.status(200).json({
    signed_in: true,
    email: session.email,
    handle: user.handle || null,
    display_name: user.display_name || session.email.split('@')[0],
    selfie_url: user.selfie_url || null,
    unread_count,
  });
}
