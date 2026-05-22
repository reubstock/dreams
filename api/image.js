// POST /api/image  { id, force? }
// 1. Loads the dream record from Redis
// 2. GPT-4o-mini turns the dream + morphs into a tight image prompt
// 3. gpt-image-1 (medium quality, 1024x1024, ~$0.042/image) generates a
//    surrealist painting of the dream
// 4. Uploads the PNG to Vercel Blob
// 5. Patches the dream record with image_url + image_prompt
// Idempotent: returns the existing image_url if one already exists, unless force=true.

import { put } from '@vercel/blob';

export const config = { api: { bodyParser: true }, maxDuration: 60 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

const STYLE_DIRECTION = `Style: surrealist oil painting, dreamlike multi-figure composition, painterly visible brushwork, dark earthy palette warmed by candlelight or lamp light. Composition reminiscent of Salvador Dalí, René Magritte, Symbolist painters, Remedios Varo. Coherent narrative scene that integrates multiple specific dream elements into one image. NOT photographic. NOT generic AI art. NOT digital illustration. NOT anime. NOT cartoon.`;

async function kvGet(id) {
  const r = await fetch(`${KV_URL}/get/dream:${id}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  if (!result) return null;
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function kvSet(id, value) {
  const r = await fetch(`${KV_URL}/set/dream:${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function craftPrompt(text, analysis, dreamer) {
  const motifs = analysis?.morphs?.slice(0, 6).map((m) => `${m.before} → ${m.after}`).join('; ') || '';

  // Build the dreamer instruction — this is the key fix for "renders me as a woman".
  // If we know gender/age, the prompt-crafter MUST describe the dreamer consistently.
  let dreamerLine = '';
  if (dreamer && (dreamer.gender || dreamer.age)) {
    const ageDesc = dreamer.age ? `${dreamer.age}-year-old ` : '';
    const genderDesc = dreamer.gender || 'person';
    dreamerLine = `\n\nDREAMER IDENTITY (CRITICAL): The person whose dream this is, is a ${ageDesc}${genderDesc}. Whenever the dreamer appears in the image, describe them as a ${ageDesc}${genderDesc}. Do NOT default to any other gender or age. If the dream text says "I" or "my", that refers to this ${genderDesc}.`;
  }

  const userPrompt = `Compress this dream into a single tight image prompt for a surrealist painting. Include 4–6 VERY SPECIFIC visual elements directly from the dream — specific people, objects, settings, transformations. Be concrete: not "a figure" but "a 35-year-old man in a white nightgown"; not "a body of water" but "a clawfoot bathtub overflowing onto the floor". One paragraph, ~80 words. Do NOT add style direction (that's appended automatically). Output only the prompt text — no preamble, no commentary, no quotes.${dreamerLine}

Dream:
"${text}"

${motifs ? `Key transformations: ${motifs}` : ''}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You write tight, vivid prompts for surrealist painting generation. Specific. Visual. Narrative. Multi-element.' },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.6,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`prompt model failed ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || text.slice(0, 400);
}

async function generateImage(promptText, attempt = 0) {
  const fullPrompt = `${promptText}\n\n${STYLE_DIRECTION}`;
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: fullPrompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1,
    }),
  });

  if (res.ok) {
    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('image model returned no b64_json');
    return b64;
  }

  // Error path: parse the OpenAI response so the message is human-readable
  const raw = await res.text();
  let humanMessage = raw;
  try { humanMessage = JSON.parse(raw).error?.message || raw; } catch (_) {}

  // 429 rate limit — auto-retry once if the suggested wait is short enough
  if (res.status === 429 && attempt < 1) {
    const m = humanMessage.match(/try again in (\d+(?:\.\d+)?)\s*s/i);
    const waitSec = Math.min(m ? Math.ceil(parseFloat(m[1])) + 1 : 15, 30);
    console.log(`gpt-image-1 rate limited; waiting ${waitSec}s before retry`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    return generateImage(promptText, attempt + 1);
  }

  if (res.status === 429) {
    throw new Error(`Rate limited — gpt-image-1 caps at 5 images/min per org. Wait a minute and tap Re-roll.`);
  }
  throw new Error(`Image API ${res.status}: ${humanMessage.slice(0, 240)}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!OPENAI_KEY) return res.status(503).json({ error: 'openai_not_configured' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'kv_not_configured' });
  if (!BLOB_TOKEN) return res.status(503).json({
    error: 'blob_not_configured',
    message: 'Enable Vercel Blob storage in the dashboard (Storage → Blob → Create) and connect it to the dreams project. The next deploy picks up BLOB_READ_WRITE_TOKEN automatically.',
  });

  const { id, force, dreamer: requestDreamer } = req.body || {};
  if (!id || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) {
    return res.status(400).json({ error: 'bad_id' });
  }

  const dream = await kvGet(id);
  if (!dream) return res.status(404).json({ error: 'dream_not_found' });

  if (dream.image_url && !force) {
    return res.status(200).json({ image_url: dream.image_url, prompt: dream.image_prompt, cached: true });
  }

  // Prefer the dreamer profile from the current request (so re-rolls reflect
  // updated settings); fall back to whatever's saved on the dream record.
  const effectiveDreamer = (requestDreamer && (requestDreamer.gender || requestDreamer.age))
    ? requestDreamer
    : dream.dreamer || null;

  try {
    const prompt = await craftPrompt(dream.text, dream.analysis, effectiveDreamer);
    const b64 = await generateImage(prompt);
    const buffer = Buffer.from(b64, 'base64');

    const filename = `dreams/${id}-${Date.now()}.png`;
    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: 'image/png',
      token: BLOB_TOKEN,
    });

    dream.image_url = blob.url;
    dream.image_prompt = prompt;
    dream.image_generated_at = new Date().toISOString();
    // Persist the dreamer profile that was actually used, so future re-rolls
    // (or other clients viewing this dream) know how it was rendered.
    if (effectiveDreamer) dream.dreamer = effectiveDreamer;
    await kvSet(id, dream);

    return res.status(200).json({ image_url: blob.url, prompt, cached: false });
  } catch (err) {
    console.error('image generation failed:', err);
    return res.status(500).json({ error: 'image_failed', message: err.message });
  }
}
