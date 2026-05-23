// GET /api/message/inbox        → { messages: [...], unread_count }
// Returns the signed-in user's inbox (newest first). Strips sender email.

export const config = { api: { bodyParser: false }, maxDuration: 8 };

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
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });

  try {
    const r = await fetch(`${KV_URL}/lrange/inbox:${encodeURIComponent(session.email)}/0/99`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return res.status(200).json({ messages: [], unread_count: 0 });
    const { result } = await r.json();
    if (!Array.isArray(result)) return res.status(200).json({ messages: [], unread_count: 0 });

    const messages = result
      .map((s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch (_) { return null; } })
      .filter(Boolean)
      .map((m) => {
        // Strip sender's email from client response.
        const { from_email, ...safe } = m;
        return safe;
      });
    const unread_count = messages.filter((m) => !m.read).length;
    return res.status(200).json({ messages, unread_count });
  } catch (err) {
    console.error('inbox fetch error', err);
    return res.status(500).json({ error: 'fetch_failed' });
  }
}
