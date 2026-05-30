// GET /api/device/selfie?device_id=...
// Returns the anonymous device-keyed selfie URL (if any) so the frontend
// can render the thumbnail for first-time, not-signed-in users.

export const config = { api: { bodyParser: false }, maxDuration: 6 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function isValidDeviceId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  if (!result) return null;
  if (typeof result !== 'string') return result;
  try { return JSON.parse(result); } catch { return result; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'kv_not_configured' });

  const deviceId = (req.query?.device_id || '').toString();
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'bad_device_id' });

  const record = await kvGet(`device_selfie:${deviceId}`);
  return res.status(200).json({
    selfie_url: record?.selfie_url || null,
    updated_at: record?.updated_at || null,
  });
}
