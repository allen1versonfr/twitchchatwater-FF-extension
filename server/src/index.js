/* Twitch Chat Watcher paint server — Cloudflare Worker + D1.
 *
 * Public:
 *   GET    /v1/paints?logins=a,b,c   → { paints: { login: { paint, updated } } }   (≤100 logins, cached)
 * Signed in (Authorization: Bearer <Twitch user access token from our app>):
 *   PUT    /v1/me/paint   body { paint } → publish/replace your paint
 *   DELETE /v1/me/paint                  → unpublish
 *
 * Who you are comes only from Twitch: the token is checked with id.twitch.tv/oauth2/validate and must
 * belong to our Twitch app (TWITCH_CLIENT_ID). Nothing in the request body can choose the account.
 * The token is revoked right after use; it is never stored.
 *
 * Stored per account: Twitch user ID, current login, the paint, and two timestamps. No IPs, no chat.
 * A daily cron re-checks logins against Twitch so renamed accounts move their paint and deleted
 * accounts lose theirs (needs TWITCH_CLIENT_SECRET as a Worker secret).
 */
import Paint from "../../paints.js";

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const MAX_LOOKUP = 100;
const MAX_BODY = 4096;
const WRITE_COOLDOWN_MS = 10_000;
const RECHECK_AFTER_MS = 7 * 24 * 3600 * 1000;

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    ...extra
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers })
  });
}

const fail = (status, error) => json({ error }, status);

function idBase(env) {
  return env.TWITCH_ID_BASE || "https://id.twitch.tv";
}
function apiBase(env) {
  return env.TWITCH_API_BASE || "https://api.twitch.tv";
}

// ---------- auth ----------

async function whoAmI(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer ([A-Za-z0-9]{10,100})$/);
  if (!m) return { error: [401, "Sign in with Twitch first."] };
  const token = m[1];
  let r;
  try {
    r = await fetch(idBase(env) + "/oauth2/validate", { headers: { Authorization: "OAuth " + token } });
  } catch (e) {
    return { error: [503, "Couldn't reach Twitch to check your sign-in."] };
  }
  if (r.status === 401) return { error: [401, "Your Twitch sign-in expired. Try again."] };
  if (!r.ok) return { error: [503, "Twitch sign-in check failed."] };
  const v = await r.json();
  // Only tokens issued to our own Twitch app count; otherwise any site's token could be replayed here.
  if (!v || v.client_id !== env.TWITCH_CLIENT_ID) return { error: [403, "That sign-in wasn't made for this app."] };
  const userId = String(v.user_id || "");
  const login = String(v.login || "").toLowerCase();
  if (!/^\d{1,20}$/.test(userId) || !LOGIN_RE.test(login)) return { error: [403, "Twitch didn't return an account."] };
  return { userId, login, token };
}

async function revoke(env, token) {
  try {
    await fetch(idBase(env) + "/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, token })
    });
  } catch (e) { /* best effort */ }
}

// ---------- handlers ----------

async function getPaints(url, env, ctx) {
  const raw = (url.searchParams.get("logins") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const logins = [...new Set(raw)].filter((l) => LOGIN_RE.test(l)).sort();
  if (!logins.length) return fail(400, "Give logins=a,b,c");
  if (logins.length > MAX_LOOKUP) return fail(400, `At most ${MAX_LOOKUP} logins per request.`);

  // Normalized URL as the cache key, so "b,a" and "a,b" share an entry.
  const cacheKey = new Request(url.origin + "/v1/paints?logins=" + logins.join(","), { method: "GET" });
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const qs = logins.map((_, i) => "?" + (i + 1)).join(",");
  const { results } = await env.DB.prepare(`SELECT login, paint, updated FROM paints WHERE login IN (${qs})`)
    .bind(...logins)
    .all();
  const paints = {};
  for (const row of results || []) {
    let p = null;
    try { p = Paint.sanitize(JSON.parse(row.paint)); } catch (e) { p = null; }
    if (p) paints[row.login] = { paint: p, updated: row.updated };
  }
  const res = json({ paints }, 200, { "Cache-Control": "public, max-age=120" });
  if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function readBody(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function putPaint(request, env) {
  const body = await readBody(request);
  if (!body) return fail(400, "Send JSON { paint } under 4 KB.");
  const paint = Paint.sanitize(body.paint);
  if (!paint) return fail(422, "That paint isn't valid.");

  const me = await whoAmI(request, env);
  if (me.error) return fail(...me.error);
  try {
    const now = Date.now();
    const prev = await env.DB.prepare("SELECT updated FROM paints WHERE user_id = ?1").bind(me.userId).first();
    if (prev && now - prev.updated < WRITE_COOLDOWN_MS) return fail(429, "Slow down — wait a few seconds and try again.");
    await env.DB.batch([
      // The login now belongs to this account; drop any stale owner of the name.
      env.DB.prepare("DELETE FROM paints WHERE login = ?1 AND user_id <> ?2").bind(me.login, me.userId),
      env.DB.prepare(
        `INSERT INTO paints (user_id, login, paint, updated, checked) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, paint = excluded.paint,
           updated = excluded.updated, checked = excluded.checked`
      ).bind(me.userId, me.login, JSON.stringify(paint), now)
    ]);
    return json({ ok: true, user_id: me.userId, login: me.login, updated: now, paint });
  } finally {
    await revoke(env, me.token);
  }
}

async function deletePaint(request, env) {
  const me = await whoAmI(request, env);
  if (me.error) return fail(...me.error);
  try {
    await env.DB.prepare("DELETE FROM paints WHERE user_id = ?1").bind(me.userId).run();
    return json({ ok: true, user_id: me.userId, login: me.login });
  } finally {
    await revoke(env, me.token);
  }
}

// ---------- daily login re-check ----------

async function appToken(env) {
  const r = await fetch(idBase(env) + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID, client_secret: env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" })
  });
  if (!r.ok) throw new Error("app token failed: " + r.status);
  return (await r.json()).access_token;
}

export async function recheck(env, now = Date.now()) {
  if (!env.TWITCH_CLIENT_SECRET) return { skipped: "no TWITCH_CLIENT_SECRET" };
  const { results } = await env.DB.prepare("SELECT user_id, login FROM paints WHERE checked < ?1 ORDER BY checked LIMIT 100")
    .bind(now - RECHECK_AFTER_MS)
    .all();
  if (!results || !results.length) return { checked: 0 };
  const token = await appToken(env);
  const q = results.map((r) => "id=" + encodeURIComponent(r.user_id)).join("&");
  const r = await fetch(apiBase(env) + "/helix/users?" + q, {
    headers: { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + token }
  });
  if (!r.ok) throw new Error("helix users failed: " + r.status);
  const live = new Map(((await r.json()).data || []).map((u) => [String(u.id), String(u.login).toLowerCase()]));
  const stmts = [];
  let renamed = 0, removed = 0;
  for (const row of results) {
    const login = live.get(row.user_id);
    if (!login || !LOGIN_RE.test(login)) {
      stmts.push(env.DB.prepare("DELETE FROM paints WHERE user_id = ?1").bind(row.user_id));
      removed++;
    } else {
      if (login !== row.login) {
        stmts.push(env.DB.prepare("DELETE FROM paints WHERE login = ?1 AND user_id <> ?2").bind(login, row.user_id));
        renamed++;
      }
      stmts.push(env.DB.prepare("UPDATE paints SET login = ?1, checked = ?2 WHERE user_id = ?3").bind(login, now, row.user_id));
    }
  }
  await env.DB.batch(stmts);
  return { checked: results.length, renamed, removed };
}

// ---------- entry ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    try {
      if (url.pathname === "/v1/paints" && request.method === "GET") return await getPaints(url, env, ctx);
      if (url.pathname === "/v1/me/paint" && request.method === "PUT") return await putPaint(request, env);
      if (url.pathname === "/v1/me/paint" && request.method === "DELETE") return await deletePaint(request, env);
      if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "tcw-paints", version: 1 });
      return fail(404, "Not found");
    } catch (e) {
      console.error(e);
      return fail(500, "Server error");
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(recheck(env).then((r) => console.log("recheck", JSON.stringify(r))));
  }
};
