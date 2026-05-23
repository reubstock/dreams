// POST /api/message/read   { id?, all? }
// Marks a single message (by id) or every message as read on the signed-in
// user's inbox. We re-write the whole list once with the read flag flipped.

export const config = { api: { bodyParser: true }, maxDuration: 8 };

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });

  const { id, all } = req.body || {};
  const inboxKey = `inbox:${encodeURIComponent(session.email)}`;

  try {
    const lr = await fetch(`${KV_URL}/lrange/${inboxKey}/0/199`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!lr.ok) return res.status(500).json({ error: 'lrange_failed' });
    const { result } = await lr.json();
    if (!Array.isArray(result)) return res.status(200).json({ ok: true, updated: 0 });

    let updated = 0;
    const next = result.map((s) => {
      let m;
      try { m = typeof s === 'string' ? JSON.parse(s) : s; } catch (_) { return s; }
      if (!m) return s;
      if (all || (id && m.id === id)) {
        if (!m.read) { m.read = true; updated++; }
      }
      return JSON.stringify(m);
    });

    if (updated === 0) return res.status(200).json({ ok: true, updated: 0 });

    // Rewrite the list: DEL then RPUSH all (in original order)
    await fetch(`${KV_URL}/del/${inboxKey}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    // Upstash REST: rpush multiple values comma path: rpush/key/v1/v2...
    // Safer to do one at a time to handle JSON-encoded values containing slashes.
    for (const v of next) {
      await fetch(`${KV_URL}/rpush/${inboxKey}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: v,
      });
    }

    return res.status(200).json({ ok: true, updated });
  } catch (err) {
    console.error('mark read failed', err);
    return res.status(500).json({ error: 'mark_failed', message: err.message });
  }
}
