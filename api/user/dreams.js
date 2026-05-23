// GET /api/user/dreams
// Returns the current signed-in user's dreams (newest first).
// 401 if not signed in.

export const config = { api: { bodyParser: false }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
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
  if (!session || !session.email) return res.status(401).json({ error: 'session_expired' });
  const email = session.email;

  // Get user's dream IDs (newest first).
  // We try several key encodings to handle any historical inconsistency between
  // what save.js wrote and what we're reading here. Upstash may or may not
  // URL-decode the key from the path — we try both forms and union the results.
  const keyVariants = [
    `user_dreams:${email}`,                       // literal @
    `user_dreams:${encodeURIComponent(email)}`,   // %40 form
  ];
  let ids = [];
  for (const key of keyVariants) {
    try {
      const r = await fetch(`${KV_URL}/lrange/${key}/0/99`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (!r.ok) continue;
      const { result } = await r.json();
      if (Array.isArray(result) && result.length > 0) {
        // De-dup if both keys had overlap
        for (const id of result) if (!ids.includes(id)) ids.push(id);
      }
    } catch (_) {}
  }

  // Final fallback: scan recent dreams and pluck those whose owner_email matches.
  // Covers any dream saved before user_dreams lists existed.
  if (ids.length === 0) {
    try {
      const recentRes = await fetch(`${KV_URL}/lrange/dreams:recent/0/199`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (recentRes.ok) {
        const { result: recentIds } = await recentRes.json();
        if (Array.isArray(recentIds) && recentIds.length) {
          const keys = recentIds.map((id) => `dream:${id}`);
          const mget = await fetch(`${KV_URL}/mget/${keys.join('/')}`, {
            headers: { Authorization: `Bearer ${KV_TOKEN}` },
          });
          if (mget.ok) {
            const { result: vals } = await mget.json();
            (vals || []).forEach((v, i) => {
              if (!v) return;
              try {
                const d = typeof v === 'string' ? JSON.parse(v) : v;
                if (d.owner_email && d.owner_email.toLowerCase() === email.toLowerCase()) {
                  ids.push(recentIds[i]);
                }
              } catch (_) {}
            });
          }
        }
      }
    } catch (_) {}
  }

  if (ids.length === 0) {
    return res.status(200).json({ email, dreams: [] });
  }

  // MGET each dream
  const keys = ids.map((id) => `dream:${id}`);
  const mgetRes = await fetch(`${KV_URL}/mget/${keys.join('/')}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!mgetRes.ok) return res.status(500).json({ error: 'mget_failed' });
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
      image_url: d.image_url || null,
      visibility: d.visibility || 'public',
      created_at: d.created_at,
    }));

  return res.status(200).json({ email, dreams });
}
