// Drives the real API handler against the in-memory store: a full game, the
// permission rules, and the concurrency path.
import { memoryStore } from "../public/lib/store.js";
import { handleGet, handlePost } from "../public/lib/handler.js";
import { scoreFor } from "../public/lib/game.js";

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


// ===========================================================================
// House rules: who deals, the seating, and the scoring and bidding variants.
// ===========================================================================
const table = async (seats = 4, rounds = 5, names = ["A", "B", "C", "D"]) => {
  const made = await post({ action: "create", name: names[0], seatCount: seats, rounds });
  const t = { code: made.body.code, hostKey: made.body.hostKey, seats: [{ seatKey: made.body.seatKey, idx: 0 }] };
  for (let i = 1; i < seats; i++) {
    const j = await post({ action: "join", code: t.code, name: names[i] });
    t.seats.push({ seatKey: j.body.seatKey, idx: j.body.seatIdx });
  }
  return t;
};
const viewOf = async (t, who) =>
  (await get({ code: t.code, hostKey: who ? undefined : t.hostKey, seatKey: who ? who.seatKey : undefined })).body.game;

// ---- choosing the first dealer --------------------------------------------
{
  const t = await table(4, 5);
  eq("dealer defaults to the first seat", (await viewOf(t)).dealer, 0);
  eq("a player cannot set the dealer",
    (await post({ action: "dealerStart", code: t.code, seatKey: t.seats[1].seatKey, idx: 2 })).body.error, "host_only");
  eq("host sets who deals first",
    (await post({ action: "dealerStart", code: t.code, hostKey: t.hostKey, idx: 2 })).status, 200);
  await post({ action: "start", code: t.code, hostKey: t.hostKey });
  const g = await viewOf(t);
  eq("round 1 deals from the chosen seat", g.dealer, 2);
  eq("and bidding starts to their left", g.order, [3, 0, 1, 2]);
  eq("the deal still moves one seat a round", [1, 2, 3, 4, 5].map((r) => (2 + r - 1) % 4), [2, 3, 0, 1, 2]);
  eq("house rules are closed once dealt",
    (await post({ action: "dealerStart", code: t.code, hostKey: t.hostKey, idx: 0 })).body.error, "already_started");
}

// ---- rearranging the table -------------------------------------------------
{
  const t = await table(4, 5, ["Ana", "Ben", "Cass", "Dev"]);
  await post({ action: "dealerStart", code: t.code, hostKey: t.hostKey, idx: 3 });   // Dev deals
  eq("host rearranges the seating",
    (await post({ action: "reorder", code: t.code, hostKey: t.hostKey, order: [3, 1, 0, 2] })).status, 200);
  const g = await viewOf(t);
  eq("seats follow the new order", g.seats.map((s) => s.name), ["Dev", "Ben", "Ana", "Cass"]);
  eq("the dealer follows the person, not the seat number", g.dealerStart, 0);
  eq("a seating that isn't a permutation is refused",
    (await post({ action: "reorder", code: t.code, hostKey: t.hostKey, order: [0, 0, 1, 2] })).body.error, "bad_order");
  // Keys must travel with their player, or everyone's phone loses its seat.
  const dev = t.seats[3];
  const seen = await viewOf(t, dev);
  eq("a moved player keeps their seat key", seen.youIdx, 0);
}

// ---- scoring variants ------------------------------------------------------
const playRound = async (t, bids, tricks) => {
  for (const s of t.seats) await post({ action: "bid", code: t.code, seatKey: s.seatKey, idx: s.idx, value: bids[s.idx] });
  await post({ action: "toTricks", code: t.code, hostKey: t.hostKey });
  for (const s of t.seats) await post({ action: "setTrick", code: t.code, hostKey: t.hostKey, idx: s.idx, value: tricks[s.idx] });
  return post({ action: "score", code: t.code, hostKey: t.hostKey });
};

{
  // A zero bid that comes off is worth a flat 20 under standard scoring, but
  // 10 per card dealt under "zero pays the round" -- so the same three rounds
  // of identical play have to diverge as the hands grow.
  const threeRounds = async (scoring) => {
    const t = await table(3, 5, ["A", "B", "C"]);
    await post({ action: "settings", code: t.code, hostKey: t.hostKey, scoring });
    await post({ action: "start", code: t.code, hostKey: t.hostKey });
    await playRound(t, [1, 0, 0], [1, 0, 0]);   // 1 card:  A takes it
    await playRound(t, [0, 2, 0], [0, 2, 0]);   // 2 cards: B takes both
    await playRound(t, [0, 3, 0], [0, 3, 0]);   // 3 cards: B takes all
    return (await viewOf(t)).totals;
  };

  // A and C pass every round; B bids and makes the lot.
  //   standard   A 20+20+20 +30(r1 bid 1)     B 20+40+50     C 20+20+20
  //   zeroScales A 10+20+30 shifted the same way as its zeros grow
  eq("standard: a made zero is a flat 20 whatever the round",
    await threeRounds("standard"), [70, 110, 60]);
  eq("zero pays the round: the same zeros grow with the hand",
    await threeRounds("zeroScales"), [80, 100, 60]);
}

{
  const t = await table(3, 5, ["A", "B", "C"]);
  await post({ action: "settings", code: t.code, hostKey: t.hostKey, scoring: "noNegative" });
  await post({ action: "start", code: t.code, hostKey: t.hostKey });
  await playRound(t, [1, 1, 0], [1, 0, 0]);   // B misses by one
  eq("no minus scores: a miss is zero, not -10", (await viewOf(t)).totals, [30, 0, 20]);
  eq("the chosen rules are visible to every phone", (await viewOf(t)).settings.scoring, "noNegative");
}

// ---- bidding variants ------------------------------------------------------
{
  const t = await table(3, 5, ["A", "B", "C"]);
  await post({ action: "settings", code: t.code, hostKey: t.hostKey, bidding: "screwDealer" });
  await post({ action: "dealerStart", code: t.code, hostKey: t.hostKey, idx: 0 });
  await post({ action: "start", code: t.code, hostKey: t.hostKey });
  // Round 1 deals one card. Seats 1 and 2 bid nothing, so seat 0 (the dealer)
  // bidding 1 would make the bids add up to the single trick available.
  await post({ action: "bid", code: t.code, seatKey: t.seats[1].seatKey, idx: 1, value: 0 });
  await post({ action: "bid", code: t.code, seatKey: t.seats[2].seatKey, idx: 2, value: 0 });
  const hooked = await post({ action: "bid", code: t.code, seatKey: t.seats[0].seatKey, idx: 0, value: 1 });
  eq("screw the dealer: the even bid is refused", hooked.body.error, "hooked");
  eq("and the dealer can still bid the other way",
    (await post({ action: "bid", code: t.code, seatKey: t.seats[0].seatKey, idx: 0, value: 0 })).status, 200);
}

{
  const t = await table(3, 5, ["A", "B", "C"]);
  await post({ action: "settings", code: t.code, hostKey: t.hostKey, bidding: "blind" });
  await post({ action: "start", code: t.code, hostKey: t.hostKey });
  await post({ action: "bid", code: t.code, seatKey: t.seats[0].seatKey, idx: 0, value: 1 });
  const asB = await viewOf(t, t.seats[1]);
  eq("blind: another player's bid is not in the payload", asB.bids, {});
  eq("but you can see that they have bid", asB.bidPlaced, [0]);
  const asA = await viewOf(t, t.seats[0]);
  eq("and you can always see your own", asA.bids, { 0: 1 });
  eq("the host cannot peek either", (await viewOf(t)).bids, {});

  await post({ action: "bid", code: t.code, seatKey: t.seats[1].seatKey, idx: 1, value: 0 });
  await post({ action: "bid", code: t.code, seatKey: t.seats[2].seatKey, idx: 2, value: 0 });
  eq("once the last bid lands they all show", (await viewOf(t, t.seats[1])).bids, { 0: 1, 1: 0, 2: 0 });
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\n" + fails.join("\n")); process.exit(1); }
