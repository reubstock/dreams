// POST /api/image  { id, force? }
// 1. Loads the dream record from Redis
// 2. GPT-4o-mini turns the dream + morphs into a tight image prompt
// 3. gpt-image-1 (medium quality, 1024x1024, ~$0.042/image) generates a
//    surrealist painting of the dream
// 4. If the owner has a selfie, Replicate's cdingram/face-swap (~$0.002)
//    swaps their actual face onto the figure
// 5. Uploads the final PNG to Vercel Blob
// 6. Patches the dream record with image_url + image_prompt
// Idempotent: returns the existing image_url if one already exists, unless force=true.

import { put } from '@vercel/blob';

export const config = { api: { bodyParser: true }, maxDuration: 90 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;

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

async function kvGetRaw(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  if (!result) return null;
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

async function getRequesterEmail(req) {
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return null;
  const session = await kvGetRaw(`session:${token}`);
  return session?.email || null;
}

async function kvSet(id, value) {
  const r = await fetch(`${KV_URL}/set/dream:${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function craftPrompt(text, analysis, dreamer, willFaceSwap) {
  const motifs = analysis?.morphs?.slice(0, 6).map((m) => `${m.before} → ${m.after}`).join('; ') || '';

  // Build the dreamer instruction — this is the key fix for "renders me as a woman".
  // If we know gender/age/hair/glasses, the prompt-crafter MUST describe the
  // dreamer consistently. Hair + glasses matter because face-swap (Replicate)
  // transfers facial features only and inherits hair/accessories from the
  // gpt-image-1 painting; so the painting needs to start with the right hair
  // and glasses or face-swap can't recover them.
  let dreamerLine = '';
  if (dreamer && (dreamer.gender || dreamer.age || dreamer.hair || dreamer.glasses)) {
    const ageDesc = dreamer.age ? `${dreamer.age}-year-old ` : '';
    const genderDesc = dreamer.gender || 'person';
    const parts = [`a ${ageDesc}${genderDesc}`];
    if (dreamer.hair) {
      if (dreamer.hair === 'bald') parts.push('completely bald');
      else if (dreamer.hair === 'shaved') parts.push('with a shaved head');
      else parts.push(`with ${dreamer.hair} hair`);
    }
    if (dreamer.glasses && dreamer.glasses !== 'none') {
      parts.push(`wearing ${dreamer.glasses} glasses`);
    } else if (dreamer.glasses === 'none') {
      parts.push('not wearing glasses');
    }
    const description = parts.join(', ');
    dreamerLine = `\n\nDREAMER IDENTITY (CRITICAL — render exactly as described, do not invent different features): The person whose dream this is, is ${description}. Whenever the dreamer appears in the image, render them as ${description}. Do NOT default to any other appearance. If the dream text says "I" or "my", that refers to this person.`;
  }

  // When face-swap will run after generation, hint the prompt-crafter to make
  // the dreamer's face clearly visible and frontal so the face-swap model has
  // a good target. We no longer attach the selfie to gpt-image-1 itself (which
  // triggered safety filters on anything remotely intimate) — Replicate handles
  // the likeness step post-generation.
  const faceSwapLine = willFaceSwap
    ? `\n\nFACE TARGET: The dreamer's face will be replaced post-generation with the user's actual photo. Compose the scene so the dreamer is shown with their face clearly visible — frontal or three-quarter view, well-lit, not turned away or obscured. This gives the face-swap step a clean target.`
    : '';

  const userPrompt = `Compress this dream into a single tight image prompt for a surrealist painting. Include 4–6 VERY SPECIFIC visual elements directly from the dream — specific people, objects, settings, transformations. Be concrete: not "a figure" but "a 35-year-old man in a white nightgown"; not "a body of water" but "a clawfoot bathtub overflowing onto the floor". One paragraph, ~80 words. Do NOT add style direction (that's appended automatically). Output only the prompt text — no preamble, no commentary, no quotes.${dreamerLine}${faceSwapLine}

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

  const isSafetyHit = /safety|moderation/i.test(humanMessage) ||
                      /SAFETY_VIOLATIONS/.test(humanMessage);
  if (isSafetyHit) {
    throw new Error(`Safety filter — gpt-image-1 rejected the scene. Try editing the dream text to make the scene unambiguously non-intimate, then tap Re-roll.`);
  }

  throw new Error(`Image API ${res.status}: ${humanMessage.slice(0, 240)}`);
}

// ============ Replicate face-swap ============
// Pinned version hash of cdingram/face-swap. Update with:
//   curl -s https://api.replicate.com/v1/models/cdingram/face-swap \
//        -H "Authorization: Bearer $TOKEN" | jq -r .latest_version.id
const FACE_SWAP_VERSION = 'd1d6ea8c8be89d664a07a457526f7128109dee7030fdac424788d762c71ed111';

// Takes the generated dream image (as Buffer) and the user's selfie URL,
// returns a Buffer of the swapped result. Falls back to the original
// generated image (returns null) if anything goes wrong — face-swap is a
// best-effort enhancement, never a blocker.
async function faceSwap(generatedBuffer, selfieUrl) {
  if (!REPLICATE_TOKEN || !selfieUrl) return null;
  const generatedDataUrl = `data:image/png;base64,${generatedBuffer.toString('base64')}`;

  try {
    // POST /v1/predictions with the model version hash. The
    // /v1/models/owner/name/predictions path 404s for this endpoint.
    // Prefer: wait lets the request block up to ~55s and return the
    // completed prediction synchronously — saves us a polling loop in
    // the common case.
    const createRes = await fetch(
      'https://api.replicate.com/v1/predictions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REPLICATE_TOKEN}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=55',
        },
        body: JSON.stringify({
          version: FACE_SWAP_VERSION,
          input: {
            input_image: generatedDataUrl,   // target with face to be replaced
            swap_image: selfieUrl,           // face source
          },
        }),
      }
    );
    if (!createRes.ok) {
      console.warn('face-swap create failed:', createRes.status, (await createRes.text()).slice(0, 200));
      return null;
    }
    let prediction = await createRes.json();

    // Fallback poll for the rare case Prefer:wait timed out
    let attempts = 0;
    while (prediction.status && prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled' && attempts < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollUrl = prediction.urls?.get;
      if (!pollUrl) break;
      const pollRes = await fetch(pollUrl, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
      if (!pollRes.ok) break;
      prediction = await pollRes.json();
      attempts++;
    }

    if (prediction.status !== 'succeeded') {
      console.warn('face-swap not succeeded:', prediction.status, prediction.error);
      return null;
    }

    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outputUrl || typeof outputUrl !== 'string') return null;

    const imgRes = await fetch(outputUrl);
    if (!imgRes.ok) return null;
    const ab = await imgRes.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    console.warn('face-swap threw:', err.message);
    return null;
  }
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

  // Owner-only gate: only the dreamer can generate or re-roll their image.
  // Costs real money (gpt-image-1 + Replicate) and only the dreamer should
  // have control over how their dream is depicted.
  const requesterEmail = await getRequesterEmail(req);
  if (dream.owner_email) {
    if (!requesterEmail) {
      return res.status(401).json({ error: 'sign_in_required', message: 'Sign in to generate or re-roll this image.' });
    }
    if (requesterEmail.toLowerCase() !== dream.owner_email.toLowerCase()) {
      return res.status(403).json({ error: 'not_owner', message: 'Only the dreamer can re-roll this image.' });
    }
  } else {
    // Orphan dream (no owner stamped). Require sign-in and claim it for the
    // requester so future re-rolls are gated to the same person.
    if (!requesterEmail) {
      return res.status(401).json({ error: 'sign_in_required', message: 'Sign in to generate the image for this dream.' });
    }
    dream.owner_email = requesterEmail;
  }

  // Selfie lookup for face-swap. We already verified ownership above, so
  // we look up the owner's selfie.
  let selfieUrl = null;
  try {
    const user = await kvGetRaw(`user:${dream.owner_email}`);
    if (user?.selfie_url) selfieUrl = user.selfie_url;
  } catch (err) {
    console.warn('Selfie lookup failed:', err.message);
  }
  const willFaceSwap = !!(selfieUrl && REPLICATE_TOKEN);

  try {
    const prompt = await craftPrompt(dream.text, dream.analysis, effectiveDreamer, willFaceSwap);
    const b64 = await generateImage(prompt);
    let buffer = Buffer.from(b64, 'base64');
    let faceSwapped = false;

    // If we have a selfie + Replicate token, swap the face onto the generated scene
    if (willFaceSwap) {
      console.log(`[face-swap] starting for dream ${id} with selfie ${selfieUrl}`);
      const t0 = Date.now();
      const swapped = await faceSwap(buffer, selfieUrl);
      console.log(`[face-swap] dream ${id} completed in ${Date.now() - t0}ms — ${swapped ? 'success' : 'fell back to original'}`);
      if (swapped) {
        buffer = swapped;
        faceSwapped = true;
      }
    } else {
      console.log(`[face-swap] skipped for dream ${id} — selfieUrl=${!!selfieUrl}, REPLICATE_TOKEN=${!!REPLICATE_TOKEN}, requesterEmail=${requesterEmail || 'none'}, dreamOwner=${dream.owner_email || 'none'}`);
    }

    const filename = `dreams/${id}-${Date.now()}.${faceSwapped ? 'jpg' : 'png'}`;
    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: faceSwapped ? 'image/jpeg' : 'image/png',
      token: BLOB_TOKEN,
    });

    dream.image_url = blob.url;
    dream.image_prompt = prompt;
    dream.image_generated_at = new Date().toISOString();
    dream.image_face_swapped = faceSwapped;
    // Persist the dreamer profile that was actually used, so future re-rolls
    // (or other clients viewing this dream) know how it was rendered.
    if (effectiveDreamer) dream.dreamer = effectiveDreamer;
    await kvSet(id, dream);

    return res.status(200).json({
      image_url: blob.url,
      prompt,
      cached: false,
      face_swapped: faceSwapped,
    });
  } catch (err) {
    console.error('image generation failed:', err);
    return res.status(500).json({ error: 'image_failed', message: err.message });
  }
}
