// POST /api/dream/claim  { id }
// Claim an orphan dream (owner_email is null) for the signed-in user.
// Used to backfill ownership on dreams recorded before sign-in.
// Refuses if the dream already has a different owner.

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

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
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

  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });
  const email = session.email;

  const dream = await kvGet(`dream:${id}`);
  if (!dream) return res.status(404).json({ error: 'dream_not_found' });
  if (dream.owner_email && dream.owner_email.toLowerCase() !== email.toLowerCase()) {
    return res.status(403).json({ error: 'already_claimed' });
  }

  // Fetch owner record for handle + display name
  const user = await kvGet(`user:${email}`);

  dream.owner_email = email;
  if (user?.handle && !dream.owner_handle) dream.owner_handle = user.handle;
  if (user?.display_name && !dream.owner_display_name) dream.owner_display_name = user.display_name;

  try {
    await kvSet(`dream:${id}`, JSON.stringify(dream));
    // Add to the user's dreams list (both encodings, to match save.js)
    await kvCmd(`lpush/${encodeURIComponent(`user_dreams:${email}`)}/${encodeURIComponent(id)}`);
    await kvCmd(`lpush/${encodeURIComponent(`user_dreams:${encodeURIComponent(email)}`)}/${encodeURIComponent(id)}`);
    return res.status(200).json({ ok: true, id, owner_handle: dream.owner_handle });
  } catch (err) {
    console.error('claim failed:', err);
    return res.status(500).json({ error: 'claim_failed', message: err.message });
  }
}
