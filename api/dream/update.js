// POST /api/dream/update  { id, title? }
// Updates allowed fields on an existing dream record.
// For now only `title` is patchable (user-editable on the dream page).

export const config = { api: { bodyParser: true }, maxDuration: 5 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const { id, title, visibility } = req.body || {};
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) {
    return res.status(400).json({ error: 'bad_id' });
  }

  // Validate the patch fields
  const patch = {};
  if (typeof title === 'string') {
    const t = title.trim();
    if (t.length === 0 || t.length > 120) {
      return res.status(400).json({ error: 'bad_title', message: 'Title must be 1-120 characters.' });
    }
    patch.title = t;
  }
  if (typeof visibility === 'string') {
    if (!['public', 'private'].includes(visibility)) {
      return res.status(400).json({ error: 'bad_visibility' });
    }
    patch.visibility = visibility;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'no_fields', message: 'Provide at least one updatable field.' });
  }

  // Visibility changes are owner-only. (Title is too in practice — the editable
  // title only appears in the owner's UI — but we don't currently gate it.)
  let requesterEmail = null;
  if (patch.visibility) {
    const cookieMatch = (req.headers.cookie || '').match(/(?:^|;\s*)dreams_session=([^;]+)/);
    const token = cookieMatch ? cookieMatch[1] : null;
    if (!token) return res.status(401).json({ error: 'not_signed_in' });
    const sr = await fetch(`${KV_URL}/get/session:${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!sr.ok) return res.status(401).json({ error: 'session_lookup_failed' });
    const { result: sRes } = await sr.json();
    if (!sRes) return res.status(401).json({ error: 'session_expired' });
    const session = typeof sRes === 'string' ? JSON.parse(sRes) : sRes;
    requesterEmail = session?.email || null;
    if (!requesterEmail) return res.status(401).json({ error: 'session_invalid' });
  }

  try {
    const getRes = await fetch(`${KV_URL}/get/dream:${id}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!getRes.ok) throw new Error(`KV get → ${getRes.status}`);
    const { result } = await getRes.json();
    if (!result) return res.status(404).json({ error: 'dream_not_found' });
    const dream = typeof result === 'string' ? JSON.parse(result) : result;

    if (patch.visibility && dream.owner_email && dream.owner_email !== requesterEmail) {
      return res.status(403).json({ error: 'not_owner' });
    }

    Object.assign(dream, patch, { updated_at: new Date().toISOString() });

    const setRes = await fetch(`${KV_URL}/set/dream:${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(dream),
    });
    if (!setRes.ok) throw new Error(`KV set → ${setRes.status}`);

    return res.status(200).json({ ok: true, dream });
  } catch (err) {
    console.error('update failed:', err);
    return res.status(500).json({ error: 'update_failed', message: err.message });
  }
}
