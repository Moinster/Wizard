// The game server. Serves public/ and runs the API against an in-memory store,
// so a game night needs nothing but Node and a Wi-Fi network -- no database,
// no accounts, no internet. Games live in memory and vanish when it stops.
//
//   node server.js [port]
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { memoryStore } from "./lib/store.js";
import { handleGet, handlePost, sanitize } from "./lib/handler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "public");
const store = memoryStore();
const TYPES = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml" };

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

/** Every non-internal IPv4 address, so phones on the same Wi-Fi get a URL. */
function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

const port = Number(process.argv[2]) || 3000;
// Bind every interface, not just loopback, or nothing else on the Wi-Fi can reach it.
server.listen(port, "0.0.0.0", () => {
  console.log(`\n  Wizard Scorekeeper\n`);
  console.log(`  this computer   http://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  other phones    http://${ip}:${port}`);
  if (!lanAddresses().length) console.log("  (no network interface found \u2014 other devices can't reach this)");
  console.log(`\n  Games live in memory: stopping the server clears them.\n`);
});
