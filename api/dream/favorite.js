// POST /api/dream/favorite  { id, on: true|false, note?: string }
// Toggle (or set) the signed-in user's favorite state for a dream.
// Returns { favorited: boolean }.
//
// When toggling ON and the dreamer is someone else, this also pushes a
// notification into the dreamer's inbox. The notification is dream-anchored
// — both parties have the dream image as a persistent visual cue when they
// reply to each other. If a `note` is included, it ships with the heart so
// the dreamer immediately knows WHY their dream resonated.
//
// Storage:
//   favorited:{email}:{id}            → "1" when favorited
//   user_favorites:{email}            → LIST of dream ids, newest first
//   favorite_count:{id}               → counter
//   inbox:{owner_email}               → notification messages (favorite kind)

import crypto from 'node:crypto';

export const config = { api: { bodyParser: true }, maxDuration: 10 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

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

async function kvCmd(path) {
  const r = await fetch(`${KV_URL}/${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
  return r.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });

  const { id, on, note } = req.body || {};
  if (!id || !/^[A-Za-z0-9_-]{8,20}$/.test(id)) {
    return res.status(400).json({ error: 'bad_id' });
  }
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';

  // Auth
  const token = getCookie(req, 'dreams_session');
  if (!token) return res.status(401).json({ error: 'not_signed_in' });
  const session = await kvGet(`session:${token}`);
  if (!session?.email) return res.status(401).json({ error: 'session_expired' });
  const email = session.email;

  // Dream must exist
  const dream = await kvGet(`dream:${id}`);
  if (!dream) return res.status(404).json({ error: 'dream_not_found' });

  const flagKey = `favorited:${email}:${id}`;
  const listKey = `user_favorites:${email}`;
  const countKey = `favorite_count:${id}`;

  // Decide on/off. If `on` is omitted, toggle based on current state.
  let nextState = typeof on === 'boolean' ? on : null;
  if (nextState === null) {
    const current = await kvGet(flagKey);
    nextState = !current;
  }

  try {
    if (nextState) {
      // Set the flag, prepend to list, bump count
      await kvSet(flagKey, '1');
      // LPUSH dream id to the user's favorites list. If it's already there
      // we'll dedup on read; trim list to prevent unbounded growth.
      await kvCmd(`lpush/${encodeURIComponent(listKey)}/${encodeURIComponent(id)}`);
      await kvCmd(`ltrim/${encodeURIComponent(listKey)}/0/499`);
      await kvCmd(`incr/${encodeURIComponent(countKey)}`);

      // Notify the dreamer — only if it's someone else's dream, and only
      // if we haven't already pushed a favorite notification for THIS
      // hearter+dream combo (so re-hearting after un-hearting doesn't spam).
      if (dream.owner_email && dream.owner_email.toLowerCase() !== email.toLowerCase()) {
        const ownerEmail = dream.owner_email;
        const alreadyNotifiedKey = `fav_notified:${ownerEmail}:${email}:${id}`;
        const alreadyNotified = await kvGet(alreadyNotifiedKey);
        if (!alreadyNotified) {
          await kvSet(alreadyNotifiedKey, '1');
          // Build a dream-anchored inbox message. The fave_kind field tells
          // the inbox renderer to use the favorite-card layout (heart icon +
          // dream image) instead of the standard note layout.
          const hearter = await kvGet(`user:${email}`);
          const fromHandle = hearter?.handle || null;
          const fromDisplay = hearter?.display_name || email.split('@')[0];
          const msg = {
            id: crypto.randomBytes(6).toString('base64url'),
            kind: 'favorite',
            from_handle: fromHandle,
            from_display_name: fromDisplay,
            from_email: email,
            to_handle: null, // resolved on render via dream.owner_handle
            body: cleanNote || '',
            dream_id: id,
            dream_title: dream.title || dream.analysis?.title || null,
            dream_image_url: dream.image_url || null,
            created_at: new Date().toISOString(),
            read: false,
          };
          await kvCmd(`lpush/${encodeURIComponent(`inbox:${ownerEmail}`)}/${encodeURIComponent(JSON.stringify(msg))}`);
          await kvCmd(`ltrim/${encodeURIComponent(`inbox:${ownerEmail}`)}/0/199`);
        }
      }
    } else {
      // Clear the flag, remove from list, decrement count
      await kvCmd(`del/${encodeURIComponent(flagKey)}`);
      // LREM removes all occurrences of the value (count=0). Some Upstash
      // versions need lrem/key/count/value path order; we use 0 = remove all.
      await kvCmd(`lrem/${encodeURIComponent(listKey)}/0/${encodeURIComponent(id)}`);
      await kvCmd(`decr/${encodeURIComponent(countKey)}`);
    }
    return res.status(200).json({ favorited: nextState });
  } catch (err) {
    console.error('favorite failed:', err);
    return res.status(500).json({ error: 'favorite_failed', message: err.message });
  }
}
