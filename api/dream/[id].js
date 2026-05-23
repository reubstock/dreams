// GET /api/dream/:id
// Returns the full saved dream record from Redis.

export const config = { api: { bodyParser: false }, maxDuration: 10 };

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

    // Resolve prev/next neighbors from the global recent list. dreams:recent is
    // lpushed (newest at index 0). "Next" = newer than this dream (smaller idx);
    // "Prev" = older (larger idx). Skip private dreams; bail out if we'd walk too far.
    let prev_id = null, next_id = null;
    try {
      const lr = await fetch(`${KV_URL}/lrange/dreams:recent/0/199`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (lr.ok) {
        const { result: ids } = await lr.json();
        if (Array.isArray(ids) && ids.length) {
          const myIdx = ids.indexOf(id);
          if (myIdx !== -1) {
            const fetchVis = async (otherId) => {
              try {
                const rr = await fetch(`${KV_URL}/get/dream:${otherId}`, {
                  headers: { Authorization: `Bearer ${KV_TOKEN}` },
                });
                if (!rr.ok) return null;
                const { result: rv } = await rr.json();
                if (!rv) return null;
                const d = typeof rv === 'string' ? JSON.parse(rv) : rv;
                return d.visibility === 'private' ? 'private' : 'public';
              } catch (_) { return null; }
            };
            for (let i = myIdx - 1; i >= Math.max(0, myIdx - 20); i--) {
              const v = await fetchVis(ids[i]);
              if (v === 'public') { next_id = ids[i]; break; }
            }
            for (let i = myIdx + 1; i < Math.min(ids.length, myIdx + 21); i++) {
              const v = await fetchVis(ids[i]);
              if (v === 'public') { prev_id = ids[i]; break; }
            }
          }
        }
      }
    } catch (_) {}

    return res.status(200).json({ dream, prev_id, next_id });
  } catch (err) {
    console.error('get failed:', err);
    return res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
}
