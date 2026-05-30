// POST /api/dream/delete  { id }
// Owner-only. Permanently deletes a dream record and removes it from
// every list it appears in: the global recent feed, the owner's
// user_dreams list, and the owner's per-device list.
//
// We deliberately leave inbox notifications about the dream in place
// (other users may have favorited it; their inbox can still link to the
// now-deleted record — the dream/[id] read just returns 404 and the
// inbox UI handles that gracefully).

export const config = { api: { bodyParser: true }, maxDuration: 10 };

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

async function kvCmd(path) {
  const r = await fetch(`${KV_URL}/${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const { id } = req.body || {};
  if (!id || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) return res.status(400).json({ error: 'bad_id' });

  // Auth
  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });
  const email = session.email;

  // Ownership
  const dream = await kvGet(`dream:${id}`);
  if (!dream) return res.status(404).json({ error: 'dream_not_found' });
  if (dream.owner_email && dream.owner_email.toLowerCase() !== email.toLowerCase()) {
    return res.status(403).json({ error: 'not_owner' });
  }

  try {
    // Remove from lists first (so a concurrent read doesn't fetch a deleted dream id)
    await kvCmd(`lrem/${encodeURIComponent('dreams:recent')}/0/${encodeURIComponent(id)}`);
    // user_dreams list — try both key encodings for safety
    await kvCmd(`lrem/${encodeURIComponent(`user_dreams:${email}`)}/0/${encodeURIComponent(id)}`);
    await kvCmd(`lrem/${encodeURIComponent(`user_dreams:${encodeURIComponent(email)}`)}/0/${encodeURIComponent(id)}`);
    if (dream.device_id) {
      await kvCmd(`lrem/${encodeURIComponent(`device:${dream.device_id}`)}/0/${encodeURIComponent(id)}`);
    }
    // Drop the dream record itself + its case-insensitive lookup pointer
    await kvCmd(`del/${encodeURIComponent(`dream:${id}`)}`);
    await kvCmd(`del/${encodeURIComponent(`dreamlc:${id.toLowerCase()}`)}`);
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('delete failed:', err);
    return res.status(500).json({ error: 'delete_failed', message: err.message });
  }
}
