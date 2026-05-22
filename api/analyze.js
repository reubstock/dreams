// Vercel serverless function: POST dream text → GPT-4o-mini → structured diagnostic JSON
//
// Model: gpt-4o-mini (~$0.15/M input, $0.60/M output → ~$0.01/dream)
// Schema returned is the same shape Dream 0001 hardcodes, so the front
// end can render any dream's diagnostic identically.

export const config = {
  api: { bodyParser: true },
  maxDuration: 60,
};

const SYSTEM_PROMPT = `You analyze dreams for a journaling product called Dreams. You produce structured JSON output that powers a diagnostic page comparable to a Hall/Van de Castle reading.

You must obey these rules:

1. Every claim must be earned from the specific dream text. No generic dream-symbol tropes ("water means emotions", "flight means freedom"). If the dream has no flight, do not invent it.
2. Be specific about what the dream is doing. The output should make the dreamer smarter about their own dream than the prose alone did.
3. Morphs are moments in the dream where one thing becomes — or quietly is now — another. They can be sudden ("then the floor became sand") or retroactive ("the rooms were all wrong"). Material substitutions, age inversions, identity changes, object losses, setting substitutions, symbol failures, biosphere inversions are all morphs.
4. The reading is interpretive but humble: identify what this dream is most likely about in the dreamer's waking life, given the specific motifs present. Include a brief caveat that interpretation is a hypothesis, not a diagnosis.
5. Cultural relatives must be REAL, well-known, public-domain artworks that share a specific motif with the dream. No fabricated artist names. Examples of safe choices: Hokusai's Great Wave, Friedrich's Monk by the Sea, Dürer's Melencolia I, Piranesi's Carceri, Botticelli's Madonnas, the Voynich Manuscript, Kuniyoshi prints, Bosch's Garden of Earthly Delights, Goya's Sleep of Reason, Klimt's The Kiss, Munch's The Scream, van Gogh's Starry Night, Vermeer's Girl with a Pearl Earring, Rembrandt's Night Watch, Rousseau's The Sleeping Gypsy. Pick artworks whose motif genuinely overlaps.

6. For each cultural relative include a "commons_filename" field — the exact filename on Wikimedia Commons (without "File:" prefix), e.g. "The_Great_Wave_off_Kanagawa.jpg" or "Caspar_David_Friedrich_-_Der_M%C3%B6nch_am_Meer.jpg". Be conservative: if you are not confident about the canonical filename, omit the field. The frontend will gracefully degrade to text-only.

Return only valid JSON matching the schema. Do not wrap in markdown.`;

const SCHEMA_HINT = {
  title: "string — a 3 to 6 word title for this dream, drawn from its most specific concrete image. Examples: 'The Frog in the Bathtub', 'A Phone with Foreign Letters', 'My Mother Made Younger', 'Late for the Wrong Train'. Specific, not generic. Title case. No quotes.",
  pattern_name: "string (2-5 words, the dream's dominant pattern, e.g. 'A dream of metamorphoses', 'A dream of pursuit', 'A dream of falling identities')",
  one_liner: "string (one sentence — the dream's structural verdict)",
  morphs: [{
    trigger_phrase: "string (verbatim quote from dream text)",
    kind: "string (e.g. 'Material substitution', 'Age inversion', 'Symbol failure', 'Spatial distortion', 'Biosphere inversion', 'Object loss', 'Setting substitution', 'Identity transformation', 'Communication failure')",
    before: "string (short, what the thing was)",
    after: "string (short, what it became)",
    gloss: "string (1-2 sentences on what this morph does in the dream)"
  }],
  reading: "string (3-5 short paragraphs of interpretive reading; what this dream is most likely about in waking life; include one caveat sentence)",
  cultural_relatives: [{
    phrase: "string (from dream)",
    artist: "string (real, public-domain)",
    title: "string (real work title)",
    year: "string",
    why: "string (1 sentence on the specific motif overlap)",
    commons_filename: "string OR omit if unsure — exact Wikimedia Commons filename, e.g. 'The_Great_Wave_off_Kanagawa.jpg'"
  }],
  stats: {
    morph_count: "number",
    stable_identity_count: "number",
    successful_actions: "number",
    other_speakers: "number"
  },
  closest_historical_dreamer: {
    name: "string (real historical figure with documented dream-relevant work, e.g. Kafka, Mary Shelley, Jung, Coleridge, Kekulé, Borges)",
    years: "string (e.g. '1883–1924')",
    work_or_dream: "string (the specific work or recorded dream)",
    why_match: "string (1-2 sentences on the specific overlap)"
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'analyze_not_configured',
      message: 'OPENAI_API_KEY is not set. Run `vercel env add OPENAI_API_KEY production` and redeploy.',
    });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    return res.status(400).json({
      error: 'dream_too_short',
      message: 'Provide at least 20 characters of dream text.',
    });
  }
  if (text.length > 8000) {
    return res.status(413).json({
      error: 'dream_too_long',
      message: 'Dream text exceeds 8000 characters. Trim and try again.',
    });
  }

  const userPrompt = `Analyze this dream. Return JSON matching the schema below — no markdown, no commentary, just the JSON object.

DREAM TEXT:
"""
${text.trim()}
"""

SCHEMA (do not return this hint; return a populated object with the same keys):
${JSON.stringify(SCHEMA_HINT, null, 2)}`;

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('GPT-4o-mini error', openaiRes.status, errText);
      return res.status(502).json({
        error: 'llm_api_error',
        status: openaiRes.status,
        message: errText.slice(0, 500),
      });
    }

    const completion = await openaiRes.json();
    const raw = completion.choices?.[0]?.message?.content || '{}';
    let analysis;
    try {
      analysis = JSON.parse(raw);
    } catch (e) {
      console.error('JSON parse error', e, raw);
      return res.status(502).json({ error: 'llm_invalid_json', message: 'Model returned non-JSON output.' });
    }

    return res.status(200).json({
      analysis,
      tokens_used: completion.usage || null,
      model: 'gpt-4o-mini',
    });
  } catch (err) {
    console.error('analyze handler error', err);
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Unexpected error during analysis.',
    });
  }
}
