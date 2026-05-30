// POST /api/auth/verify-code  { email, code }
// Cross-device sign-in: the user types the 6-digit code (read off whichever
// device received the email) into the browser they want signed in. We
// create the session against THIS browser and Set-Cookie it back, so the
// device that POSTed is the device that gets signed in. That fixes the
// classic magic-link cross-device trap.
//
// Rate-limited via an `attempts` counter on the code record. After 5 bad
// attempts the code is invalidated.

import { randomBytes } from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 8 };

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
  if (typeof result !== 'string') return result;
  try { return JSON.parse(result); } catch { return result; }
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

async function kvSetEx(key, value, ttl) {
  const r = await fetch(`${KV_URL}/setex/${encodeURIComponent(key)}/${ttl}`, {
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

const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'd', 'dreams', 'inbox', 'library', 'login', 'logout',
  'me', 'new', 'profile', 'settings', 'signin', 'signout', 'signup', 'u', 'user',
  'about', 'help', 'home', 'public', 'static', 'images', 'assets', 'support',
  'mail', 'message', 'messages', 'team', 'root',
]);

async function pickHandle(email) {
  const base = (email.split('@')[0] || 'dreamer')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+/, '')
    .slice(0, 20) || 'dreamer';
  const candidates = [base, ...Array.from({ length: 30 }, (_, i) => `${base}${i + 1}`)];
  for (const cand of candidates) {
    if (cand.length < 3) continue;
    if (RESERVED_HANDLES.has(cand)) continue;
    const taken = await kvGet(`handle:${cand}`);
    if (!taken) return cand;
  }
  const suf = randomBytes(3).toString('hex');
  return `${base}-${suf}`.slice(0, 24);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'kv_not_configured' });

  const { email, code } = req.body || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return res.status(400).json({ error: 'bad_email' });
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'bad_code' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const codeKey = `auth_code:${normalizedEmail}`;
  const record = await kvGet(codeKey);
  if (!record || !record.code) {
    return res.status(400).json({ error: 'code_expired', message: 'This code has expired or no code was sent. Try again.' });
  }

  // Rate-limit
  const attempts = Number(record.attempts || 0) + 1;
  if (attempts > 5) {
    await kvDel(codeKey);
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many wrong codes. Request a new one.' });
  }

  if (record.code !== code) {
    // Bump attempts and keep the record (don't reset TTL)
    await kvSet(codeKey, JSON.stringify({ ...record, attempts }));
    return res.status(400).json({ error: 'bad_code', message: 'That code doesn’t match.', attempts_left: 5 - attempts });
  }

  // Code matches — single-use, delete it
  await kvDel(codeKey);

  // Create a session token for THIS device (the one that POSTed)
  const sessionToken = randomBytes(32).toString('base64url');
  const ttl = 30 * 24 * 60 * 60;
  await kvSetEx(`session:${sessionToken}`, JSON.stringify({
    email: normalizedEmail,
    created_at: new Date().toISOString(),
  }), ttl);

  // Ensure user record + handle (same as verify.js does for magic-link)
  const existing = await kvGet(`user:${normalizedEmail}`);
  if (!existing) {
    const handle = await pickHandle(normalizedEmail);
    await kvSet(`user:${normalizedEmail}`, JSON.stringify({
      email: normalizedEmail,
      handle,
      display_name: normalizedEmail.split('@')[0],
      created_at: new Date().toISOString(),
    }));
    if (handle) await kvSet(`handle:${handle}`, normalizedEmail);
  } else if (!existing.handle) {
    const handle = await pickHandle(normalizedEmail);
    if (handle) {
      existing.handle = handle;
      if (!existing.display_name) existing.display_name = normalizedEmail.split('@')[0];
      await kvSet(`user:${normalizedEmail}`, JSON.stringify(existing));
      await kvSet(`handle:${handle}`, normalizedEmail);
    }
  }

  res.setHeader('Set-Cookie',
    `dreams_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}`
  );
  return res.status(200).json({ signed_in: true, email: normalizedEmail });
}
