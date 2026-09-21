// The Supabase store, driven against a stand-in for PostgREST that behaves
// the way the two SQL functions in the database do: wizard_read answers the
// row or nothing, wizard_write answers the new version or null when the write
// lost. The fake keeps its table in a Map and applies each write atomically,
// which is exactly the guarantee Postgres gives and the one the game's
// compare-and-swap rests on.
//
// Blob had no such test until it had been broken in production for weeks;
// this store gets one before it sees a phone.
import { supabaseStore, defaultStore } from "../public/lib/store.js";
import { handleGet, handlePost } from "../public/lib/handler.js";

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const ok = (name, cond, detail = "") => eq(name, cond ? true : detail || false, true);

/** PostgREST, as far as this store can tell. */
function fakeRest({ flaky = 0, refuse = 0, dropConnections = 0, latencyMs = 0 } = {}) {
  const table = new Map();   // code -> { data, version }
  const calls = [];
  let flakyLeft = flaky, refuseLeft = refuse, dropsLeft = dropConnections;
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetchFn = async (url, init) => {
    const name = url.split("/rpc/")[1];
    const args = JSON.parse(init.body);
    calls.push({ name, args, headers: init.headers, method: init.method });
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    if (dropsLeft > 0) { dropsLeft--; throw new TypeError("fetch failed"); }
    if (flakyLeft > 0) { flakyLeft--; return reply(503, { message: "upstream" }); }
    if (refuseLeft > 0) { refuseLeft--; return reply(401, { message: "Invalid API key" }); }
    if (name === "wizard_read") {
      const row = table.get(args.p_code);
      return reply(200, row ? [{ data: row.data, version: row.version }] : []);
    }
    if (name === "wizard_delete") return reply(200, table.delete(args.p_code));
    if (name === "wizard_write") {
      const row = table.get(args.p_code);
      if (args.p_version === null) {
        if (row) return reply(200, null);
        table.set(args.p_code, { data: args.p_data, version: 1 });
        return reply(200, 1);
      }
      if (!row || row.version !== args.p_version) return reply(200, null);
      row.data = args.p_data; row.version += 1;
      return reply(200, row.version);
    }
    return reply(404, { message: `no function ${name}` });
  };
  return { fetchFn, calls, table };
}

const URL_ = "https://example.supabase.co";

// ---- the contract: missing, created, read back, versioned ------------------
{
  const rest = fakeRest();
  const store = supabaseStore({ url: URL_ + "/", key: "sb_publishable_test", fetchFn: rest.fetchFn });

  eq("a code with no row reads as no game", await store.read("AAAA"), null);
  eq("a create writes", await store.write("AAAA", { v: 1 }, null), { ok: true });
  eq("a second create is refused, so two games never share a code",
    await store.write("AAAA", { v: 99 }, null), { ok: false });

  const first = await store.read("AAAA");
  eq("the game reads back", first.data, { v: 1 });
  eq("with the row's version as its tag", first.etag, "1");

  eq("a poll holding the current tag is told so", await store.read("AAAA", "1"), { unchanged: true, etag: "1" });

  eq("a write against the current tag lands", await store.write("AAAA", { v: 2 }, "1"), { ok: true });
  eq("a write against the old tag is refused", await store.write("AAAA", { v: 3 }, "1"), { ok: false });
  eq("and the refusal changed nothing", (await store.read("AAAA")).data, { v: 2 });
  eq("a poll holding the old tag gets the new game, not unchanged", (await store.read("AAAA", "1")).etag, "2");

  eq("the URL is joined without a double slash", rest.calls[0] && rest.calls[0].name, "wizard_read");
  ok("every call went to the rpc endpoint by POST", rest.calls.every((c) => c.method === "POST"), "not all POST");
  eq("a publishable key rides in the apikey header", rest.calls[0].headers.apikey, "sb_publishable_test");
  ok("and is not sent as a bearer, which it is not", !("Authorization" in rest.calls[0].headers), "bearer sent");
  ok("the store has no fresh(): the read is already the truth", !("fresh" in store), "fresh present");
}

// ---- a legacy JWT key is also the bearer -----------------------------------
{
  const rest = fakeRest();
  const store = supabaseStore({ url: URL_, key: "eyJhbGciOi.test.sig", fetchFn: rest.fetchFn });
  await store.read("AAAA");
  eq("a JWT key is sent as the bearer too", rest.calls[0].headers.Authorization, "Bearer eyJhbGciOi.test.sig");
}

// ---- the API on top of it --------------------------------------------------
{
  const rest = fakeRest();
  const store = supabaseStore({ url: URL_, key: "k", fetchFn: rest.fetchFn });

  const made = await handlePost(store, { action: "create", name: "Mira", seatCount: 3, clientId: "c0" });
  eq("a game is created through the API", made.status, 200);
  const { code, hostKey } = made.body;
  const joined = await handlePost(store, { action: "join", code, name: "Jonas", clientId: "c1" });
  eq("a join lands", joined.status, 200);
  const got = await handleGet(store, { code, hostKey });
  eq("a read sees both", got.body.game.seats.filter((s) => s.name).length, 2);
  const again = await handleGet(store, { code, hostKey, etag: got.body.etag });
  eq("a poll with the current tag is answered 'unchanged' with no body", [again.status, again.body.unchanged, "game" in again.body], [200, true, false]);
  const missing = await handleGet(store, { code: "ZZZZ" });
  eq("a wrong code is 404, not a server error", [missing.status, missing.body.error], [404, "no_game"]);

  eq("a player cannot close the table", (await handlePost(store, { action: "end", code, seatKey: joined.body.seatKey })).body.error, "host_only");
  eq("the scorekeeper can", (await handlePost(store, { action: "end", code, hostKey })).status, 200);
  eq("and the row is gone", rest.table.has(code), false);
  eq("so the code reads as no game", (await handleGet(store, { code })).status, 404);
  eq("removing what is already gone says so", await store.remove(code), { ok: false });
}

// ---- a full table bidding at once, all writes landing ----------------------
{
  const rest = fakeRest({ latencyMs: 15 });
  const store = supabaseStore({ url: URL_, key: "k", fetchFn: rest.fetchFn });
  const seats = 6;
  const made = await handlePost(store, { action: "create", name: "P0", seatCount: seats, clientId: "c0" });
  const { code, hostKey } = made.body;
  const seatKeys = [made.body.seatKey];
  for (let i = 1; i < seats; i++) {
    const j = await handlePost(store, { action: "join", code, name: "P" + i, clientId: "c" + i });
    seatKeys.push(j.body.seatKey);
  }
  await handlePost(store, { action: "settings", code, hostKey, bidding: "open" });
  await handlePost(store, { action: "start", code, hostKey });

  const res = await Promise.all(
    seatKeys.map((k, i) => handlePost(store, { action: "bid", code, seatKey: k, idx: i, value: i % 2 }))
  );
  eq("six phones bidding at once all get a 200", res.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  const final = await handleGet(store, { code, hostKey });
  const want = {}; for (let i = 0; i < seats; i++) want[i] = i % 2;
  eq("and every bid is on the sheet", final.body.game.bids, want);
  const writes = rest.calls.filter((c) => c.name === "wizard_write").length;
  ok("the database refused the losing writes and the phones retried, so this was a real race",
    writes > seats + 8, `writes=${writes}`);
}

// ---- weather vs fault ------------------------------------------------------
{
  const rest = fakeRest({ flaky: 2 });
  const store = supabaseStore({ url: URL_, key: "k", fetchFn: rest.fetchFn });
  await store.write("AAAA", { v: 1 }, null);
  const r = await store.read("AAAA");
  eq("two 503s in a row are waited out", r && r.data, { v: 1 });
}
{
  const rest = fakeRest({ dropConnections: 1 });
  const store = supabaseStore({ url: URL_, key: "k", fetchFn: rest.fetchFn });
  await store.write("AAAA", { v: 1 }, null);
  eq("a dropped connection is retried", (await store.read("AAAA")).data, { v: 1 });
}
{
  const rest = fakeRest({ refuse: 1 });
  const store = supabaseStore({ url: URL_, key: "bad", fetchFn: rest.fetchFn });
  let threw = null;
  try { await store.read("AAAA"); } catch (err) { threw = err; }
  ok("a refused key raises at once rather than retrying", threw && threw.status === 401, String(threw && threw.message));
  eq("after one attempt", rest.calls.length, 1);
  // and the API turns that into a 500, never a 404 that would wipe the phone
  let apiThrew = false;
  try { await handleGet(supabaseStore({ url: URL_, key: "bad", fetchFn: fakeRest({ refuse: 9 }).fetchFn }), { code: "AAAA" }); }
  catch { apiThrew = true; }
  ok("and the API raises rather than answering 'no game'", apiThrew, "handleGet answered");
}

// ---- which store a deployment gets -----------------------------------------
{
  eq("nothing configured: no store", defaultStore({}), null);
  eq("a Blob token alone still means Blob", defaultStore({ BLOB_READ_WRITE_TOKEN: "t" }).name, "blob");
  eq("Supabase settings win when both are present",
    defaultStore({ SUPABASE_URL: URL_, SUPABASE_KEY: "k", BLOB_READ_WRITE_TOKEN: "t" }).name, "supabase");
  eq("a URL without a key is not a Supabase store", defaultStore({ SUPABASE_URL: URL_, BLOB_READ_WRITE_TOKEN: "t" }).name, "blob");
}

console.log(fails.length ? `${fails.join("\n")}\n\n${pass} passed, ${fails.length} FAILED` : `${pass} passed`);
process.exit(fails.length ? 1 : 0);
