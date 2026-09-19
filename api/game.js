// Vercel Node function: the HTTP skin over lib/handler.js.
import { defaultStore } from "../lib/store.js";
import { handleGet, handlePost, sanitize } from "../lib/handler.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const store = defaultStore();
  if (!store) {
    return res.status(500).json({
      error: "no_store",
      message: "No Blob store is connected. Add one to this project in Vercel and redeploy.",
    });
  }

  try {
    let out;
    if (req.method === "GET") {
      const q = req.query || {};
      out = await handleGet(store, {
        code: q.code,
        etag: q.etag,
        hostKey: q.hostKey,
        seatKey: q.seatKey,
      });
    } else if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      out = await handlePost(store, body);
      out = { ...out, body: sanitize(out.body, { hostKey: body.hostKey, seatKey: out.body?.seatKey || body.seatKey }) };
    } else {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "bad_method", message: "Use GET or POST." });
    }
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error("wizard api", err);
    return res.status(500).json({ error: "server", message: "Something broke on the server." });
  }
}
