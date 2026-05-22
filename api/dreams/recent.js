// GET /api/dreams/recent?limit=10
// Returns the N most recent dreams (newest first), slimmed for feed display.

export const config = { api: { bodyParser: false }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

  try {
    // Get the most recent IDs
    const idsRes = await fetch(`${KV_URL}/lrange/dreams:recent/0/${limit - 1}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!idsRes.ok) throw new Error(`lrange → ${idsRes.status}`);
    const { result: ids } = await idsRes.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(200).json({ dreams: [] });
    }

    // Use MGET to fetch all dreams in one round-trip
    const keys = ids.map((id) => `dream:${id}`);
    const mgetUrl = `${KV_URL}/mget/${keys.join('/')}`;
    const mgetRes = await fetch(mgetUrl, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!mgetRes.ok) throw new Error(`mget → ${mgetRes.status}`);
    const { result: values } = await mgetRes.json();

    const dreams = (values || [])
      .map((v) => {
        if (!v) return null;
        try { return typeof v === 'string' ? JSON.parse(v) : v; }
        catch (_) { return null; }
      })
      .filter(Boolean)
      .map((d) => ({
        id: d.id,
        title: d.title || d.analysis?.title || null,
        text_preview: (d.text || '').slice(0, 200),
        pattern_name: d.analysis?.pattern_name || null,
        morph_count: Array.isArray(d.analysis?.morphs) ? d.analysis.morphs.length : 0,
        word_count: d.word_count || (d.text || '').split(/\s+/).filter(Boolean).length,
        created_at: d.created_at,
      }));

    return res.status(200).json({ dreams });
  } catch (err) {
    console.error('recent failed:', err);
    return res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
}
