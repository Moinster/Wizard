// Drives the real API handler against the in-memory store: a full game, the
// permission rules, and the concurrency path.
import { memoryStore } from "../lib/store.js";
import { handleGet, handlePost } from "../lib/handler.js";
import { scoreFor } from "../lib/game.js";

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const okTrue = (name, cond, detail = "") => eq(name, Boolean(cond) || detail, true);

const store = memoryStore();
const post = (b) => handlePost(store, b);
const get = (q) => handleGet(store, q);

// ---- scoring rule ---------------------------------------------------------
eq("made bid of 0 pays 20", scoreFor(0, 0), 20);
eq("made bid of 3 pays 50", scoreFor(3, 3), 50);
eq("two tricks over costs 20", scoreFor(2, 4), -20);
eq("one trick under costs 10", scoreFor(1, 0), -10);

// ---- create + join --------------------------------------------------------
const created = await post({ action: "create", name: "Mira", seatCount: 4, rounds: 3 });
eq("create returns 200", created.status, 200);
const { code, hostKey } = created.body;
const host = { hostKey, seatKey: created.body.seatKey, idx: 0 };
okTrue("code is 4 chars", code.length === 4, `code=${code}`);
okTrue("create leaks no hostKey in game", !("hostKey" in created.body.game), Object.keys(created.body.game).join(","));
okTrue("create leaks no seat keys", !("key" in created.body.game.seats[0]), Object.keys(created.body.game.seats[0]).join(","));

const players = [host];
for (const name of ["Jonas", "Priya", "Theo"]) {
  const r = await post({ action: "join", code, name });
  eq(`join ${name} returns 200`, r.status, 200);
  players.push({ seatKey: r.body.seatKey, idx: r.body.seatIdx });
}
eq("four seats filled", players.map((p) => p.idx), [0, 1, 2, 3]);
eq("fifth join is refused", (await post({ action: "join", code, name: "Extra" })).body.error, "full");

// ---- permissions ----------------------------------------------------------
eq("player cannot start", (await post({ action: "start", code, seatKey: players[1].seatKey })).body.error, "host_only");
eq("stranger cannot bid", (await post({ action: "bid", code, seatKey: "nope", idx: 1, value: 0 })).body.error, "not_allowed");
eq("player cannot bid for someone else",
  (await post({ action: "bid", code, seatKey: players[1].seatKey, idx: 2, value: 0 })).body.error, "not_allowed");

eq("start returns 200", (await post({ action: "start", code, hostKey })).status, 200);
eq("cannot start twice", (await post({ action: "start", code, hostKey })).body.error, "already_started");

// ---- a round, bid by bid from four different "phones" ---------------------
const bid = (p, value) => post({ action: "bid", code, seatKey: p.seatKey, idx: p.idx, value });
const view = async (p = host) =>
  (await get({ code, hostKey: p.hostKey, seatKey: p.seatKey })).body.game;

eq("round 1 deals 1 card", (await view()).cards, 1);
eq("bid above the cards dealt is refused", (await bid(host, 2)).body.error, "bad_bid");
eq("cannot leave bidding early", (await post({ action: "toTricks", code, hostKey })).body.error, "bids_missing");

await bid(host, 1); await bid(players[1], 0); await bid(players[2], 0); await bid(players[3], 0);
eq("every bid is visible to every phone", (await view(players[2])).bids, { 0: 1, 1: 0, 2: 0, 3: 0 });
eq("toTricks now works", (await post({ action: "toTricks", code, hostKey })).status, 200);
eq("player cannot enter tricks", (await post({ action: "setTrick", code, seatKey: players[1].seatKey, idx: 1, value: 0 })).body.error, "host_only");

for (const [idx, v] of [[0, 1], [1, 0], [2, 0], [3, 0]]) await post({ action: "setTrick", code, hostKey, idx, value: v });
eq("score round 1", (await post({ action: "score", code, hostKey })).status, 200);
eq("totals after round 1", (await view()).totals, [30, 20, 20, 20]);

// ---- tricks must total the cards dealt ------------------------------------
await bid(host, 1); await bid(players[1], 1); await bid(players[2], 0); await bid(players[3], 0);
await post({ action: "toTricks", code, hostKey });
for (const [idx, v] of [[0, 2], [1, 2], [2, 0], [3, 0]]) await post({ action: "setTrick", code, hostKey, idx, value: v });
eq("mismatched tricks are refused", (await post({ action: "score", code, hostKey })).body.error, "tricks_sum");
await post({ action: "setTrick", code, hostKey, idx: 1, value: 0 });
eq("corrected tricks score", (await post({ action: "score", code, hostKey })).status, 200);
eq("totals after round 2", (await view()).totals, [20, 10, 40, 40]);

// ---- undo -----------------------------------------------------------------
eq("undo returns 200", (await post({ action: "undo", code, hostKey })).status, 200);
const undone = await view();
eq("undo rolls totals back", undone.totals, [30, 20, 20, 20]);
eq("undo reopens the round in tricks", [undone.round, undone.phase], [2, "tricks"]);
await post({ action: "score", code, hostKey });

// ---- final round ends the game -------------------------------------------
await bid(host, 2); await bid(players[1], 1); await bid(players[2], 0); await bid(players[3], 0);
await post({ action: "toTricks", code, hostKey });
for (const [idx, v] of [[0, 2], [1, 1], [2, 0], [3, 0]]) await post({ action: "setTrick", code, hostKey, idx, value: v });
await post({ action: "score", code, hostKey });
const final = await view();
eq("game is done after the last round", final.status, "done");
eq("final totals", final.totals, [60, 40, 60, 60]);
eq("no bidding once done", (await bid(host, 0)).body.error, "not_playing");

// ---- polling --------------------------------------------------------------
const fresh = await get({ code, hostKey });
const again = await get({ code, etag: fresh.body.etag, hostKey });
eq("unchanged poll is cheap", again.body.unchanged, true);
await post({ action: "rematch", code, hostKey });
const after = await get({ code, etag: fresh.body.etag, hostKey });
okTrue("a write ends the unchanged poll", !after.body.unchanged);
eq("rematch clears the board", (await view()).totals, [0, 0, 0, 0]);

// ---- concurrency: four phones bidding at the same instant ------------------
const race = await post({ action: "create", name: "A", seatCount: 4, rounds: 5 });
const rc = race.body.code, rHost = { hostKey: race.body.hostKey, seatKey: race.body.seatKey, idx: 0 };
const rPlayers = [rHost];
for (const n of ["B", "C", "D"]) {
  const r = await handlePost(store, { action: "join", code: rc, name: n });
  rPlayers.push({ seatKey: r.body.seatKey, idx: r.body.seatIdx });
}
await handlePost(store, { action: "start", code: rc, hostKey: rHost.hostKey });
const results = await Promise.all(rPlayers.map((p, i) =>
  handlePost(store, { action: "bid", code: rc, seatKey: p.seatKey, idx: p.idx, value: i === 0 ? 1 : 0 })));
eq("no simultaneous bid was rejected", results.map((r) => r.status), [200, 200, 200, 200]);
eq("all four bids survived the race",
  (await handleGet(store, { code: rc })).body.game.bids, { 0: 1, 1: 0, 2: 0, 3: 0 });

// ---- simultaneous joins get different seats -------------------------------
const j = await post({ action: "create", name: "H", seatCount: 4, rounds: 5 });
const jc = j.body.code;
const joins = await Promise.all(["X", "Y", "Z"].map((n) => handlePost(store, { action: "join", code: jc, name: n })));
eq("simultaneous joins all succeed", joins.map((r) => r.status), [200, 200, 200]);
eq("and land on distinct seats", joins.map((r) => r.body.seatIdx).sort(), [1, 2, 3]);

// ---- unknown game ---------------------------------------------------------
eq("unknown code is 404", (await get({ code: "ZZZZ" })).status, 404);

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\n" + fails.join("\n")); process.exit(1); }
