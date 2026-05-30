// GET /api/dream/backfill-lc   (owner-only, idempotent)
//
// One-time migration: walks every dream:* record via SCAN and writes the
// case-insensitive lookup pointer  dreamlc:<lowercased-id> → real id  so that
// a /d/:id link transcribed in the wrong case still resolves
// (see the fallback in /api/dream/[id]). New dreams write this pointer on save;
// this covers dreams created before the index existed. Safe to run repeatedly.
//
// Trigger by visiting the URL while signed in as the admin account. If it ever
// reports `partial: true` (hit the time budget), just open it again — it
// resumes from where it left off (the work is idempotent).

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
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
  return typeof result === 'string' ? JSON.parse(result) : result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  // Owner-only: the signed-in session must be the admin account. The server
  // is the source of truth — this is not a UI-only gate.
  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email || session.email.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const idRe = /^[A-Za-z0-9_-]{8,20}$/;
  const PREFIX = 'dream:';
  let cursor = '0';
  let scanned = 0, written = 0, skipped = 0;
  const started = Date.now();

  try {
    do {
      // `dream:*` matches only dream records — not dreams:recent, dreamlc:*,
      // device:*, etc. (the char after "dream" must be ":").
      const sr = await fetch(`${KV_URL}/scan/${cursor}/match/dream:*/count/200`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (!sr.ok) throw new Error(`scan → ${sr.status}`);
      const { result } = await sr.json();
      cursor = Array.isArray(result) ? String(result[0]) : '0';
      const keys = (Array.isArray(result) ? result[1] : []) || [];

      const cmds = [];
      for (const key of keys) {
        if (typeof key !== 'string' || !key.startsWith(PREFIX)) { skipped++; continue; }
        const realId = key.slice(PREFIX.length);
        if (!idRe.test(realId)) { skipped++; continue; }
        scanned++;
        cmds.push(['SET', `dreamlc:${realId.toLowerCase()}`, realId]);
      }
      if (cmds.length) {
        const pr = await fetch(`${KV_URL}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(cmds),
        });
        if (!pr.ok) throw new Error(`pipeline → ${pr.status}`);
        written += cmds.length;
      }

      // Stay inside the function budget; resume on the next call if needed.
      if (Date.now() - started > 50000 && cursor !== '0') {
        return res.status(200).json({
          ok: false, partial: true,
          message: 'time budget reached — open this URL again to continue',
          scanned, written, skipped,
        });
      }
    } while (cursor !== '0');

    return res.status(200).json({ ok: true, scanned, written, skipped });
  } catch (err) {
    console.error('backfill-lc failed:', err);
    return res.status(500).json({ error: 'backfill_failed', message: err.message, scanned, written });
  }
}
