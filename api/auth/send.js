// POST /api/auth/send  { email }
// Generates a magic-link token, stores it in Redis (30 min TTL),
// and emails the user a sign-in link via Resend.

import { randomBytes } from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_ORIGIN = 'https://dreams-livid.vercel.app';
// Verified domain on Resend (reubstock.com). Switching away from
// onboarding@resend.dev unlocks sending to any recipient — the resend.dev
// sandbox only allows sending to the account holder's verified address.
const FROM_EMAIL = 'Dreams <noreply@reubstock.com>';

function isValidEmail(s) {
  return typeof s === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) &&
    s.length < 200;
}

async function kvSetEx(key, value, ttl) {
  const r = await fetch(`${KV_URL}/setex/${encodeURIComponent(key)}/${ttl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!RESEND_API_KEY) {
    return res.status(503).json({
      error: 'auth_not_configured',
      message: 'RESEND_API_KEY not set. Sign up at resend.com (free), then `vercel env add RESEND_API_KEY production` and redeploy.',
    });
  }
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'kv_not_configured' });
  }

  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'Provide a valid email address.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const token = randomBytes(24).toString('base64url');

  // Generate a 6-digit code for cross-device sign-in (read the code off
  // your phone, type it into the browser you're trying to sign in on).
  // Padded so leading zeros aren't dropped.
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

  // Store both in Redis with 30-minute TTL.
  const ttl = 30 * 60;
  const tokenSaved = await kvSetEx(`auth_token:${token}`, JSON.stringify({
    email: normalizedEmail,
    created_at: new Date().toISOString(),
  }), ttl);
  // Per-email keyed code (so a user can request a code, type it in their
  // own browser without us guessing the right one). Overwrites any prior
  // code for the same email — most recent request wins.
  const codeSaved = await kvSetEx(`auth_code:${normalizedEmail}`, JSON.stringify({
    code,
    attempts: 0,
    created_at: new Date().toISOString(),
  }), ttl);
  if (!tokenSaved || !codeSaved) return res.status(500).json({ error: 'kv_write_failed' });

  const verifyUrl = `${SITE_ORIGIN}/api/auth/verify?token=${token}`;
  // Email leads with the 6-digit code (the most reliable cross-device path)
  // and keeps the magic-link button as a same-device shortcut.
  const codeBoxed = code.split('').join(' ');
  const html = `<!doctype html>
<html><body style="font-family: Georgia, 'Iowan Old Style', serif; max-width: 540px; margin: 40px auto; padding: 24px; color: #15110a; background: #f1ead7;">
  <div style="font-family: Didot, 'Bodoni 72', serif; font-style: italic; font-size: 32px; line-height: 1; margin-bottom: 24px;">
    Dreams<span style="color: #b8421a;">.</span>
  </div>
  <p style="font-size: 16px; line-height: 1.55; margin: 0 0 18px;">Your sign-in code:</p>
  <div style="font-family: ui-monospace, Menlo, monospace; font-size: 38px; letter-spacing: 0.32em; color: #15110a; padding: 18px 22px; background: rgba(184, 66, 26, 0.08); border: 1px solid rgba(184, 66, 26, 0.32); display: inline-block; margin-bottom: 8px;">${codeBoxed}</div>
  <p style="font-size: 13px; color: #7a6e4f; line-height: 1.5; margin-top: 14px;">Type this code into the Dreams sign-in screen where you started. It expires in 30 minutes.</p>
  <p style="font-size: 13px; color: #7a6e4f; line-height: 1.5; margin-top: 26px;">If you started sign-in on this same device, you can also just click here:</p>
  <p style="margin: 12px 0 24px;">
    <a href="${verifyUrl}" style="background: #b8421a; color: #f1ead7; text-decoration: none; padding: 12px 18px; font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.18em; text-transform: uppercase; font-size: 11px; display: inline-block;">Sign in on this device</a>
  </p>
  <p style="font-size: 11px; color: #aaa; margin-top: 32px;">If you didn't request this email, ignore it.</p>
</body></html>`;

  const text = `Sign in to Dreams\n\nYour code: ${code}\n\nType it into the Dreams sign-in screen where you started.\n(Code expires in 30 min.)\n\nOr — if you're on the same device you started on — open this link:\n${verifyUrl}`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: normalizedEmail,
      subject: `Sign in to Dreams — code ${code}`,
      html,
      text,
    }),
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    console.error('Resend error', resendRes.status, errText);
    return res.status(502).json({
      error: 'email_send_failed',
      message: errText.slice(0, 300),
    });
  }

  return res.status(200).json({ sent: true, email: normalizedEmail });
}
