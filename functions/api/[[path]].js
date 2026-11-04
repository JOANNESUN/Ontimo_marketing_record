// Ontimo 推廣紀錄 API — Cloudflare Pages Function.
// Storage: D1 table `docs` (JSON documents per collection) + R2 bucket for photos.
// Auth: one shared team passcode → signed HttpOnly cookie.

const COLLECTIONS = new Set(["promoters", "locations", "contacts", "sessions", "inspo", "stock", "settings"]);
const MAX_DOC_BYTES = 64 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const COOKIE = "ontimo_session";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// The token changes whenever TEAM_PASSCODE or SESSION_SECRET changes, which logs everyone out.
const sessionToken = env => hmacHex(env.SESSION_SECRET, "ontimo:" + env.TEAM_PASSCODE);

function readCookie(request, name) {
  const c = request.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}
async function isAuthed(request, env) {
  const got = readCookie(request, COOKIE);
  return !!got && timingSafeEqual(got, await sessionToken(env));
}

const validId = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

export async function onRequest(context) {
  const { request, env, params } = context;
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const method = request.method;

  if (!env.TEAM_PASSCODE || !env.SESSION_SECRET) {
    return json({ error: "Server not configured: set TEAM_PASSCODE and SESSION_SECRET." }, 500);
  }

  // POST /api/login {passcode}
  if (parts[0] === "login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const ok = typeof body.passcode === "string" && timingSafeEqual(body.passcode, env.TEAM_PASSCODE);
    if (!ok) return json({ error: "wrong_passcode" }, 401);
    const token = await sessionToken(env);
    return json({ ok: true }, 200, {
      "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}`
    });
  }
  if (parts[0] === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, 401);

  // GET /api/sync?since=<ms> → every document changed at or after `since` (deleted ones as tombstones).
  if (parts[0] === "sync" && method === "GET") {
    const since = Number(new URL(request.url).searchParams.get("since")) || 0;
    const { results } = await env.DB.prepare(
      "SELECT collection, id, data, deleted, updated_at FROM docs WHERE updated_at >= ?1 ORDER BY updated_at ASC LIMIT 5000"
    ).bind(since).all();
    return json({
      rows: results.map(r => ({ collection: r.collection, id: r.id, deleted: !!r.deleted, updated_at: r.updated_at, data: r.deleted ? null : JSON.parse(r.data) })),
      now: Date.now()
    });
  }

  // /api/docs/:collection[/:id]
  if (parts[0] === "docs") {
    const col = parts[1], id = parts[2];
    if (!COLLECTIONS.has(col)) return json({ error: "unknown_collection" }, 400);

    if (method === "POST" && !id) {
      const data = await readDoc(request); if (data instanceof Response) return data;
      const newId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      const now = Date.now();
      await env.DB.prepare("INSERT INTO docs (collection, id, data, deleted, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)")
        .bind(col, newId, JSON.stringify(data), now).run();
      return json({ id: newId, updated_at: now }, 201);
    }
    if (!validId(id)) return json({ error: "bad_id" }, 400);

    if (method === "PUT") {
      const data = await readDoc(request); if (data instanceof Response) return data;
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO docs (collection, id, data, deleted, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)
         ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, deleted = 0, updated_at = excluded.updated_at`
      ).bind(col, id, JSON.stringify(data), now).run();
      return json({ id, updated_at: now });
    }
    if (method === "DELETE") {
      const now = Date.now();
      const row = await env.DB.prepare("SELECT data FROM docs WHERE collection = ?1 AND id = ?2").bind(col, id).first();
      await env.DB.prepare("UPDATE docs SET deleted = 1, data = '{}', updated_at = ?3 WHERE collection = ?1 AND id = ?2")
        .bind(col, id, now).run();
      // Remove an attached photo from R2 too.
      try {
        const d = row ? JSON.parse(row.data) : null;
        if (d && d.photo && validId(d.photo.id)) await env.PHOTOS.delete("photos/" + d.photo.id);
      } catch (e) { /* best effort */ }
      return json({ id, updated_at: now });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  // POST /api/photos (raw image body) → {id, url};  GET /api/photos/:id → image
  if (parts[0] === "photos") {
    if (method === "POST" && !parts[1]) {
      const type = request.headers.get("content-type") || "";
      if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(type)) return json({ error: "unsupported_type" }, 415);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_PHOTO_BYTES) return json({ error: "too_large" }, 413);
      const pid = crypto.randomUUID().replace(/-/g, "");
      await env.PHOTOS.put("photos/" + pid, buf, { httpMetadata: { contentType: type } });
      return json({ id: pid, url: "/api/photos/" + pid }, 201);
    }
    if (method === "GET" && validId(parts[1])) {
      const obj = await env.PHOTOS.get("photos/" + parts[1]);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" }
      });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  return json({ error: "not_found" }, 404);
}

async function readDoc(request) {
  const text = await request.text();
  if (text.length > MAX_DOC_BYTES) return json({ error: "too_large" }, 413);
  let data;
  try { data = JSON.parse(text); } catch (e) { return json({ error: "bad_json" }, 400); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "body_must_be_object" }, 400);
  return data;
}
