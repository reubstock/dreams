// Server-side renderer for /u/:handle — injects OG tags so profile shares preview
// with the dreamer's display name + most recent dream image. The client-side JS
// in index.html sees the body class "profile-page" via the URL and renders the
// profile UI by calling /api/user/profile?handle=...

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const config = { api: { bodyParser: false }, maxDuration: 8 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SITE_ORIGIN = 'https://dreams-livid.vercel.app';
const HANDLE_RX = /^[a-z0-9][a-z0-9_-]{2,23}$/;

let cachedHtml = null;
function getHtml() {
  if (!cachedHtml) {
    try { cachedHtml = readFileSync(join(process.cwd(), 'index.html'), 'utf8'); }
    catch (e) { cachedHtml = '<html><body>Server error</body></html>'; }
  }
  return cachedHtml;
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
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
  const handle = (req.query.handle || '').toString().trim().toLowerCase();
  const html = getHtml();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!HANDLE_RX.test(handle)) return res.status(200).send(html);

  const email = await kvGet(`handle:${handle}`);
  if (!email) return res.status(200).send(html);
  const user = await kvGet(`user:${email}`);
  if (!user) return res.status(200).send(html);

  const displayName = user.display_name || user.email?.split('@')[0] || handle;
  const title = `${displayName}'s dreams · Dreams`;
  const description = user.bio || `Dreams by @${handle} — recorded, transcribed, and read by Dreams.`;
  const image = user.selfie_url || `${SITE_ORIGIN}/images/morpho.png`;
  const url = `${SITE_ORIGIN}/u/${handle}`;

  const ogTags = `
    <meta property="og:title" content="${escapeHTML(title)}">
    <meta property="og:description" content="${escapeHTML(description)}">
    <meta property="og:image" content="${escapeHTML(image)}">
    <meta property="og:url" content="${escapeHTML(url)}">
    <meta property="og:type" content="profile">
    <meta property="og:site_name" content="Dreams">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHTML(title)}">
    <meta name="twitter:description" content="${escapeHTML(description)}">
    <meta name="twitter:image" content="${escapeHTML(image)}">
    <link rel="canonical" href="${escapeHTML(url)}">
  `;
  const out = html.replace('</head>', ogTags + '\n</head>');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).send(out);
}
