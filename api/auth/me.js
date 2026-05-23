// GET /api/auth/me
// Returns { signed_in: true, email } if a valid session cookie exists,
// otherwise { signed_in: false }.

export const config = { api: { bodyParser: false }, maxDuration: 5 };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = getCookie(req, 'dreams_session');
  if (!token || token.length > 200) return res.status(200).json({ signed_in: false });

  const session = await kvGet(`session:${token}`);
  if (!session || !session.email) {
    // Stale cookie — clear it
    res.setHeader('Set-Cookie', 'dreams_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ signed_in: false });
  }

  // Also fetch user record for selfie + handle + display name
  const user = (await kvGet(`user:${session.email}`)) || {};

  // Pull unread inbox count (best-effort; never block the auth response on it)
  let unread_count = 0;
  try {
    const r = await fetch(`${KV_URL}/lrange/inbox:${encodeURIComponent(session.email)}/0/99`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (r.ok) {
      const { result } = await r.json();
      if (Array.isArray(result)) {
        for (const s of result) {
          try {
            const m = typeof s === 'string' ? JSON.parse(s) : s;
            if (m && !m.read) unread_count++;
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  return res.status(200).json({
    signed_in: true,
    email: session.email,
    handle: user.handle || null,
    display_name: user.display_name || session.email.split('@')[0],
    selfie_url: user.selfie_url || null,
    unread_count,
  });
}
