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

6. Return EXACTLY 1 cultural relative — the single best-matching famous artwork. Combined with the historical dreamer below, that's two reference points per dream; that's enough.

**CRITICAL — public domain only.** The artwork MUST be by an artist who died before 1929, because only those works are reliably available on Wikimedia Commons. NEVER pick Salvador Dalí (d.1989), René Magritte (d.1967), Pablo Picasso (d.1973), Henri Matisse (d.1954), Marc Chagall (d.1985), Frida Kahlo (d.1954), Edward Hopper (d.1967), Andrew Wyeth (d.2009), or any other 20th-century artist whose work is still in copyright. Even though some of their paintings would feel like a perfect match for surreal/dream content, their images cannot render and the card breaks. Pick instead from the safe list below, all of whom are pre-1929 public domain.

**STRONGLY PREFER a work from the safe list.** You may pick a work outside the list only if (a) the artist died before 1929, AND (b) you are 100% certain the artist actually painted it, AND (c) it is as famous as items on the safe list, AND (d) it shares a more specific motif with the dream. NEVER invent paintings, NEVER attribute real titles to the wrong artist, NEVER pick obscure works. When in doubt: pick from the safe list, even if the motif overlap is approximate. A famous public-domain artwork with loose overlap renders correctly; an obscure or modern work that "matches better" fails to load an image and breaks the page.

Safe list (each is a real, world-famous, public-domain image on Wikimedia Commons):

  - Hokusai · The Great Wave off Kanagawa · 1831
  - Hieronymus Bosch · The Garden of Earthly Delights · c.1490–1510
  - Albrecht Dürer · Melencolia I · 1514
  - Caspar David Friedrich · Wanderer above the Sea of Fog · 1818
  - Caspar David Friedrich · The Monk by the Sea · 1810
  - Francisco Goya · The Sleep of Reason Produces Monsters · 1799
  - Francisco Goya · Saturn Devouring His Son · 1819–1823
  - Henri Rousseau · The Sleeping Gypsy · 1897
  - Henri Rousseau · The Dream · 1910
  - Edvard Munch · The Scream · 1893
  - Vincent van Gogh · The Starry Night · 1889
  - Johannes Vermeer · Girl with a Pearl Earring · c.1665
  - Rembrandt · The Night Watch · 1642
  - Sandro Botticelli · The Birth of Venus · c.1486
  - John Henry Fuseli · The Nightmare · 1781
  - Giovanni Battista Piranesi · Carceri d'Invenzione (Imaginary Prisons) · 1761
  - Maria Sibylla Merian · Metamorphosis Insectorum Surinamensium · 1705
  - Pieter Bruegel the Elder · The Tower of Babel · 1563
  - Pieter Bruegel the Elder · Hunters in the Snow · 1565
  - Diego Velázquez · Las Meninas · 1656
  - John Everett Millais · Ophelia · 1851–1852
  - J.M.W. Turner · The Slave Ship · 1840
  - Théodore Géricault · The Raft of the Medusa · 1818–1819
  - Eugène Delacroix · Liberty Leading the People · 1830
  - Caravaggio · The Calling of Saint Matthew · 1599–1600
  - El Greco · View of Toledo · c.1599
  - Edward Hopper · Nighthawks · 1942
  - Gustave Courbet · The Wave · c.1869
  - Katsushika Hokusai · The Dream of the Fisherman's Wife · 1814
  - Utagawa Kuniyoshi · Takiyasha the Witch and the Skeleton Spectre · c.1844

  Prefer artworks whose specific motif overlaps with this dream. If nothing on the list overlaps, you may pick another equally famous public-domain work — but only if you are CERTAIN the artist actually painted it.

7. For each cultural relative include a "commons_filename" field — the filename on Wikimedia Commons (without "File:" prefix). Use SIMPLE canonical filenames you have high confidence in (e.g. "The_Great_Wave_off_Kanagawa.jpg", "Albrecht_D%C3%BCrer_-_Melencolia_I.png"). The frontend has a multi-stage safety net: if your filename 404s, it searches Wikimedia Commons using "Artist Title", then falls back to "Title" alone, then to "Artist". So when in doubt, prefer common spelling.

8. Also include "wikipedia_url" — the full Wikipedia article URL for THE ARTWORK ITSELF (e.g. "https://en.wikipedia.org/wiki/The_Garden_of_Earthly_Delights"), NOT a biography of the artist. The "Learn More" link on each card uses it. If you're unsure whether a dedicated article exists, omit the field — the frontend will fall back to a Wikipedia search URL built from the title.

9. For closest_historical_dreamer, follow this SELECTION PROCESS — do not skip it:

   STEP A. Internally list the dream's 2–3 most specific motifs (e.g. "bodily transformation; failed phone call; younger mother"). These are the SPECIFIC visual + structural elements in the dream text, not generic Jungian categories.

   STEP B. Scan the list below. Each figure is tagged with the motifs their documented work centers on. Pick the figure with the MOST SPECIFIC motif overlap to your STEP A list.

   STEP C. Vary picks across dreams. The figures are diverse in geography, gender, era, and tradition by design. A reading that consistently picks the same three figures (Freud / Jung / Kafka) is a failure of imagination, not a feature.

   STEP D. **Freud is ONLY appropriate when the dream is genuinely about repression, wish-fulfillment, sexual or familial conflict.** **Jung is ONLY appropriate when the dream is genuinely about archetypes (anima/animus, shadow, mandala), the collective unconscious, or alchemical transformation.** **Kafka is ONLY appropriate when the dream is genuinely about bureaucratic powerlessness, bodily metamorphosis, or familial alienation.** If none of those apply, pick someone else from the list.

ANCHOR LIST. Each entry is one figure, life span, and 3–5 SPECIFIC motifs.

LITERARY / VISIONARY DREAMERS
  - Mary Shelley (1797–1851) — life animated from death; the laboratory; the waking dream that becomes Frankenstein
  - Samuel Taylor Coleridge (1772–1834) — Kubla Khan; opium reverie; the interrupted vision; the dome built in air
  - Lewis Carroll (1832–1898) — falling down a hole; talking animals; logic that bends; the dream within a dream
  - Robert Louis Stevenson (1850–1894) — Jekyll & Hyde; split identity; the "Brownies" who wrote his dreams
  - Edgar Allan Poe (1809–1849) — premature burial; the fevered nightmare; the haunted room; uncanny doubling
  - William Blake (1757–1827) — angels and devils; prophetic visions; illuminated manuscripts; the four Zoas
  - Gérard de Nerval (1808–1855) — Aurélia; melancholic descent; the dream as second life; lost beloved
  - August Strindberg (1849–1912) — A Dream Play; reality fragmenting on stage; the daughter of Indra
  - Marcel Proust (1871–1922) — involuntary memory; the half-waking moment; the petite madeleine
  - Jorge Luis Borges (1899–1986) — labyrinths; infinite libraries; doubles; mirrors; the dreamer dreamed
  - Franz Kafka (1883–1924) — bodily metamorphosis; bureaucratic absurdity; family alienation; the trial
  - Emily Dickinson (1830–1886) — death-as-sleep; the visionary moment at the threshold; "I heard a fly buzz"
  - Olive Schreiner (1855–1920) — allegorical dream-tales; women's awakening in vast landscapes (Dreams, 1890)
  - Christina Rossetti (1830–1894) — Goblin Market; sister-as-rescuer; forbidden fruit; the dream-allegory
  - Murasaki Shikibu (c.978–c.1014) — The Tale of Genji; dream-visitations; spirit possession; the absent beloved
  - Rabindranath Tagore (1861–1941) — Bengali poetry of half-waking; the soul's wandering; nature as inner landscape

MYSTICS, VISIONARIES, MEDIUMS, PROPHETS
  - Hildegard von Bingen (1098–1179) — radiant visions of fire and light; illuminated by God; the cosmos as living body
  - Julian of Norwich (1342–c.1416) — Revelations of Divine Love; the hazelnut held in the palm; the wound
  - St. Teresa of Ávila (1515–1582) — mystical ecstasies; the interior castle of the soul; spiritual marriage
  - Mechthild of Magdeburg (c.1207–c.1282) — The Flowing Light of the Godhead; the soul as bride; divine longing
  - Joan of Arc (c.1412–1431) — divine voices; prophetic visions; the call from beyond; the impossible mission
  - Emanuel Swedenborg (1688–1772) — spirit-world journeys; conversations with angels; the heavens charted
  - Black Elk (1863–1950) — Oglala Lakota holy man; the Great Vision at age nine; the sacred tree; the hoop of the people
  - Sojourner Truth (c.1797–1883) — visionary call to truth-telling; abolitionist prophecy; the voice that comes from elsewhere
  - Ibn al-ʿArabi (1165–1240) — Andalusian Sufi; dreams as the imaginal realm; the divine forms that appear
  - Rumi (1207–1273) — Persian Sufi; mystical love of Shams; the lost beloved; the reed cut from the bed
  - Ramakrishna (1836–1886) — Bengali mystic; ecstatic visions of the Divine Mother; samadhi; the temple at Dakshineswar
  - Sun Bu'er (1119–1182) — Daoist alchemist; inner-alchemy dream-poetry; the spirit-body's transformation
  - Maimonides (1138–1204) — Jewish philosopher writing in Arabic; dream-as-prophecy; the Guide for the Perplexed

SCIENTIFIC + DISCOVERY DREAMERS
  - August Kekulé (1829–1896) — the benzene-ring snake dream; scientific intuition; the ouroboros
  - Dmitri Mendeleev (1834–1907) — the periodic table arrived in a dream; ordered emergence from chaos
  - Elias Howe (1819–1867) — the sewing-machine eye in a dream; mechanical breakthrough
  - René Descartes (1596–1650) — three formative dreams of November 1619; the philosophy founded on dreams

DREAM THEORISTS
  - Hervey de Saint-Denys (1822–1892) — pioneering lucid-dreaming experiments; voluntary dream control
  - Artemidorus (2nd century CE) — Oneirocritica; the first systematic dream-interpretation manual; dreams as portents
  - Zhuangzi (c.369–286 BCE) — the butterfly dream; "Am I a man dreaming I'm a butterfly, or a butterfly dreaming I'm a man?"
  - Carl Jung (1875–1961) — archetypes; shadow; mandala; the collective unconscious; the Red Book (USE ONLY when dream is genuinely archetypal — see STEP D)
  - Sigmund Freud (1856–1939) — wish-fulfillment; repression; latent vs. manifest content (USE ONLY when dream is genuinely about repression — see STEP D)

You MAY pick a figure outside this list if their work matches a specific motif of THIS dream more sharply than anyone on the list. But the figure must have died before 1929 (public domain for portrait images) AND must have documented dream-related work. Cross-check: if the dream is about visions of light, Hildegard or Black Elk before Jung. If it's about prophecy or being called, Joan of Arc or Sojourner Truth before Freud. If it's about the lost beloved, Rumi or Nerval before Freud. If it's about metamorphosis of the body, Kafka or Sun Bu'er before Jung.

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
    _note: "EXACTLY 1 entry — see rule 6. One artist, one artwork.",
    phrase: "string (from dream)",
    artist: "string (real, public-domain)",
    title: "string (real work title)",
    year: "string",
    why: "string (1 sentence on the specific motif overlap)",
    commons_filename: "string OR omit if unsure — exact Wikimedia Commons filename, e.g. 'The_Great_Wave_off_Kanagawa.jpg'",
    wikipedia_url: "string OR omit — full Wikipedia article URL for the artwork itself, e.g. 'https://en.wikipedia.org/wiki/The_Great_Wave_off_Kanagawa'. Prefer the article ABOUT THE ARTWORK over the artist's biography."
  }],
  stats: {
    morph_count: "number",
    stable_identity_count: "number",
    successful_actions: "number",
    other_speakers: "number"
  },
  closest_historical_dreamer: {
    name: "string (real historical figure with documented dream-related work — see rule 9. Examples spanning the actual list: Hildegard von Bingen, Black Elk, Rumi, Murasaki Shikibu, Joan of Arc, Sojourner Truth, Ramakrishna, Emily Dickinson, Mary Shelley, Coleridge, Kafka, Borges. Do NOT default to Kafka/Freud/Jung unless their tagged motifs genuinely match.)",
    years: "string (e.g. '1883–1924')",
    work_or_dream: "string (the specific work or recorded dream)",
    why_match: "string (1-2 sentences on the SPECIFIC motif overlap — cite the concrete dream element, not generic 'about the unconscious')",
    image_filename: "string OR omit — Wikimedia Commons filename of EITHER a portrait of the figure OR an image from their relevant work (e.g. 'Hildegard_von_Bingen.jpg', 'Black_Elk.jpg', 'Murasaki_Shikibu.jpg', 'Sojourner_Truth_c1870.jpg'). Same fallback safety net — frontend searches Wikimedia for the dreamer's name if the filename 404s.",
    wikipedia_url: "string OR omit — Wikipedia article URL for the figure or their work"
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

    // Server-side image resolution: replace any LLM-supplied commons_filename
    // that 404s with a Wikimedia-search result, so the browser always renders
    // an image without having to chase fallbacks. Each lookup is ~200ms; we
    // run them concurrently so the total analyze time barely moves.
    await resolveAnalysisImages(analysis);

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

// ============ Image resolution helpers ============

const COMMONS_FILEPATH = (fn) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fn)}`;
const COMMONS_SEARCH = (q) =>
  `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=10&srsearch=${encodeURIComponent(q)}`;
const PHOTO_TELLS = /(photograph|photo[_-]|portrait[_-]?(of|de)|self[_-]?portrait|snapshot|by[_-][A-Z][a-z]+_\d{4}|_\d{4}_(photo|snapshot)|wax_figure)/i;

// HEAD the FilePath URL; treat 200 as valid, anything else as invalid.
// Note: Special:FilePath 302-redirects to the file's canonical URL on success
// and returns 404 if the file doesn't exist. fetch follows redirects by default.
async function fileExists(filename) {
  if (!filename || typeof filename !== 'string') return false;
  try {
    const r = await fetch(COMMONS_FILEPATH(filename), { method: 'HEAD' });
    return r.ok;
  } catch (_) { return false; }
}

async function searchCommons(query, opts = {}) {
  const kind = opts.kind || 'artwork';
  // For artwork searches we keep the artist's last name so we can require it
  // in the result filename — otherwise "A Cat in a Flower Pot" matches any
  // random cat photo someone uploaded.
  const requireToken = opts.requireToken || null;
  try {
    const r = await fetch(COMMONS_SEARCH(query), {
      headers: { 'User-Agent': 'Dreams/1.0 (dreams-livid.vercel.app)' },
    });
    if (!r.ok) return null;
    const data = await r.json();
    let hits = (data?.query?.search || []).filter((h) => /\.(jpe?g|png|gif|tiff?|svg)$/i.test(h.title));
    if (kind === 'artwork') {
      const wantsSelfPortrait = /self[-_ ]?portrait/i.test(query);
      hits = hits.filter((h) => wantsSelfPortrait || !PHOTO_TELLS.test(h.title));
    }
    if (requireToken) {
      const tok = requireToken.toLowerCase();
      const filtered = hits.filter((h) => h.title.toLowerCase().includes(tok));
      if (filtered.length) hits = filtered;
      else return null; // No hit attributed to the requested artist — bail
    }
    // Prefer browser-renderable formats (jpg/png/gif) over tiff/svg.
    // Chrome won't render <img src="...tif"> at all.
    const renderable = hits.filter((h) => /\.(jpe?g|png|gif)$/i.test(h.title));
    const pick = renderable[0] || hits[0];
    return pick ? pick.title.replace(/^File:/, '') : null;
  } catch (_) { return null; }
}

async function resolveCulturalRelative(r) {
  if (!r) return;
  const surname = (r.artist || '')
    .split(/\s+/)
    .filter(Boolean)
    .pop() || '';
  // Accept the LLM's filename only if (a) it 200s AND (b) the filename actually
  // mentions the artist. "The_Dream.jpg" 200s but is a tourist snapshot, not
  // Rousseau's painting — that's the failure mode we're guarding against.
  const llmFile = r.commons_filename || '';
  const llmAttributed = surname && llmFile.toLowerCase().includes(surname.toLowerCase());
  if (llmAttributed && (await fileExists(llmFile))) return;
  // Otherwise search Wikimedia for the artist's name + title and require the
  // surname in the result filename.
  const queries = [];
  if (r.artist && r.title) queries.push(`${r.artist} ${r.title}`);
  if (r.title && surname) queries.push(`${surname} ${r.title}`);
  if (r.artist) queries.push(`${r.artist} painting`);
  for (const q of queries) {
    const found = await searchCommons(q, { kind: 'artwork', requireToken: surname || null });
    if (found) { r.commons_filename = found; return; }
  }
  // Nothing attributed to the artist came back — clear the field so the
  // frontend hides the card rather than rendering a misleading stock photo.
  r.commons_filename = null;
}

async function resolveHistoricalDreamer(d) {
  if (!d || !d.name) return;
  if (await fileExists(d.image_filename)) return;
  const queries = [`${d.name} portrait`, d.name];
  for (const q of queries) {
    const found = await searchCommons(q, { kind: 'person' });
    if (found) { d.image_filename = found; return; }
  }
}

async function resolveAnalysisImages(analysis) {
  if (!analysis || typeof analysis !== 'object') return;
  const jobs = [];
  if (Array.isArray(analysis.cultural_relatives)) {
    for (const r of analysis.cultural_relatives) jobs.push(resolveCulturalRelative(r));
  }
  if (analysis.closest_historical_dreamer) {
    jobs.push(resolveHistoricalDreamer(analysis.closest_historical_dreamer));
  }
  // Run in parallel; cap the wall-clock cost. 3s was too tight — Wikimedia
  // 404 + redirect chains sometimes take a few seconds, and abandoning the
  // jobs mid-flight left bad LLM filenames in the saved record.
  await Promise.race([
    Promise.all(jobs),
    new Promise((resolve) => setTimeout(resolve, 10000)),
  ]);
}
