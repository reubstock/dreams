// GET /api/user/favorites
// Returns the signed-in user's favorited dreams (newest first).
// 401 if not signed in. Empty array if nothing favorited.

export const config = { api: { bodyParser: false }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });
  const email = session.email;

  const listKey = `user_favorites:${email}`;
  const lr = await fetch(`${KV_URL}/lrange/${encodeURIComponent(listKey)}/0/199`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!lr.ok) return res.status(200).json({ email, dreams: [] });
  const { result } = await lr.json();
  let ids = Array.isArray(result) ? result : [];
  // De-dup (LPUSH can leave duplicates if a user re-favorites)
  ids = [...new Set(ids)];
  if (ids.length === 0) return res.status(200).json({ email, dreams: [] });

  const keys = ids.map((id) => `dream:${id}`);
  const mget = await fetch(`${KV_URL}/mget/${keys.join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!mget.ok) return res.status(500).json({ error: 'mget_failed' });
  const { result: values } = await mget.json();

  const dreams = (values || [])
    .map((v) => { if (!v) return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } })
    .filter(Boolean)
    // Skip private dreams owned by someone else (in case visibility flipped after favorite)
    .filter((d) => {
      if (d.visibility !== 'private') return true;
      return d.owner_email && d.owner_email.toLowerCase() === email.toLowerCase();
    })
    .map((d) => ({
      id: d.id,
      title: d.title || d.analysis?.title || null,
      text_preview: (d.text || '').slice(0, 200),
      pattern_name: d.analysis?.pattern_name || null,
      morph_count: Array.isArray(d.analysis?.morphs) ? d.analysis.morphs.length : 0,
      word_count: d.word_count || (d.text || '').split(/\s+/).filter(Boolean).length,
      image_url: d.image_url || null,
      owner_handle: d.owner_handle || null,
      owner_display_name: d.owner_display_name || null,
      created_at: d.created_at,
    }));

  return res.status(200).json({ email, dreams });
}
