// Local dev server: serves public/ and runs the same API handler against an
// in-memory store, so the whole app can be driven without Vercel or Blob.
//   node test/dev-server.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { memoryStore } from "../lib/store.js";
import { handleGet, handlePost, sanitize } from "../lib/handler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const store = memoryStore();
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".json":"application/json" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, obj) => {
    res.writeHead(status, { "content-type":"application/json", "cache-control":"no-store" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/api/game") {
    try {
      if (req.method === "GET") {
        const q = Object.fromEntries(url.searchParams);
        const out = await handleGet(store, q);
        return send(out.status, out.body);
      }
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const out = await handlePost(store, body);
        return send(out.status, sanitize(out.body, { hostKey: body.hostKey, seatKey: out.body?.seatKey || body.seatKey }));
      }
      return send(405, { error:"bad_method", message:"Use GET or POST." });
    } catch (err) {
      console.error(err);
      return send(500, { error:"server", message:"Something broke on the server." });
    }
  }

  const file = url.pathname === "/" || url.pathname.startsWith("/g/") ? "/index.html" : url.pathname;
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control":"no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type":"text/plain" });
    res.end("not found");
  }
});

const port = Number(process.argv[2]) || 3000;
server.listen(port, () => console.log(`wizard dev server on http://localhost:${port}`));
