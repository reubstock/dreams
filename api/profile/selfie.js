// POST   /api/profile/selfie  { selfie_b64, content_type } → uploads selfie to Blob, stores URL on user record
// DELETE /api/profile/selfie                              → clears selfie URL
// Requires sign-in (dreams_session cookie).
//
// Selfie is used by /api/image.js to maintain visual likeness of the
// dreamer across generated dream images, via /v1/images/edits with the
// selfie as the reference image.

import { put, del } from '@vercel/blob';

export const config = { api: { bodyParser: { sizeLimit: '12mb' } }, maxDuration: 15 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

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

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

async function getSignedInEmail(req) {
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return null;
  const session = await kvGet(`session:${token}`);
  return session?.email || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = await getSignedInEmail(req);
  if (!email) return res.status(401).json({ error: 'not_signed_in' });

  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'kv_not_configured' });

  if (req.method === 'POST') {
    if (!BLOB_TOKEN) return res.status(503).json({ error: 'blob_not_configured' });

    const { selfie_b64, content_type } = req.body || {};
    if (!selfie_b64 || typeof selfie_b64 !== 'string') {
      return res.status(400).json({ error: 'missing_image' });
    }

    const b64 = selfie_b64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');

    if (buffer.length === 0) return res.status(400).json({ error: 'empty_image' });
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'image_too_large', message: 'Max 10 MB. Try a smaller photo.' });
    }

    const ct = (typeof content_type === 'string' && /^image\/(jpe?g|png|webp)$/i.test(content_type))
      ? content_type
      : 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const hash = Buffer.from(email).toString('base64url').slice(0, 12);
    const rnd = Math.random().toString(36).slice(2, 8);
    const filename = `profile/${hash}-${rnd}.${ext}`;

    const user = (await kvGet(`user:${email}`)) || { email };
    const oldUrl = user.selfie_url;

    let blob;
    try {
      blob = await put(filename, buffer, {
        access: 'public',
        contentType: ct,
        token: BLOB_TOKEN,
      });
    } catch (err) {
      console.error('Blob upload failed:', err);
      return res.status(500).json({ error: 'upload_failed', message: err.message });
    }

    user.selfie_url = blob.url;
    user.selfie_updated_at = new Date().toISOString();
    await kvSet(`user:${email}`, JSON.stringify(user));

    // Best-effort cleanup of old selfie
    if (oldUrl && oldUrl !== blob.url) {
      try { await del(oldUrl, { token: BLOB_TOKEN }); } catch (_) {}
    }

    return res.status(200).json({ selfie_url: blob.url });
  }

  if (req.method === 'DELETE') {
    const user = (await kvGet(`user:${email}`)) || { email };
    const oldUrl = user.selfie_url;
    user.selfie_url = null;
    user.selfie_updated_at = new Date().toISOString();
    await kvSet(`user:${email}`, JSON.stringify(user));
    if (oldUrl && BLOB_TOKEN) {
      try { await del(oldUrl, { token: BLOB_TOKEN }); } catch (_) {}
    }
    return res.status(200).json({ selfie_url: null });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
