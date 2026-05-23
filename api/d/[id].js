// Server-side renderer for /d/:id — injects OpenGraph + Twitter Card meta
// tags so when a dream link is shared, the preview shows the dream's title,
// excerpt, and hero image (not the page's default fallback).
//
// vercel.json rewrites /d/:id → /api/d/:id so this runs for every dream page.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const config = { api: { bodyParser: false }, maxDuration: 8 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SITE_ORIGIN = 'https://dreams-livid.vercel.app';

// Read index.html once on cold start
let cachedHtml = null;
function getHtml() {
  if (!cachedHtml) {
    try {
      cachedHtml = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    } catch (err) {
      console.error('Could not read index.html', err);
      cachedHtml = '<html><body>Server error</body></html>';
    }
  }
  return cachedHtml;
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function fetchDream(id) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/dream:${id}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const { result } = await r.json();
    if (!result) return null;
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch (err) {
    console.error('fetchDream', err);
    return null;
  }
}

export default async function handler(req, res) {
  const { id } = req.query;
  const html = getHtml();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!id || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) {
    return res.status(200).send(html);
  }

  const dream = await fetchDream(id);
  if (!dream) {
    return res.status(200).send(html);
  }

  const title = dream.title || dream.analysis?.title || 'A dream';
  const description = ((dream.text || '').slice(0, 240).replace(/\s+/g, ' ').trim()) +
    ((dream.text || '').length > 240 ? '…' : '');
  const image = dream.image_url || `${SITE_ORIGIN}/images/morpho.png`;
  const url = `${SITE_ORIGIN}/d/${id}`;

  // Strip the hard-coded site-default OG/Twitter tags from index.html so we
  // can replace them with dream-specific ones. Social card crawlers take the
  // FIRST occurrence of each property and ignore later duplicates — appending
  // wasn't enough; iMessage/Mail/Slack kept pulling the default morpho image.
  let out = html
    .replace(/\s*<meta\s+property="og:title"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:description"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:image"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:image:width"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:image:height"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:image:alt"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:url"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:type"[^>]*>/i, '')
    .replace(/\s*<meta\s+name="twitter:title"[^>]*>/i, '')
    .replace(/\s*<meta\s+name="twitter:description"[^>]*>/i, '')
    .replace(/\s*<meta\s+name="twitter:image"[^>]*>/i, '')
    .replace(/\s*<meta\s+name="twitter:card"[^>]*>/i, '')
    .replace(/\s*<link\s+rel="canonical"[^>]*>/i, '');

  const ogTags = `
    <meta property="og:title" content="${escapeHTML(title)}">
    <meta property="og:description" content="${escapeHTML(description)}">
    <meta property="og:image" content="${escapeHTML(image)}">
    <meta property="og:image:alt" content="${escapeHTML(title)} — dream illustration">
    <meta property="og:url" content="${escapeHTML(url)}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Dreams">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHTML(title)}">
    <meta name="twitter:description" content="${escapeHTML(description)}">
    <meta name="twitter:image" content="${escapeHTML(image)}">
    <link rel="canonical" href="${escapeHTML(url)}">
  `;

  out = out.replace('</head>', ogTags + '\n</head>');
  // Cache at edge for 60s so social-card crawlers don't keep regenerating
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  return res.status(200).send(out);
}
