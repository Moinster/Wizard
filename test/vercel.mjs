// The serverless adapter: query/body parsing, method handling, and that no
// secret escapes in a response. The game logic itself is covered by run.mjs;
// this is the thin layer that only exists on Vercel, so nothing else exercises
// it and a mistake here would only show up in production.
import { memoryStore, freshBlobUrl } from "../public/lib/store.js";
import { route } from "../api/game.js";
import health from "../api/health.js";

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const ok = (name, cond, detail = "") => eq(name, cond ? true : detail || false, true);

const store = memoryStore();
const post = (body) => route(store, { method: "POST", body });
const get = (query) => route(store, { method: "GET", query });

// ---- create, with an object body (how Vercel normally delivers JSON) -------
const made = await post({ action: "create", name: "Mira", seatCount: 3, rounds: 5 });
eq("create returns 200", made.status, 200);
const { code, hostKey, seatKey } = made.body;
ok("a code comes back", typeof code === "string" && code.length === 4, code);
ok("the response carries no hostKey inside the game", !("hostKey" in made.body.game), Object.keys(made.body.game).join(","));
ok("and no seat keys", !("key" in made.body.game.seats[0]), Object.keys(made.body.game.seats[0]).join(","));

// ---- a raw string body, which Vercel hands over when content-type is odd ----
const joined = await post(JSON.stringify({ action: "join", code, name: "Jonas" }));
eq("a string body is parsed", joined.status, 200);
ok("joining returns a seat key", typeof joined.body.seatKey === "string", String(joined.body.seatKey));
ok("the joiner's key is not another player's", joined.body.seatKey !== seatKey, "keys collided");

// ---- malformed JSON is a clear 400, not a 500 ------------------------------
const broken = await post("{not json");
eq("malformed JSON is rejected cleanly", [broken.status, broken.body.error], [400, "bad_json"]);

// ---- GET reads query params -----------------------------------------------
const read = await get({ code, hostKey });
eq("GET returns the game", read.status, 200);
eq("and the host is recognised", read.body.game.isHost, true);
ok("an etag comes back for cheap polling", typeof read.body.etag === "string", String(read.body.etag));

const again = await get({ code, etag: read.body.etag, hostKey });
eq("an unchanged poll says so", again.body.unchanged, true);

const asPlayer = await get({ code, seatKey: joined.body.seatKey });
eq("a player is not the host", asPlayer.body.game.isHost, false);
eq("and is told which seat is theirs", asPlayer.body.game.youIdx, joined.body.seatIdx);

// ---- unknown game and bad method ------------------------------------------
eq("unknown code is 404", (await get({ code: "ZZZZ" })).status, 404);
eq("a missing body is handled", (await post(undefined)).body.error, "no_action");
eq("PUT is refused", (await route(store, { method: "PUT" })).status, 405);

// ---- no secret in any response body ---------------------------------------
const serialized = JSON.stringify([made.body.game, joined.body.game, read.body, asPlayer.body]);
ok("no host key leaks into any response", !serialized.includes(hostKey), "hostKey found in a response");
ok("no seat key leaks into any response", !serialized.includes(seatKey), "seatKey found in a response");

// ---- health endpoint, which decides solo vs multi-phone in the client ------
let status = null, payload = null;
health({ method: "GET" }, {
  setHeader() {},
  status(s) { status = s; return this; },
  json(b) { payload = b; },
});
eq("health replies 200", status, 200);
eq("health says ok, which is what the client checks", payload && payload.ok, true);

// ---- blob reads must not come from the CDN --------------------------------
{
  // The CDN would otherwise hand back a body from before the last write while
  // head() reports the new etag -- a current etag beside stale state, which
  // makes the caller stop asking. This was worth a minute of lag in practice.
  const u = new URL(freshBlobUrl({ url: "https://s.public.blob.vercel-storage.com/games/WZRD.json", etag: 'W/"a1b2"' }));
  eq("the read bypasses the CDN", u.searchParams.get("cache"), "0");
  eq("and is keyed on the version it expects", u.searchParams.get("v"), 'W/"a1b2"');
  eq("the path is untouched", u.pathname, "/games/WZRD.json");

  const noEtag = new URL(freshBlobUrl({ url: "https://s.public.blob.vercel-storage.com/games/AAAA.json" }));
  eq("a store without etags still bypasses the CDN", noEtag.searchParams.get("cache"), "0");
  ok("and adds no empty version", !noEtag.searchParams.has("v"), "v was set with no etag");

  const existing = new URL(freshBlobUrl({ url: "https://s.public.blob.vercel-storage.com/g.json?x=1", etag: "e1" }));
  eq("an existing query string survives", existing.searchParams.get("x"), "1");
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\n" + fails.join("\n")); process.exit(1); }
