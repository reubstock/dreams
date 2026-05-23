// GET /api/dream/:id
// Returns the full saved dream record from Redis.

export const config = { api: { bodyParser: false }, maxDuration: 30 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'storage_not_configured' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) {
    return res.status(400).json({ error: 'bad_id' });
  }

  try {
    const r = await fetch(`${KV_URL}/get/dream:${id}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) throw new Error(`KV get → ${r.status}`);
    const { result } = await r.json();
    if (!result) return res.status(404).json({ error: 'not_found', id });
    const dream = typeof result === 'string' ? JSON.parse(result) : result;

    // Backfill owner_handle / owner_display_name for pre-migration dreams
    // by looking up the owner's user record. We don't write it back here;
    // the next dream-update will persist it. Cheap one-shot read.
    if (dream.owner_email && (!dream.owner_handle || !dream.owner_display_name)) {
      try {
        const ur = await fetch(`${KV_URL}/get/user:${encodeURIComponent(dream.owner_email)}`, {
          headers: { Authorization: `Bearer ${KV_TOKEN}` },
        });
        if (ur.ok) {
          const { result: uRes } = await ur.json();
          if (uRes) {
            const user = typeof uRes === 'string' ? JSON.parse(uRes) : uRes;
            if (user) {
              if (!dream.owner_handle && user.handle) dream.owner_handle = user.handle;
              if (!dream.owner_display_name && user.display_name) dream.owner_display_name = user.display_name;
            }
          }
        }
      } catch (_) {}
    }

    // Lazy image-validation backfill for dreams analyzed under earlier
    // versions of /api/analyze that didn't surname-check the LLM's
    // commons_filename. A filename like "The_Dream.jpg" 200s on Wikimedia
    // but is a tourist photo, not Rousseau's painting. Here we re-resolve
    // any cultural_relative whose filename doesn't mention the artist, then
    // write the corrected dream back so the next read is fast.
    try {
      const fixed = await backfillImagesIfNeeded(dream);
      if (fixed) {
        await fetch(`${KV_URL}/set/dream:${id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(dream),
        });
      }
    } catch (_) {}

    // Resolve prev/next neighbors from the global recent list. dreams:recent is
    // lpushed (newest at index 0). "Next" = newer than this dream (smaller idx);
    // "Prev" = older (larger idx). Skip private dreams; bail out if we'd walk too far.
    let prev_id = null, next_id = null;
    try {
      const lr = await fetch(`${KV_URL}/lrange/dreams:recent/0/199`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (lr.ok) {
        const { result: ids } = await lr.json();
        if (Array.isArray(ids) && ids.length) {
          const myIdx = ids.indexOf(id);
          if (myIdx !== -1) {
            const fetchVis = async (otherId) => {
              try {
                const rr = await fetch(`${KV_URL}/get/dream:${otherId}`, {
                  headers: { Authorization: `Bearer ${KV_TOKEN}` },
                });
                if (!rr.ok) return null;
                const { result: rv } = await rr.json();
                if (!rv) return null;
                const d = typeof rv === 'string' ? JSON.parse(rv) : rv;
                return d.visibility === 'private' ? 'private' : 'public';
              } catch (_) { return null; }
            };
            for (let i = myIdx - 1; i >= Math.max(0, myIdx - 20); i--) {
              const v = await fetchVis(ids[i]);
              if (v === 'public') { next_id = ids[i]; break; }
            }
            for (let i = myIdx + 1; i < Math.min(ids.length, myIdx + 21); i++) {
              const v = await fetchVis(ids[i]);
              if (v === 'public') { prev_id = ids[i]; break; }
            }
          }
        }
      }
    } catch (_) {}

    return res.status(200).json({ dream, prev_id, next_id });
  } catch (err) {
    console.error('get failed:', err);
    return res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
}

// ============ Image-backfill helpers ============
// Same logic as /api/analyze's resolver, scoped to existing dreams that were
// analyzed before the surname-validation fix.

const COMMONS_FILEPATH = (fn) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fn)}`;
const COMMONS_SEARCH = (q) =>
  `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=10&srsearch=${encodeURIComponent(q)}`;
const PHOTO_TELLS = /(photograph|photo[_-]|portrait[_-]?(of|de)|self[_-]?portrait|snapshot|by[_-][A-Z][a-z]+_\d{4}|_\d{4}_(photo|snapshot)|wax_figure)/i;

async function fileExists(filename) {
  if (!filename || typeof filename !== 'string') return false;
  try {
    const r = await fetch(COMMONS_FILEPATH(filename), { method: 'HEAD' });
    return r.ok;
  } catch (_) { return false; }
}

async function searchCommons(query, opts = {}) {
  const kind = opts.kind || 'artwork';
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
      else return null;
    }
    const renderable = hits.filter((h) => /\.(jpe?g|png|gif)$/i.test(h.title));
    const pick = renderable[0] || hits[0];
    return pick ? pick.title.replace(/^File:/, '') : null;
  } catch (_) { return null; }
}

async function resolveRelative(r) {
  if (!r) return false;
  const surname = (r.artist || '').split(/\s+/).filter(Boolean).pop() || '';
  const llmFile = r.commons_filename || '';
  const llmAttributed = surname && llmFile.toLowerCase().includes(surname.toLowerCase());
  if (llmAttributed && (await fileExists(llmFile))) return false;
  const queries = [];
  if (r.artist && r.title) queries.push(`${r.artist} ${r.title}`);
  if (r.title && surname) queries.push(`${surname} ${r.title}`);
  if (r.artist) queries.push(`${r.artist} painting`);
  for (const q of queries) {
    const found = await searchCommons(q, { kind: 'artwork', requireToken: surname || null });
    if (found) { r.commons_filename = found; return true; }
  }
  if (r.commons_filename !== null) { r.commons_filename = null; return true; }
  return false;
}

async function resolveDreamer(d) {
  if (!d || !d.name) return false;
  if (d.image_filename && (await fileExists(d.image_filename))) return false;
  const queries = [`${d.name} portrait`, d.name];
  for (const q of queries) {
    const found = await searchCommons(q, { kind: 'person' });
    if (found) { d.image_filename = found; return true; }
  }
  return false;
}

async function backfillImagesIfNeeded(dream) {
  if (!dream || !dream.analysis) return false;
  const a = dream.analysis;
  let changed = false;
  // Cheap pre-check: only do work if at least one filename looks suspect.
  const needsRelativeWork = Array.isArray(a.cultural_relatives) && a.cultural_relatives.some((r) => {
    if (!r) return false;
    const surname = (r.artist || '').split(/\s+/).filter(Boolean).pop() || '';
    const f = (r.commons_filename || '').toLowerCase();
    return !surname || !f || !f.includes(surname.toLowerCase());
  });
  const needsDreamerWork = a.closest_historical_dreamer && a.closest_historical_dreamer.name && !a.closest_historical_dreamer.image_filename;
  if (!needsRelativeWork && !needsDreamerWork) return false;
  const jobs = [];
  if (needsRelativeWork) {
    for (const r of a.cultural_relatives) jobs.push(resolveRelative(r).then((c) => { if (c) changed = true; }));
  }
  if (needsDreamerWork) {
    jobs.push(resolveDreamer(a.closest_historical_dreamer).then((c) => { if (c) changed = true; }));
  }
  await Promise.race([
    Promise.all(jobs),
    new Promise((resolve) => setTimeout(resolve, 6000)),
  ]);
  return changed;
}
