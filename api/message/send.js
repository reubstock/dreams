// POST /api/message/send
// Body: { to_handle, body, dream_id? }
// Pushes a note to the recipient's inbox list and optionally emails them.
// Sender must be signed in. Rate-limited per sender.

import crypto from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_ORIGIN = 'https://dreams-livid.vercel.app';
const HANDLE_RX = /^[a-z0-9][a-z0-9_-]{2,23}$/;

const RATE_LIMIT_PER_HOUR = 30;

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  if (!result) return null;
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function kvIncrEx(key, ttl) {
  // Upstash REST supports INCR; we set TTL separately the first time.
  const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return 0;
  const { result } = await r.json();
  // Set TTL only when counter starts at 1
  if (result === 1 && ttl) {
    await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${ttl}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
  }
  return result;
}

async function kvLPush(key, value) {
  const r = await fetch(`${KV_URL}/lpush/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

async function kvLTrim(key, start, stop) {
  await fetch(`${KV_URL}/ltrim/${encodeURIComponent(key)}/${start}/${stop}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

async function sendNotificationEmail({ toEmail, fromDisplayName, fromHandle, body, dreamId }) {
  if (!RESEND_API_KEY) return false;
  try {
    const inboxUrl = `${SITE_ORIGIN}/inbox`;
    const profileUrl = `${SITE_ORIGIN}/u/${encodeURIComponent(fromHandle)}`;
    const dreamLine = dreamId ? `\n\nAbout your dream: ${SITE_ORIGIN}/d/${dreamId}` : '';
    const text = `${fromDisplayName} (@${fromHandle}) sent you a note on Dreams:\n\n"${body}"${dreamLine}\n\nRead in your inbox: ${inboxUrl}\nTheir profile: ${profileUrl}`;
    const html = `
      <div style="font-family: Georgia, serif; max-width: 520px; line-height: 1.55;">
        <p style="font-family: ui-monospace, Menlo, monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #999;">A note from Dreams</p>
        <h2 style="margin: 6px 0 4px;"><a href="${profileUrl}" style="color:#d87a3e; text-decoration: none;">${escapeHTML(fromDisplayName)}</a> sent you a note.</h2>
        <blockquote style="border-left: 3px solid #d87a3e; padding: 4px 0 4px 14px; margin: 14px 0; color: #444;">${escapeHTML(body)}</blockquote>
        ${dreamId ? `<p style="font-size: 13px;">About your dream: <a href="${SITE_ORIGIN}/d/${dreamId}">${SITE_ORIGIN}/d/${dreamId}</a></p>` : ''}
        <p style="font-size: 13px;"><a href="${inboxUrl}" style="background:#d87a3e; color:white; padding:8px 14px; text-decoration:none;">Read in your inbox →</a></p>
      </div>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Dreams <onboarding@resend.dev>',
        to: toEmail,
        subject: `${fromDisplayName} sent you a note on Dreams`,
        text,
        html,
      }),
    });
    return r.ok;
  } catch (_) { return false; }
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });
  const senderEmail = session.email;
  const sender = await kvGet(`user:${senderEmail}`);
  if (!sender) return res.status(401).json({ error: 'no_user_record' });

  const { to_handle, body, dream_id } = req.body || {};
  const toHandle = (to_handle || '').toString().trim().toLowerCase();
  if (!HANDLE_RX.test(toHandle)) return res.status(400).json({ error: 'bad_handle' });
  if (!body || typeof body !== 'string') return res.status(400).json({ error: 'no_body' });
  const cleanBody = body.trim().slice(0, 1500);
  if (cleanBody.length < 1) return res.status(400).json({ error: 'empty_body' });
  if (dream_id && !/^[A-Za-z0-9_-]{8,20}$/.test(dream_id)) return res.status(400).json({ error: 'bad_dream_id' });

  // Resolve recipient
  const recipientEmail = await kvGet(`handle:${toHandle}`);
  if (!recipientEmail) return res.status(404).json({ error: 'recipient_not_found' });
  if (recipientEmail === senderEmail) return res.status(400).json({ error: 'cannot_message_self' });
  const recipient = await kvGet(`user:${recipientEmail}`);
  if (!recipient) return res.status(404).json({ error: 'recipient_not_found' });

  // Rate limit
  const count = await kvIncrEx(`msg_rate:${senderEmail}`, 3600);
  if (count > RATE_LIMIT_PER_HOUR) {
    return res.status(429).json({ error: 'rate_limited', message: `Limit ${RATE_LIMIT_PER_HOUR} notes per hour.` });
  }

  const message = {
    id: crypto.randomBytes(6).toString('base64url'),
    from_handle: sender.handle || null,
    from_display_name: sender.display_name || senderEmail.split('@')[0],
    from_email: senderEmail, // private, server-side only — we strip on inbox read for the recipient view
    to_handle: toHandle,
    body: cleanBody,
    dream_id: dream_id || null,
    created_at: new Date().toISOString(),
    read: false,
  };

  // Store under recipient's inbox + sender's sentbox
  await kvLPush(`inbox:${recipientEmail}`, JSON.stringify(message));
  await kvLTrim(`inbox:${recipientEmail}`, 0, 199);
  await kvLPush(`sentbox:${senderEmail}`, JSON.stringify(message));
  await kvLTrim(`sentbox:${senderEmail}`, 0, 99);

  // Notify by email (best-effort, non-blocking on failure)
  const emailed = await sendNotificationEmail({
    toEmail: recipientEmail,
    fromDisplayName: message.from_display_name,
    fromHandle: message.from_handle || 'a dreamer',
    body: cleanBody,
    dreamId: dream_id,
  });

  return res.status(200).json({ ok: true, id: message.id, email_sent: emailed });
}
