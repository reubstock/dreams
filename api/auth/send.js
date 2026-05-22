// POST /api/auth/send  { email }
// Generates a magic-link token, stores it in Redis (30 min TTL),
// and emails the user a sign-in link via Resend.

import { randomBytes } from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_ORIGIN = 'https://dreams-livid.vercel.app';
const FROM_EMAIL = 'Dreams <onboarding@resend.dev>';

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

  // Store token in Redis with 30-minute TTL
  const saved = await kvSetEx(`auth_token:${token}`, JSON.stringify({
    email: normalizedEmail,
    created_at: new Date().toISOString(),
  }), 30 * 60);
  if (!saved) return res.status(500).json({ error: 'kv_write_failed' });

  const verifyUrl = `${SITE_ORIGIN}/api/auth/verify?token=${token}`;
  const html = `<!doctype html>
<html><body style="font-family: Georgia, 'Iowan Old Style', serif; max-width: 540px; margin: 40px auto; padding: 24px; color: #15110a; background: #f1ead7;">
  <div style="font-family: Didot, 'Bodoni 72', serif; font-style: italic; font-size: 32px; line-height: 1; margin-bottom: 24px;">
    Dreams<span style="color: #b8421a;">.</span>
  </div>
  <p style="font-size: 16px; line-height: 1.55;">Click below to sign in. This link expires in 30 minutes and can only be used once.</p>
  <p style="margin: 28px 0;">
    <a href="${verifyUrl}" style="background: #b8421a; color: #f1ead7; text-decoration: none; padding: 14px 22px; font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.18em; text-transform: uppercase; font-size: 11px; display: inline-block;">Sign in to Dreams</a>
  </p>
  <p style="font-size: 13px; color: #7a6e4f; line-height: 1.5;">If the button doesn't work, paste this URL into your browser:<br>
    <code style="word-break: break-all; font-size: 11px;">${verifyUrl}</code>
  </p>
  <p style="font-size: 11px; color: #aaa; margin-top: 32px;">If you didn't request this email, ignore it.</p>
</body></html>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: normalizedEmail,
      subject: 'Sign in to Dreams',
      html,
      text: `Sign in to Dreams\n\nClick here (expires in 30 min):\n${verifyUrl}`,
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
