// GET /api/admin/list-bred
// Owner-only (reubstock@gmail.com). Returns the IDs of all dreams in
// the recent feed that were created via /api/dream/breed (kind === 'bred').
//
// Purpose: reversion playbook for the breeding experiment.
// Quick cleanup:
//   curl https://dreams-livid.vercel.app/api/admin/list-bred \
//     -b 'dreams_session=<your-session-cookie>' \
//   | jq -r '.bred[].id' \
//   | while read id; do
//       curl -X POST https://dreams-livid.vercel.app/api/dream/delete \
//         -H 'Content-Type: application/json' \
//         -b 'dreams_session=<your-session-cookie>' \
//         -d "{\"id\":\"$id\"}";
//     done
//
// Caveat: only scans dreams:recent (last 200). Sufficient for the experiment
// window — if breeding survives long-term, swap this for an Upstash SCAN.

export const config = { api: { bodyParser: false }, maxDuration: 30 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ADMIN_EMAIL = 'reubstock@gmail.com';

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
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'kv_not_configured' });

  // Admin gate
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return res.status(401).json({ error: 'sign_in_required' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email || session.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Pull the recent feed
  let ids = [];
  try {
    const r = await fetch(`${KV_URL}/lrange/dreams:recent/0/199`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (r.ok) {
      const { result } = await r.json();
      if (Array.isArray(result)) ids = result;
    }
  } catch (_) {}

  // Filter for kind:'bred' — fetch each in parallel
  const records = await Promise.all(ids.map(async (id) => {
    const d = await kvGet(`dream:${id}`);
    if (!d || d.kind !== 'bred') return null;
    return {
      id: d.id,
      title: d.title || null,
      owner_email: d.owner_email || null,
      created_at: d.created_at || null,
      parent_ids: Array.isArray(d.parent_ids) ? d.parent_ids : null,
      lineage_depth: d.lineage_depth || 1,
    };
  }));

  const bred = records.filter(Boolean);
  return res.status(200).json({
    bred,
    count: bred.length,
    scanned: ids.length,
    note: 'Only the most recent 200 dreams were scanned.',
  });
}
