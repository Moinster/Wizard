// What happens every round: the whole table bids within a second or two of
// each other. Only one writer can win a compare-and-swap round, so the Nth
// player needs N rounds, and a round costs a read plus a write -- most of a
// second against Blob in production. A fixed five attempts turned players away
// by arithmetic alone, and a six-player table reported "Too many phones wrote
// at once" as a matter of course.
//
// So these drive the real handler against a store with production-like write
// latency and assert that a full table gets its bids in.
import { memoryStore } from "../public/lib/store.js";
import { handlePost, handleGet } from "../public/lib/handler.js";

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const ok = (name, cond, detail = "") => eq(name, cond ? true : detail || false, true);

/** memoryStore, but each call takes as long as it would against Blob. */
function slowStore({ readMs = 50, writeMs = 550 } = {}) {
  const inner = memoryStore();
  const lag = (ms) => new Promise((r) => setTimeout(r, ms));
  let writes = 0, conflicts = 0;
  return {
    name: "slow",
    stats: () => ({ writes, conflicts }),
    async read(code, ifNoneMatch) { await lag(readMs); return inner.read(code, ifNoneMatch); },
    async write(code, data, etag) {
      await lag(writeMs);
      const out = await inner.write(code, data, etag);
      writes++;
      if (!out.ok) conflicts++;
      return out;
    },
  };
}

async function tableOf(store, seats) {
  const made = await handlePost(store, { action: "create", name: "P0", seatCount: seats, clientId: "c0" });
  const { code, hostKey } = made.body;
  const seatKeys = [made.body.seatKey];
  for (let i = 1; i < seats; i++) {
    const j = await handlePost(store, { action: "join", code, name: "P" + i, clientId: "c" + i });
    seatKeys.push(j.body.seatKey);
  }
  await handlePost(store, { action: "settings", code, hostKey, bidding: "open" });
  await handlePost(store, { action: "start", code, hostKey });
  return { code, hostKey, seatKeys };
}

// ---- a full table bidding at once -----------------------------------------
{
  const store = slowStore();
  const seats = 6;
  const { code, hostKey, seatKeys } = await tableOf(store, seats);

  const res = await Promise.all(
    seatKeys.map((k, i) => handlePost(store, { action: "bid", code, seatKey: k, idx: i, value: i % 2 }))
  );

  const busy = res.filter((r) => r.status === 409).length;
  const okCount = res.filter((r) => r.status === 200).length;
  eq(`all ${seats} bids are accepted`, okCount, seats);
  eq("none is turned away as busy", busy, 0);

  const read = await handleGet(store, { code, hostKey });
  const want = {}; for (let i = 0; i < seats; i++) want[i] = i % 2;
  eq("and every bid is actually recorded", read.body.game.bids, want);
  ok("the retries really happened, so this is not a no-contention run",
    store.stats().conflicts > 0, `conflicts=${store.stats().conflicts}`);
}

// ---- the deadline still ends it, rather than hanging the function ----------
{
  // Build a real game first, then make every further write lose its race. The
  // loop has to give up inside its own budget, well before the platform's
  // function timeout kills the request and leaves the phone with nothing.
  const inner = memoryStore();
  let refuse = false;
  const store = {
    name: "stuck",
    read: (code, t) => inner.read(code, t),
    write: async (code, data, etag) => (refuse && etag !== null ? { ok: false } : inner.write(code, data, etag)),
  };
  const { code, hostKey } = await tableOf(store, 3);
  refuse = true;

  const started = Date.now();
  const out = await handlePost(store, { action: "bid", code, hostKey, idx: 0, value: 1 });
  const took = Date.now() - started;
  eq("a write that can never land reports busy", [out.status, out.body.error], [409, "busy"]);
  ok("and gives up inside its budget, not on the function timeout",
    took < 8000, `took ${took}ms`);
  ok("having actually spent that budget retrying, not bailed at once",
    took > 1000, `took ${took}ms`);
}

console.log(fails.length ? `${fails.join("\n")}\n\n${pass} passed, ${fails.length} FAILED` : `${pass} passed`);
process.exit(fails.length ? 1 : 0);
