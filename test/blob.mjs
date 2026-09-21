// The Vercel Blob store, which until now had no test at all -- the suite drove
// memoryStore through the API and checked a URL helper in isolation, so the one
// piece that actually talks to @vercel/blob was the one piece nothing ran.
//
// It was broken the whole time. The code was written against the 2.x API while
// package.json pinned 0.27, which has no ifMatch, no ifNoneMatch, no useCache
// and no etag on its metadata -- and ignores options it does not know instead
// of refusing them. So every write was a blind overwrite and every read could
// be a version behind, silently, in production.
//
// Two things here guard against that coming back. The fake below models the
// store's real behaviour including the parts that punish a missing option (ask
// without useCache:false and you get the stale CDN copy, exactly as you would
// in production). And the last block checks the fake against the installed
// package's own type definitions, so the fake cannot drift into testing an API
// that is not there.
import { readFileSync, readdirSync } from "node:fs";
import { blobStore } from "../public/lib/store.js";
import { handleGet, handlePost } from "../public/lib/handler.js";

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const ok = (name, cond, detail = "") => eq(name, cond ? true : detail || false, true);

class BlobNotFoundError extends Error {
  constructor() { super("The requested blob does not exist"); this.name = "BlobNotFoundError"; }
}
class BlobPreconditionFailedError extends Error {
  constructor() { super("Precondition failed"); this.name = "BlobPreconditionFailedError"; this.status = 412; }
}
class BlobAlreadyExistsError extends Error {
  constructor() { super("This blob already exists"); this.name = "BlobError"; this.status = 409; }
}

/**
 * A stand-in for the store. `cdn` is the copy a cached read would get: it
 * lags `origin` by one write, which is what the real CDN does and what makes
 * dropping useCache:false a test failure rather than a production incident.
 */
function fakeBlob({ failReads = 0, throwOnMissing = false, etagOn304 = true, rateLimitReads = 0 } = {}) {
  const origin = new Map();   // pathname -> { body, etag }
  const cdn = new Map();
  let seq = 0;
  let readsLeftToFail = failReads;
  let rateLimitedLeft = rateLimitReads;
  const calls = { get: [], put: [] };

  return {
    calls,
    seeStale: () => [...cdn.entries()],
    module: {
      BlobNotFoundError,
      BlobPreconditionFailedError,

      async get(pathname, opts = {}) {
        calls.get.push({ pathname, opts });
        if (readsLeftToFail > 0) {
          readsLeftToFail--;
          const err = new Error("fetch failed");
          err.cause = new Error("read ECONNRESET");
          throw err;
        }
        if (rateLimitedLeft > 0) {
          // What the real store does to an origin-read burst: sheds it with a
          // 403. The token is fine; it read the same key a moment ago.
          rateLimitedLeft--;
          throw new Error("Vercel Blob: Failed to fetch blob: 403 Forbidden");
        }
        const live = origin.get(pathname);
        // The real get() signals an absent blob by RETURNING null. The fake
        // said it threw, which is why the store's null branch was missing and
        // a mistyped join code answered 500 in production instead of "no game
        // with that code". throwOnMissing covers the other shape.
        if (!live) { if (throwOnMissing) throw new BlobNotFoundError(); return null; }
        // Forgetting useCache:false gets you the copy from before the last
        // write, with the current tag beside it -- the production bug, exactly.
        const served = opts.useCache === false ? live : (cdn.get(pathname) || live);
        if (opts.ifNoneMatch && opts.ifNoneMatch === served.etag) {
          // A real 304 reads its etag off the response header, and that header
          // is not always there -- production returned "".
          return { statusCode: 304, stream: null, blob: { etag: etagOn304 ? served.etag : "" } };
        }
        return {
          statusCode: 200,
          stream: new Response(served.body).body,
          blob: { etag: served.etag, pathname },
        };
      },

      async put(pathname, body, opts = {}) {
        calls.put.push({ pathname, opts });
        const live = origin.get(pathname);
        if (live && !opts.allowOverwrite) throw new BlobAlreadyExistsError();
        if (opts.ifMatch && (!live || live.etag !== opts.ifMatch)) throw new BlobPreconditionFailedError();
        if (live) cdn.set(pathname, live);          // the CDN keeps the old one
        origin.set(pathname, { body, etag: `b${++seq}` });
        return { pathname };
      },
    },
  };
}

// ---- missing, created, read back ------------------------------------------
{
  const fake = fakeBlob();
  const store = blobStore(async () => fake.module);

  eq("a code with no blob reads as no game", await store.read("AAAA"), null);
  eq("a create writes", await store.write("AAAA", { v: 1 }, null), { ok: true });
  eq("a second create is refused, so two games never share a code",
    await store.write("AAAA", { v: 99 }, null), { ok: false });

  const first = await store.read("AAAA");
  eq("the game reads back", first.data, { v: 1 });
  ok("with a real etag", typeof first.etag === "string" && first.etag.length > 0, String(first.etag));

  eq("the read asked origin, not the CDN", fake.calls.get[1].opts.useCache, false);
  eq("and it asked by path with public access", fake.calls.get[1].opts.access, "public");
}

// ---- the poll: unchanged in one call, and never a stale body ---------------
{
  const fake = fakeBlob();
  const store = blobStore(async () => fake.module);
  await store.write("BBBB", { v: 1 }, null);
  const first = await store.read("BBBB");

  const before = fake.calls.get.length;
  const same = await store.read("BBBB", first.etag);
  eq("a poll holding the current tag is told nothing changed", same, { unchanged: true, etag: first.etag });
  eq("which costs exactly one call", fake.calls.get.length - before, 1);
  eq("and carries no body back", fake.calls.get.at(-1).opts.ifNoneMatch, first.etag);

  await store.write("BBBB", { v: 2 }, first.etag);
  const after = await store.read("BBBB", first.etag);
  ok("a poll holding an old tag gets the new game, not a 304", !after.unchanged, JSON.stringify(after));
  eq("and the body is the version just written, not the CDN's", after.data, { v: 2 });
  ok("the CDN really was holding the older copy", JSON.stringify(fake.seeStale()).includes('v\\":1'),
    JSON.stringify(fake.seeStale()));
}

// ---- compare-and-swap ------------------------------------------------------
{
  const fake = fakeBlob();
  const store = blobStore(async () => fake.module);
  await store.write("CCCC", { v: 1 }, null);
  const first = await store.read("CCCC");

  eq("a write against the current tag lands", await store.write("CCCC", { v: 2 }, first.etag), { ok: true });
  eq("a write against a spent tag is refused rather than clobbering",
    await store.write("CCCC", { v: 2 }, first.etag), { ok: false });
  eq("the refusal is a rejection, not an exception", (await store.read("CCCC")).data, { v: 2 });

  const put = fake.calls.put[1];
  eq("the update carried ifMatch", put.opts.ifMatch, first.etag);
  eq("and allowed the overwrite", put.opts.allowOverwrite, true);
  eq("while the create allowed none", fake.calls.put[0].opts.allowOverwrite, false);
  ok("and the create sent no ifMatch", !("ifMatch" in fake.calls.put[0].opts),
    JSON.stringify(fake.calls.put[0].opts));
}

// ---- a broken read is never a missing game ---------------------------------
{
  const fake = fakeBlob({ failReads: 1 });
  const store = blobStore(async () => fake.module);
  fake.module.put("games/DDDD.json", JSON.stringify({ v: 7 }), { allowOverwrite: true });
  await new Promise((r) => setTimeout(r, 0));

  const got = await store.read("DDDD");
  eq("a read that dies mid-connection is retried", got.data, { v: 7 });
}
{
  const fake = fakeBlob({ failReads: 9 });
  const store = blobStore(async () => fake.module);
  let threw = null;
  try { await store.read("EEEE"); } catch (err) { threw = err; }
  ok("a read that keeps failing throws, so the API answers 500", threw !== null, "it returned instead");
  ok("and never reports the game missing, which would wipe it off a phone",
    threw !== null && /fetch failed/.test(threw.message), String(threw && threw.message));
}

// ---- an absent blob, reported either way ----------------------------------
{
  // The bug this pair exists for: get() returns null rather than throwing, the
  // store fell through to res.statusCode on null, and handleGet turned the
  // TypeError into a 500. A player mistyping a join code then got "something
  // broke" and a client that retries forever, instead of being told the code
  // is wrong.
  const returns = blobStore(async () => fakeBlob().module);
  eq("a get() that returns null reads as no game", await returns.read("NONE"), null);
  eq("and the API answers 404, not 500",
    (await handleGet(returns, { code: "NONE" })).status, 404);

  const throws = blobStore(async () => fakeBlob({ throwOnMissing: true }).module);
  eq("a get() that throws not-found reads as no game", await throws.read("NONE"), null);
  eq("and also answers 404", (await handleGet(throws, { code: "NONE" })).status, 404);
}

// ---- a 304 that carries no etag -------------------------------------------
{
  const fake = fakeBlob({ etagOn304: false });
  const store = blobStore(async () => fake.module);
  await store.write("GGGG", { v: 1 }, null);
  const first = await store.read("GGGG");

  const poll = await store.read("GGGG", first.etag);
  eq("an etag-less 304 still reports unchanged", poll.unchanged, true);
  eq("and hands back the tag that matched, so the phone keeps polling cheaply",
    poll.etag, first.etag);

  const through = await handleGet(store, { code: "GGGG", etag: first.etag });
  eq("the API passes that tag on", through.body.etag, first.etag);
}

// ---- the store shedding load is not the game breaking ---------------------
{
  // Origin reads bypass the CDN and the store rate limits them; a burst of
  // joins walked into it and every one came back "something broke". A shed
  // read is waited out, and is never mistaken for the game being gone.
  const fake = fakeBlob({ rateLimitReads: 2 });
  const store = blobStore(async () => fake.module);
  await store.write("HHHH", { v: 1 }, null);
  eq("a rate-limited read is waited out, not surfaced", (await store.read("HHHH")).data, { v: 1 });

  const shedding = blobStore(async () => fakeBlob({ rateLimitReads: 99 }).module);
  let threw = null;
  try { await shedding.read("HHHH"); } catch (err) { threw = err; }
  ok("a store that only ever sheds still raises, rather than claiming no game",
    threw !== null && /403/.test(threw.message), String(threw && threw.message));
  let apiThrew = false;
  try { await handleGet(blobStore(async () => fakeBlob({ rateLimitReads: 99 }).module), { code: "HHHH" }); } catch { apiThrew = true; }
  ok("and the API raises rather than answering 404", apiThrew, "it answered instead of raising");
}

// ---- end to end through the API, on the blob store -------------------------
{
  const fake = fakeBlob();
  const store = blobStore(async () => fake.module);

  const made = await handlePost(store, { action: "create", name: "Mira", seatCount: 3 });
  eq("create over blob returns 200", made.status, 200);
  const { code, hostKey } = made.body;

  await handlePost(store, { action: "join", code, name: "Jonas" });
  await handlePost(store, { action: "join", code, name: "Ada" });
  // The race below is about bids landing together, which only all-at-once
  // bidding allows; in turn, the second would be refused as out of turn.
  await handlePost(store, { action: "settings", code, hostKey, bidding: "open" });
  eq("start over blob returns 200", (await handlePost(store, { action: "start", code, hostKey })).status, 200);

  const read = await handleGet(store, { code, hostKey });
  eq("and the game reads back as playing", read.body.game.status, "playing");
  ok("with an etag to poll on", typeof read.body.etag === "string", String(read.body.etag));
  eq("the next poll says unchanged", (await handleGet(store, { code, etag: read.body.etag, hostKey })).body.unchanged, true);

  // Two phones bidding on the same tick. Without compare-and-swap one of these
  // overwrites the other and the bid just vanishes.
  await Promise.all([
    handlePost(store, { action: "bid", code, hostKey, idx: 0, value: 1 }),
    handlePost(store, { action: "bid", code, hostKey, idx: 1, value: 0 }),
  ]);
  const both = await handleGet(store, { code, hostKey });
  eq("two bids landing together both survive", both.body.game.bids, { 0: 1, 1: 0 });
}

// ---- the fake is checked against the real package --------------------------
{
  // This is the block that would have caught the original bug. The store asks
  // for options and reads fields; if the installed SDK does not declare them,
  // it ignores them silently and the game loses writes in production while
  // every test still passes.
  let types = "";
  try {
    const dir = "node_modules/@vercel/blob/dist";
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".d.ts")) types += readFileSync(`${dir}/${f}`, "utf8");
    }
  } catch {
    types = "";
  }

  if (!types) {
    fails.push("FAIL @vercel/blob is not installed, so the store's API contract is unchecked");
  } else {
    for (const name of ["useCache", "ifNoneMatch", "ifMatch", "allowOverwrite", "addRandomSuffix"]) {
      ok(`the installed SDK declares ${name}`, types.includes(`${name}?:`), "not in its type definitions");
    }
    ok("the installed SDK reports an etag, which the compare-and-swap needs",
      /\betag: string;/.test(types), "no etag field in its type definitions");
    ok("and exports the not-found error the store distinguishes on",
      types.includes("BlobNotFoundError"), "BlobNotFoundError is not exported");
    ok("and exports get(), which is how the store reads from origin",
      /declare function get\b/.test(types), "no get() in its type definitions");
  }
}

console.log(fails.length ? `${fails.join("\n")}\n\n${pass} passed, ${fails.length} FAILED` : `${pass} passed`);
process.exit(fails.length ? 1 : 0);
