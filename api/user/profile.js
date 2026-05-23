// GET  /api/user/profile                  → signed-in user's own profile
// GET  /api/user/profile?handle=joe       → that public profile + their public dreams
// PATCH /api/user/profile { display_name?, handle?, bio?, contact_links? } → update own
//
// Handle rules: 3–24 chars, lowercase a–z 0–9 _ -, unique. Auto-claimed on signup
// (see api/auth/verify.js); user can rename here. We keep `handle:{handle}` → email
// as the unique-handle index, so renaming reserves the new handle then frees the old.

export const config = { api: { bodyParser: true }, maxDuration: 8 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const HANDLE_RX = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'd', 'dreams', 'inbox', 'library', 'login', 'logout',
  'me', 'new', 'profile', 'settings', 'signin', 'signout', 'signup', 'u', 'user',
  'about', 'help', 'home', 'public', 'static', 'images', 'assets', 'support',
  'mail', 'message', 'messages', 'team', 'admin', 'root',
]);

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  if (!result) return null;
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

async function kvDel(key) {
  const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

async function getSignedInEmail(req) {
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return null;
  const session = await kvGet(`session:${token}`);
  return session?.email || null;
}

function publicShape(user, opts = {}) {
  if (!user) return null;
  const out = {
    handle: user.handle || null,
    display_name: user.display_name || (user.email ? user.email.split('@')[0] : null),
    bio: user.bio || null,
    contact_links: Array.isArray(user.contact_links) ? user.contact_links.slice(0, 4) : [],
    selfie_url: user.selfie_url || null,
    created_at: user.created_at,
  };
  if (opts.includeEmail) out.email = user.email;
  return out;
}

async function fetchPublicDreamsForEmail(email) {
  // Try user_dreams list first (literal + percent-encoded keys), then fall back to scanning recent.
  const tried = new Set();
  let ids = [];
  for (const key of [`user_dreams:${email}`, `user_dreams:${encodeURIComponent(email)}`]) {
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const r = await fetch(`${KV_URL}/lrange/${key}/0/99`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (!r.ok) continue;
      const { result } = await r.json();
      if (Array.isArray(result)) for (const id of result) if (!ids.includes(id)) ids.push(id);
    } catch (_) {}
  }
  if (ids.length === 0) return [];

  // Batch fetch the dream records and filter to public.
  const keys = ids.map((id) => `dream:${id}`);
  const mget = await fetch(`${KV_URL}/mget/${keys.join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!mget.ok) return [];
  const { result: values } = await mget.json();
  return (values || [])
    .map((v) => { if (!v) return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } })
    .filter(Boolean)
    .filter((d) => d.visibility !== 'private') // default public
    .map((d) => ({
      id: d.id,
      title: d.title || d.analysis?.title || null,
      text_preview: (d.text || '').slice(0, 200),
      pattern_name: d.analysis?.pattern_name || null,
      morph_count: Array.isArray(d.analysis?.morphs) ? d.analysis.morphs.length : 0,
      word_count: d.word_count || (d.text || '').split(/\s+/).filter(Boolean).length,
      image_url: d.image_url || null,
      created_at: d.created_at,
    }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  // --------- GET ----------
  if (req.method === 'GET') {
    const handle = (req.query.handle || '').toString().trim().toLowerCase();
    if (handle) {
      // Public profile lookup
      if (!HANDLE_RX.test(handle)) return res.status(400).json({ error: 'bad_handle' });
      const email = await kvGet(`handle:${handle}`);
      if (!email) return res.status(404).json({ error: 'not_found' });
      const user = await kvGet(`user:${email}`);
      if (!user) return res.status(404).json({ error: 'not_found' });
      const dreams = await fetchPublicDreamsForEmail(email);
      return res.status(200).json({ profile: publicShape(user), dreams });
    }

    // Own profile
    const email = await getSignedInEmail(req);
    if (!email) return res.status(401).json({ error: 'not_signed_in' });
    const user = await kvGet(`user:${email}`);
    if (!user) return res.status(404).json({ error: 'no_user_record' });
    return res.status(200).json({ profile: publicShape(user, { includeEmail: true }) });
  }

  // --------- PATCH ----------
  if (req.method === 'PATCH' || req.method === 'POST') {
    const email = await getSignedInEmail(req);
    if (!email) return res.status(401).json({ error: 'not_signed_in' });
    const user = (await kvGet(`user:${email}`)) || { email, created_at: new Date().toISOString() };

    const { display_name, handle, bio, contact_links } = req.body || {};
    const patch = {};

    if (typeof display_name === 'string') {
      const dn = display_name.trim().slice(0, 50);
      if (dn.length < 1) return res.status(400).json({ error: 'bad_display_name' });
      patch.display_name = dn;
    }

    if (typeof bio === 'string') {
      patch.bio = bio.trim().slice(0, 280);
    }

    if (Array.isArray(contact_links)) {
      const cleaned = contact_links
        .filter((l) => l && typeof l.label === 'string' && typeof l.url === 'string')
        .slice(0, 4)
        .map((l) => ({
          label: l.label.trim().slice(0, 24),
          url: l.url.trim().slice(0, 200),
        }))
        .filter((l) => l.label && /^https?:\/\//.test(l.url));
      patch.contact_links = cleaned;
    }

    let oldHandle = null;
    let newHandle = null;
    if (typeof handle === 'string') {
      const h = handle.trim().toLowerCase();
      if (!HANDLE_RX.test(h)) return res.status(400).json({ error: 'bad_handle', message: 'Handles are 3–24 chars: a–z, 0–9, _ or -.' });
      if (RESERVED_HANDLES.has(h)) return res.status(409).json({ error: 'reserved_handle' });
      if (user.handle !== h) {
        const owner = await kvGet(`handle:${h}`);
        if (owner && owner !== email) return res.status(409).json({ error: 'handle_taken' });
        oldHandle = user.handle || null;
        newHandle = h;
        patch.handle = h;
      }
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });

    const updated = { ...user, ...patch, updated_at: new Date().toISOString() };
    await kvSet(`user:${email}`, JSON.stringify(updated));
    if (newHandle) {
      await kvSet(`handle:${newHandle}`, email);
      if (oldHandle && oldHandle !== newHandle) await kvDel(`handle:${oldHandle}`);
    }
    return res.status(200).json({ profile: publicShape(updated, { includeEmail: true }) });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
