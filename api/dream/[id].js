// GET /api/dream/:id
// Returns the full saved dream record from Redis.

export const config = { api: { bodyParser: false }, maxDuration: 5 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'storage_not_configured' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) {
    return res.status(400).json({ error: 'bad_id' });
  }

  try {
    const r = await fetch(`${KV_URL}/get/dream:${id}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) throw new Error(`KV get → ${r.status}`);
    const { result } = await r.json();
    if (!result) return res.status(404).json({ error: 'not_found', id });
    const dream = typeof result === 'string' ? JSON.parse(result) : result;
    return res.status(200).json({ dream });
  } catch (err) {
    console.error('get failed:', err);
    return res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
}
