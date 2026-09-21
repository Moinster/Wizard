// The API's brain, kept free of Vercel's req/res so the tests can drive it
// directly. api/game.js is the thin adapter around this.

import {
  ROUNDS_FOR, newGame, publicView, randomCode,
  applyJoin, applyRename, applyStart, applyBid, applyClearBid, applyTrump,
  applyReorder, applyDealerStart, applySettings,
  applyToTricks, applyBackToBids, applySetTrick, applyScore, applyUndo, applyRematch,
} from "./game.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

const ok = (body) => ({ status: 200, body });
const fail = (status, error, message) => ({ status, body: { error, message } });

/**
 * Read, mutate, write-if-unchanged, retry. `fn` may return {error, message} to
 * reject the whole attempt, or any other object to have its fields merged into
 * the response.
 *
 * Contention here is the normal case, not an edge case: everyone at the table
 * bids within a second or two of each other, every round. Only one writer can
 * win a round, so the Nth player needs N rounds -- and a round costs a read
 * plus a write, which is most of a second against Blob. A fixed five attempts
 * therefore turned players away by arithmetic alone: a six-player table could
 * not get its last bid in however well the network behaved.
 *
 * So retry against a DEADLINE rather than a count, and back off proportionally
 * so losers spread out instead of thrashing into each other. The budget stays
 * clear of the platform's own function timeout (10s by default on Vercel) so a
 * caller always gets a real answer rather than a dead connection. The player
 * sees none of this: the client renders their tap immediately and this only
 * has to land eventually.
 */
const RETRY_BUDGET_MS = 7000;

async function mutate(store, code, fn, opts = {}) {
  const budget = opts.budgetMs ?? RETRY_BUDGET_MS;
  const sleepFn = opts.sleep || sleep;
  const now = opts.now || Date.now;
  const deadline = now() + budget;

  for (let attempt = 1; ; attempt++) {
    const current = await store.read(code);
    if (!current) return fail(404, "no_game", "No game with that code.");
    const next = clone(current.data);
    const out = fn(next) || {};
    if (out.error) return fail(400, out.error, out.message);
    next.v = (next.v || 0) + 1;
    next.updatedAt = Date.now();
    const written = await store.write(code, next, current.etag);
    if (written.ok) return { status: 200, body: { ...out, game: next } };

    // Someone else got there first. Their write has just landed, so the state
    // is fresh again; wait only long enough to not collide with the other
    // losers, and give up only when there is no time left to try properly.
    const wait = Math.min(600, 60 * 2 ** (attempt - 1)) * (0.5 + Math.random());
    if (now() + wait >= deadline) break;
    await sleepFn(wait);
  }
  return fail(409, "busy", "Too many phones wrote at once. Try that again.");
}

/** The host may act for any seat; a player may only act for their own. */
function authorize(game, { hostKey, seatKey, idx }) {
  if (hostKey && hostKey === game.hostKey) return { allowed: true, isHost: true };
  const seat = game.seats.find((s) => s.key && s.key === seatKey);
  if (seat && (idx === undefined || seat.idx === idx)) return { allowed: true, isHost: false, seat };
  return { allowed: false };
}

export async function handleGet(store, { code, etag, hostKey, seatKey }) {
  if (!code) return fail(400, "no_code", "No game code given.");
  code = String(code).toUpperCase();

  // One call. Asking for the tag and then the body was two answers that could
  // disagree, and they did: a current tag beside a body from before the last
  // write, which left the phone believing it was up to date.
  const current = await store.read(code, etag || null);
  if (!current) return fail(404, "no_game", "No game with that code.");
  if (current.unchanged) return ok({ unchanged: true, etag: current.etag });
  return ok({ etag: current.etag, game: publicView(current.data, { hostKey, seatKey }) });
}

export async function handlePost(store, body) {
  const action = body && body.action;
  if (!action) return fail(400, "no_action", "No action given.");
  const code = body.code ? String(body.code).toUpperCase() : null;

  if (action === "create") {
    const seatCount = Math.max(2, Math.min(8, Number(body.seatCount) || 4));
    const roundsAuto = body.rounds === undefined || body.rounds === null || body.rounds === "";
    const rounds = Math.max(1, Math.min(20, Number(body.rounds) || ROUNDS_FOR[seatCount] || 15));
    const hostName = (body.name || "").trim().slice(0, 14) || "Player 1";
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = randomCode();
      const game = newGame({ code: candidate, hostName, seatCount, rounds, roundsAuto, clientId: body.clientId || null });
      const written = await store.write(candidate, game, null);
      if (written.ok) {
        return ok({
          code: candidate,
          hostKey: game.hostKey,
          seatKey: game.seats[0].key,
          seatIdx: 0,
          game: publicView(game, { hostKey: game.hostKey, seatKey: game.seats[0].key }),
        });
      }
    }
    return fail(503, "no_code_free", "Couldn't get a free game code. Try again.");
  }

  if (!code) return fail(400, "no_code", "No game code given.");

  if (action === "join") {
    let joined = null;
    const res = await mutate(store, code, (g) => {
      const out = applyJoin(g, { name: body.name, clientId: body.clientId });
      if (out.error) return out;
      joined = out;
      return {};
    });
    if (res.status !== 200) return res;
    return ok({
      seatIdx: joined.seatIdx,
      seatKey: joined.seatKey,
      game: publicView(res.body.game, { seatKey: joined.seatKey }),
    });
  }

  // Everything below acts on an existing game and needs a key.
  const guard = (fn, opts = {}) =>
    mutate(store, code, (g) => {
      const auth = authorize(g, { hostKey: body.hostKey, seatKey: body.seatKey, idx: opts.idx });
      if (!auth.allowed) return { error: "not_allowed", message: "You're not in this game." };
      if (opts.hostOnly && !auth.isHost) {
        return { error: "host_only", message: "Only the scorekeeper can do that." };
      }
      return fn(g, auth);
    });

  switch (action) {
    case "rename":
      return guard((g) => applyRename(g, { idx: Number(body.idx), name: body.name }), { idx: Number(body.idx) });
    case "start":
      return guard((g) => applyStart(g), { hostOnly: true });
    case "reorder":
      return guard((g) => applyReorder(g, { order: body.order }), { hostOnly: true });
    case "dealerStart":
      return guard((g) => applyDealerStart(g, { idx: Number(body.idx) }), { hostOnly: true });
    case "settings":
      return guard((g) => applySettings(g, { scoring: body.scoring, bidding: body.bidding }), { hostOnly: true });
    case "bid":
      return guard((g) => applyBid(g, { idx: Number(body.idx), value: Number(body.value) }), { idx: Number(body.idx) });
    case "clearBid":
      return guard((g) => applyClearBid(g, { idx: Number(body.idx) }), { idx: Number(body.idx) });
    case "trump":
      return guard((g) => applyTrump(g, { trump: body.trump ?? null }), { hostOnly: true });
    case "toTricks":
      return guard((g) => applyToTricks(g), { hostOnly: true });
    case "backToBids":
      return guard((g) => applyBackToBids(g), { hostOnly: true });
    case "setTrick":
      return guard((g) => applySetTrick(g, { idx: Number(body.idx), value: Number(body.value) }), { hostOnly: true });
    case "score":
      return guard((g) => applyScore(g), { hostOnly: true });
    case "undo":
      return guard((g) => applyUndo(g), { hostOnly: true });
    case "rematch":
      return guard((g) => applyRematch(g), { hostOnly: true });
    default:
      return fail(400, "bad_action", "That isn't something the game can do.");
  }
}

/** Response bodies carry the full game; never let the secrets out with it. */
export function sanitize(body, { hostKey, seatKey }) {
  if (!body || !body.game) return body;
  if (body.game.seats && body.game.seats[0] && "key" in body.game.seats[0]) {
    return { ...body, game: publicView(body.game, { hostKey, seatKey }) };
  }
  return body;
}
