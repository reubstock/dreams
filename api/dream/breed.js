// POST /api/dream/breed  { parent_a_id, parent_b_id }
//
// Solo-breeding (Step 1 of the breeding experiment).
// Takes two of the caller's own dreams, asks GPT-4o-mini to fuse them into
// a single hybrid dream text, runs analyze on the result, and saves a new
// dream record with parents/lineage_depth/kind:'bred' metadata so the
// heritage stripe on /d/:id can render it.
//
// The new dream walks the rest of the normal pipeline — the frontend
// navigates to /d/:newid which auto-fires /api/image just like a fresh
// recording. That keeps this endpoint short (no 90s image-gen chain) and
// reuses every downstream code path.
//
// ============ KILL SWITCH ============
// Flip BREEDING_ENABLED below to false to instantly disable the feature
// (returns 410). The matching client flag is the BREEDING_ENABLED const in
// index.html — flip both to fully hide.
// ============
//
// Reversion playbook: see dreams_breeding_experiment.md in user memory.

import crypto from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 60 };

const BREEDING_ENABLED = true;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SITE_ORIGIN = 'https://dreams-livid.vercel.app';

// Per-user daily cap. Each successful breed costs ~$0.05 (fusion LLM +
// analyze LLM + the downstream image generation). 10/day per user is plenty
// for the experiment and bounds any runaway behaviour.
const DAILY_BREED_CAP = 10;

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
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

async function kvSetRaw(key, body) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return r.ok;
}

// Matches save.js: key + value go straight into the path. The caller is
// responsible for any per-segment encoding (e.g. encodeURIComponent on a
// raw email when we want the percent-encoded key shape).
async function kvLPush(key, value) {
  const r = await fetch(`${KV_URL}/lpush/${key}/${value}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

async function kvIncr(key) {
  const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  return Number.isFinite(result) ? result : Number(result);
}

async function kvExpire(key, ttl) {
  const r = await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${ttl}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

async function getSignedInEmail(req) {
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return null;
  const session = await kvGet(`session:${token}`);
  return session?.email || null;
}

// Valid dream ID — must match /api/dream/save's randomBytes(8).toString('base64url')
function isValidDreamId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{8,20}$/.test(s);
}

// ============ The fusion call ============

const FUSION_SYSTEM = `You combine two real dreams from the same dreamer into a single new "child" dream that genuinely fuses them — like a chimera, not a side-by-side mashup.

Rules:

1. Write the new dream in first person, in the dreamer's matter-of-fact recall voice. Use the same tense the parents use; if mixed, prefer past tense.
2. Length: 80–220 words. Dream-recall style — fragments, sudden transitions, mood shifts, abrupt scene changes. Don't over-narrate or impose plot.
3. Carry at least TWO specific concrete motifs from EACH parent — named objects, places, people, transformations, sensations. Don't invent motifs that aren't in either parent.
4. Weave them so the new dream has its own internal logic. Don't just concatenate Parent A then Parent B. The fusion should feel like a real third dream the same person had, with motifs from both surfacing the way dream-elements do — half-named, half-disguised, sometimes in the wrong order.
5. Don't reference "the other dream" or "two dreams" — this dream is unaware of its parents. The dreamer is the same person dreaming a third dream.
6. Return ONLY the new dream text. No preamble, no commentary, no quotes around the text, no title.`;

async function fuseDreams(parentA, parentB) {
  if (!OPENAI_KEY) throw new Error('openai_not_configured');
  const userPrompt = `Parent dream A:
"""
${parentA.text.trim()}
"""

Parent dream B:
"""
${parentB.text.trim()}
"""

Write the child dream.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: FUSION_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.85, // a bit higher than analyze — fusion benefits from some surprise
      max_tokens: 600,
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`fusion_llm_${r.status}: ${errText.slice(0, 300)}`);
  }
  const completion = await r.json();
  const text = (completion.choices?.[0]?.message?.content || '').trim();
  if (!text || text.length < 40) throw new Error('fusion_empty');
  return text;
}

// We call /api/analyze over HTTP (rather than importing it) so we don't
// have to factor out its internals. Same-region serverless-to-serverless
// fetch is fast — ~50ms overhead on top of the ~10s LLM call.
async function analyzeText(text) {
  const r = await fetch(`${SITE_ORIGIN}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`analyze_${r.status}: ${errText.slice(0, 300)}`);
  }
  const { analysis } = await r.json();
  return analysis || null;
}

// ============ Handler ============

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (!BREEDING_ENABLED) {
    return res.status(410).json({ error: 'feature_disabled', message: 'Breeding is currently turned off.' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'kv_not_configured' });
  if (!OPENAI_KEY) return res.status(503).json({ error: 'openai_not_configured' });

  const email = await getSignedInEmail(req);
  if (!email) {
    return res.status(401).json({ error: 'sign_in_required', message: 'Sign in to breed your dreams.' });
  }

  const { parent_a_id, parent_b_id } = req.body || {};
  if (!isValidDreamId(parent_a_id) || !isValidDreamId(parent_b_id)) {
    return res.status(400).json({ error: 'bad_parents', message: 'Provide two valid dream IDs.' });
  }
  if (parent_a_id === parent_b_id) {
    return res.status(400).json({ error: 'same_parent', message: 'Pick two different dreams.' });
  }

  // ============ Rate limit ============
  // Daily cap per user — bumped with a counter that auto-expires.
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const countKey = `breed_count:${email}:${today}`;
  const newCount = await kvIncr(countKey);
  if (newCount === null) {
    // KV write failed — fail closed; user can try again
    return res.status(500).json({ error: 'rate_limit_check_failed' });
  }
  // First increment of the day → set the 26-hour expiry so the counter
  // resets cleanly. We use 26h to be safe across DST and clock skew.
  if (newCount === 1) await kvExpire(countKey, 26 * 60 * 60);
  if (newCount > DAILY_BREED_CAP) {
    return res.status(429).json({
      error: 'daily_cap_reached',
      message: `You've bred ${DAILY_BREED_CAP} dreams today. Try again tomorrow.`,
    });
  }

  // ============ Load parents ============
  const [parentA, parentB] = await Promise.all([
    kvGet(`dream:${parent_a_id}`),
    kvGet(`dream:${parent_b_id}`),
  ]);
  if (!parentA) return res.status(404).json({ error: 'parent_a_not_found', id: parent_a_id });
  if (!parentB) return res.status(404).json({ error: 'parent_b_not_found', id: parent_b_id });

  // Solo-breeding for Step 1: caller must own BOTH parents.
  // (Cross-user breeding will introduce a consent flow in Step 2.)
  const ownsA = parentA.owner_email === email;
  const ownsB = parentB.owner_email === email;
  if (!ownsA || !ownsB) {
    return res.status(403).json({
      error: 'not_owner',
      message: 'For now you can only breed two of your own dreams.',
    });
  }

  // ============ Fuse + analyze ============
  let hybridText;
  try {
    hybridText = await fuseDreams(parentA, parentB);
  } catch (err) {
    console.error('fusion failed:', err);
    return res.status(502).json({ error: 'fusion_failed', message: err.message });
  }

  let analysis = null;
  try {
    analysis = await analyzeText(hybridText);
  } catch (err) {
    // Analyze failure is non-fatal — save the dream with raw text and let
    // the dream page show a "Re-analyze" prompt to the owner.
    console.warn('analyze failed during breed; saving without analysis:', err.message);
  }

  // ============ Save the bred dream ============
  const id = crypto.randomBytes(8).toString('base64url');

  // Pull owner_handle / display_name for cheap rendering
  let ownerHandle = null;
  let ownerDisplayName = null;
  try {
    const user = await kvGet(`user:${email}`);
    ownerHandle = user?.handle || null;
    ownerDisplayName = user?.display_name || null;
  } catch (_) {}

  // Embed compact parent summaries on the bred dream record so the
  // heritage stripe is a single render with no extra fetches.
  const parentSummary = (p) => ({
    id: p.id,
    title: (p.title && p.title.trim()) || null,
    image_url: p.image_url || null,
    owner_handle: p.owner_handle || null,
    owner_display_name: p.owner_display_name || null,
  });
  const lineageDepth = Math.max(
    Number.isFinite(parentA.lineage_depth) ? parentA.lineage_depth : 0,
    Number.isFinite(parentB.lineage_depth) ? parentB.lineage_depth : 0,
  ) + 1;

  const record = {
    id,
    text: hybridText.trim(),
    title: (analysis && typeof analysis.title === 'string' && analysis.title.trim()) || null,
    analysis: analysis || null,
    dreamer: parentA.dreamer || parentB.dreamer || null, // carry the dreamer profile forward
    audio_url: null, // bred dreams have no audio source
    owner_email: email,
    owner_handle: ownerHandle,
    owner_display_name: ownerDisplayName,
    visibility: 'public',
    device_id: parentA.device_id || parentB.device_id || null,
    created_at: new Date().toISOString(),
    word_count: hybridText.trim().split(/\s+/).length,
    // Breeding metadata — the marker that makes this dream identifiable
    // for reversion and gates the heritage-stripe render.
    kind: 'bred',
    parents: [parentSummary(parentA), parentSummary(parentB)],
    parent_ids: [parentA.id, parentB.id],
    lineage_depth: lineageDepth,
  };

  try {
    await kvSetRaw(`dream:${id}`, JSON.stringify(record));
    await kvLPush('dreams:recent', id);
    // Trim the global recent list to 200 (matches save.js)
    await fetch(`${KV_URL}/ltrim/dreams:recent/0/199`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    // Owner's personal library — push both key shapes so /api/user/dreams
    // finds it regardless of how Upstash normalizes the @ in the key.
    await kvLPush(`user_dreams:${email}`, id);
    await kvLPush(`user_dreams:${encodeURIComponent(email)}`, id);
  } catch (err) {
    console.error('breed save failed:', err);
    return res.status(500).json({ error: 'save_failed', message: err.message });
  }

  return res.status(200).json({
    id,
    permalink: `/d/${id}`,
    created_at: record.created_at,
    has_analysis: !!analysis,
    breeds_remaining_today: Math.max(0, DAILY_BREED_CAP - newCount),
  });
}
