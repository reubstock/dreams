// GET /api/wikimedia/search?q=...
// Searches Wikimedia Commons for image files matching the query.
// Returns the canonical filename of the first image hit (without "File:" prefix).
// Used as a client-side fallback when the LLM's commons_filename returns 404.

export const config = { api: { bodyParser: false }, maxDuration: 8 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800'); // 1 day edge cache
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const q = (req.query.q || '').toString().trim();
  if (!q || q.length < 3 || q.length > 300) {
    return res.status(400).json({ error: 'bad_query' });
  }

  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=5&srsearch=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Dreams/1.0 (dreams-livid.vercel.app)' },
    });
    if (!r.ok) {
      return res.status(502).json({ error: 'wikimedia_error', status: r.status });
    }
    const data = await r.json();
    const hits = data?.query?.search || [];
    // Prefer .jpg/.png/.gif hits
    const filenameMatch = hits.find((h) => /\.(jpe?g|png|gif)$/i.test(h.title));
    if (!filenameMatch) {
      return res.status(404).json({ error: 'no_image_found' });
    }
    const filename = filenameMatch.title.replace(/^File:/, '');
    return res.status(200).json({
      filename,
      url: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=480`,
      query: q,
    });
  } catch (err) {
    return res.status(500).json({ error: 'search_failed', message: err.message });
  }
}
