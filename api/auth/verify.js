// GET /api/auth/verify?token=...
// Validates the magic-link token, creates a session in Redis, sets an
// HttpOnly session cookie, and redirects to the homepage.

import { randomBytes } from 'node:crypto';

export const config = { api: { bodyParser: false }, maxDuration: 8 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

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

async function kvSetEx(key, value, ttl) {
  const r = await fetch(`${KV_URL}/setex/${encodeURIComponent(key)}/${ttl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

async function kvDel(key) {
  const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) return res.status(503).send('Storage not configured');
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const { token } = req.query;
  if (!token || typeof token !== 'string' || token.length > 200) {
    return res.redirect(302, '/?auth=invalid');
  }

  const stored = await kvGet(`auth_token:${token}`);
  if (!stored || !stored.email) {
    return res.redirect(302, '/?auth=expired');
  }

  // Single-use: delete the magic-link token now
  await kvDel(`auth_token:${token}`);

  // Create a session token (30-day TTL)
  const sessionToken = randomBytes(32).toString('base64url');
  const ttl = 30 * 24 * 60 * 60;
  await kvSetEx(`session:${sessionToken}`, JSON.stringify({
    email: stored.email,
    created_at: new Date().toISOString(),
  }), ttl);

  // Ensure user record exists
  const existing = await kvGet(`user:${stored.email}`);
  if (!existing) {
    await kvSet(`user:${stored.email}`, JSON.stringify({
      email: stored.email,
      created_at: new Date().toISOString(),
    }));
  }

  // Set the session cookie
  res.setHeader('Set-Cookie',
    `dreams_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}`
  );
  return res.redirect(302, '/?auth=ok');
}
