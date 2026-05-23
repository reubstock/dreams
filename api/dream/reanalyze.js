// POST /api/dream/reanalyze  { id }
// Owner-only. Re-runs /api/analyze on the dream's existing text and replaces
// the analysis block. Useful for dreams analyzed under earlier prompt versions
// (e.g. before the "3 cultural relatives" rule landed).

export const config = { api: { bodyParser: true }, maxDuration: 60 };

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const { id } = req.body || {};
  if (!id || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) return res.status(400).json({ error: 'bad_id' });

  // Auth + ownership
  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });
  const dream = await kvGet(`dream:${id}`);
  if (!dream) return res.status(404).json({ error: 'dream_not_found' });
  if (dream.owner_email && dream.owner_email !== session.email) {
    return res.status(403).json({ error: 'not_owner' });
  }
  if (!dream.text || dream.text.length < 20) return res.status(400).json({ error: 'no_text' });

  // Re-analyze via the existing /api/analyze endpoint to share its prompt + schema.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'dreams-livid.vercel.app';
  const base = `${proto}://${host}`;
  const ar = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: dream.text, dreamer: dream.dreamer }),
  });
  if (!ar.ok) {
    const data = await ar.json().catch(() => ({}));
    return res.status(502).json({ error: 'analyze_failed', detail: data });
  }
  const { analysis } = await ar.json();

  // Persist
  const updated = { ...dream, analysis, updated_at: new Date().toISOString() };
  if (analysis?.title && typeof analysis.title === 'string') {
    if (!dream.title) updated.title = analysis.title.trim();
  }
  const sr = await fetch(`${KV_URL}/set/dream:${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  if (!sr.ok) return res.status(500).json({ error: 'save_failed' });

  return res.status(200).json({ ok: true, dream: updated });
}
