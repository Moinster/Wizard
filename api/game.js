// Vercel serverless function: the HTTP skin over the shared game logic.
//
// Vercel gives each request a fresh, stateless invocation, so the game cannot
// live in process memory the way it does under server.js. State goes to a
// database instead (Supabase, or a Blob store), behind the same interface.

import { defaultStore } from "../public/lib/store.js";
import { handleGet, handlePost, sanitize } from "../public/lib/handler.js";

/**
 * Everything except writing to `res`, so the tests can drive it with plain
 * objects. Returns {status, body}.
 */
export async function route(store, req) {
  if (req.method === "GET") {
    const q = req.query || {};
    return handleGet(store, {
      code: q.code,
      etag: q.etag,
      hostKey: q.hostKey,
      seatKey: q.seatKey,
    });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body || "{}"); }
      catch { return { status: 400, body: { error: "bad_json", message: "That request wasn't valid JSON." } }; }
    }
    body = body || {};
    const out = await handlePost(store, body);
    return {
      status: out.status,
      body: sanitize(out.body, {
        hostKey: body.hostKey,
        seatKey: (out.body && out.body.seatKey) || body.seatKey,
      }),
    };
  }

  return { status: 405, body: { error: "bad_method", message: "Use GET or POST." } };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const store = defaultStore();
  if (!store) {
    return res.status(500).json({
      error: "no_store",
      message: "No database is connected to this project. Set SUPABASE_URL and SUPABASE_KEY (or connect a Blob store) and redeploy.",
    });
  }

  try {
    if (req.method === "OPTIONS") return res.status(204).end();
    const out = await route(store, req);
    if (out.status === 405) res.setHeader("Allow", "GET, POST");
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error("wizard api", err);
    return res.status(500).json({ error: "server", message: "Something broke on the server." });
  }
}
