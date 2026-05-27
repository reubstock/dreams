// TEMPORARY: POST /api/image/sample  { text, style_anchor, dreamer? }
// Renders one image with the given style anchor; no face-swap, no dream
// record saved. Owner-only (reubstock@gmail.com).
// Used for comparing candidate style anchors side by side. Delete after use.

import { put } from '@vercel/blob';

export const config = { api: { bodyParser: true }, maxDuration: 60 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const ADMIN_EMAIL = 'reubstock@gmail.com';

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
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch (_) { return result; }
  }
  return result;
}

async function craftPrompt(text, dreamer) {
  const ageDesc = dreamer?.age ? `${dreamer.age}-year-old ` : '';
  const genderDesc = dreamer?.gender || 'person';
  const hair = dreamer?.hair ? ` with ${dreamer.hair} hair` : '';
  const glasses = dreamer?.glasses && dreamer.glasses !== 'none' ? `, wearing ${dreamer.glasses} glasses` : '';
  const dreamerLine = dreamer
    ? `The dreamer in the scene is a ${ageDesc}${genderDesc}${hair}${glasses}. When the dreamer appears, render them exactly this way.`
    : '';
  const userPrompt = `Compress this dream into a tight image prompt. Include 4–6 SPECIFIC visual elements from the dream. One paragraph, ~80 words. Do NOT add style direction (that's appended separately). ${dreamerLine}\n\nDream:\n"${text}"`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You write tight, vivid prompts for painting generation. Specific. Visual. Narrative.' },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
    }),
  });
  if (!res.ok) throw new Error(`prompt model: ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content?.trim() || text.slice(0, 400);
}

async function generate(prompt) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1,
    }),
  });
  if (!r.ok) throw new Error(`gpt-image-1: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error('no image bytes');
  return Buffer.from(b64, 'base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!OPENAI_KEY || !BLOB_TOKEN) return res.status(503).json({ error: 'not_configured' });

  // Admin gate
  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (session?.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'admin_only' });

  const { text, style_anchor, dreamer } = req.body || {};
  if (!text || !style_anchor) return res.status(400).json({ error: 'bad_input' });

  try {
    const basePrompt = await craftPrompt(text, dreamer);
    const fullPrompt = `${basePrompt}\n\n${style_anchor}`;
    const buf = await generate(fullPrompt);
    const filename = `samples/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const blob = await put(filename, buf, {
      access: 'public',
      contentType: 'image/png',
      token: BLOB_TOKEN,
    });
    return res.status(200).json({ image_url: blob.url, prompt: fullPrompt });
  } catch (err) {
    console.error('sample failed:', err);
    return res.status(500).json({ error: 'sample_failed', message: err.message });
  }
}
