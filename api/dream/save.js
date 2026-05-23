// POST /api/dream/save
// Body: { text, analysis, device_id }
// Saves a dream record to Upstash Redis (Vercel KV) and returns { id, permalink }.
//
// Schema:
//   dream:{id}           → JSON of the full record
//   dreams:recent        → Redis LIST of recent IDs (newest first, capped at 200)
//   device:{deviceId}    → Redis LIST of that device's dream IDs (no cap)

import crypto from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kv(path, body) {
  const opts = {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${KV_URL}/${path}`, opts);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`KV ${path} → ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

async function getSignedInEmail(req) {
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return null;
  try {
    const r = await fetch(`${KV_URL}/get/session:${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const { result } = await r.json();
    if (!result) return null;
    const session = typeof result === 'string' ? JSON.parse(result) : result;
    return session.email || null;
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({
      error: 'storage_not_configured',
      message: 'Connect a Redis store on Vercel and redeploy.',
    });
  }

  const { text, analysis, device_id, dreamer, audio_url } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    return res.status(400).json({ error: 'dream_too_short' });
  }
  if (text.length > 8000) {
    return res.status(413).json({ error: 'dream_too_long' });
  }

  // Generate URL-safe 11-char ID (~2^48 entropy)
  const id = crypto.randomBytes(8).toString('base64url');

  // Sanitize dreamer profile
  let dreamerClean = null;
  if (dreamer && typeof dreamer === 'object') {
    const validGenders = ['man', 'woman', 'nonbinary', 'other'];
    const validHair = ['black', 'dark brown', 'brown', 'auburn', 'red', 'blonde', 'strawberry blonde', 'grey', 'silver', 'white', 'bald', 'shaved'];
    const validGlasses = ['none', 'black rectangular', 'tortoiseshell', 'round wire', 'aviator', 'rimless', 'other'];
    const g = typeof dreamer.gender === 'string' && validGenders.includes(dreamer.gender) ? dreamer.gender : null;
    const a = Number.isFinite(dreamer.age) && dreamer.age > 0 && dreamer.age < 130 ? dreamer.age : null;
    const h = typeof dreamer.hair === 'string' && validHair.includes(dreamer.hair) ? dreamer.hair : null;
    const gl = typeof dreamer.glasses === 'string' && validGlasses.includes(dreamer.glasses) ? dreamer.glasses : null;
    if (g || a || h || gl) {
      dreamerClean = {
        ...(g && { gender: g }),
        ...(a && { age: a }),
        ...(h && { hair: h }),
        ...(gl && { glasses: gl }),
      };
    }
  }

  // Validate audio_url — must be a Vercel Blob URL (defensive: don't accept
  // arbitrary user-supplied URLs that could be used for XSS or referer leaks).
  let audioUrlClean = null;
  if (typeof audio_url === 'string' &&
      /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/audio\//i.test(audio_url) &&
      audio_url.length < 500) {
    audioUrlClean = audio_url;
  }

  // If the user is signed in, capture ownership + their handle for cheap rendering.
  const ownerEmail = await getSignedInEmail(req);
  let ownerHandle = null;
  let ownerDisplayName = null;
  if (ownerEmail) {
    try {
      const ur = await fetch(`${KV_URL}/get/user:${encodeURIComponent(ownerEmail)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (ur.ok) {
        const { result } = await ur.json();
        const user = result && (typeof result === 'string' ? JSON.parse(result) : result);
        ownerHandle = user?.handle || null;
        ownerDisplayName = user?.display_name || null;
      }
    } catch (_) {}
  }

  const record = {
    id,
    text: text.trim(),
    title: (analysis && typeof analysis.title === 'string' && analysis.title.trim()) || null,
    analysis: analysis || null,
    dreamer: dreamerClean,
    audio_url: audioUrlClean,
    owner_email: ownerEmail,
    owner_handle: ownerHandle,
    owner_display_name: ownerDisplayName,
    visibility: 'public', // default per product choice; user can flip to private later
    device_id: typeof device_id === 'string' ? device_id.slice(0, 64) : null,
    created_at: new Date().toISOString(),
    word_count: text.trim().split(/\s+/).length,
  };

  try {
    // Set the dream record (Upstash REST: send value as JSON string in body)
    await kv(`set/dream:${id}`, JSON.stringify(record));
    // Add to global recent list (newest first, cap at 200)
    await kv(`lpush/dreams:recent/${id}`);
    await kv(`ltrim/dreams:recent/0/199`);
    // Add to per-device list (no cap)
    if (record.device_id) {
      await kv(`lpush/device:${record.device_id}/${id}`);
    }
    // If signed in, add to the user's personal library. We push to BOTH the
    // literal-@ and the percent-encoded key variants so the reader (which
    // also tries both) is guaranteed to find the dream regardless of how
    // Upstash normalizes URL path encoding.
    if (ownerEmail) {
      await kv(`lpush/user_dreams:${ownerEmail}/${id}`);
      await kv(`lpush/user_dreams:${encodeURIComponent(ownerEmail)}/${id}`);
    }
    return res.status(200).json({
      id,
      permalink: `/d/${id}`,
      created_at: record.created_at,
      owner_email: ownerEmail,
    });
  } catch (err) {
    console.error('save failed:', err);
    return res.status(500).json({ error: 'save_failed', message: err.message });
  }
}
