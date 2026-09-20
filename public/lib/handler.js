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
 */
async function mutate(store, code, fn, tries = 5) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const current = await store.read(code);
    if (!current) return fail(404, "no_game", "No game with that code.");
    const next = clone(current.data);
    const out = fn(next) || {};
    if (out.error) return fail(400, out.error, out.message);
    next.v = (next.v || 0) + 1;
    next.updatedAt = Date.now();
    const written = await store.write(code, next, current.etag);
    if (written.ok) return { status: 200, body: { ...out, game: next } };
    await sleep(30 + Math.random() * 90);
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

  // The cheap path: ask only for the version tag, and say nothing changed.
  if (etag) {
    const live = await store.etag(code);
    if (live && live === etag) return { status: 200, body: { unchanged: true, etag: live } };
  }
  const current = await store.read(code);
  if (!current) return fail(404, "no_game", "No game with that code.");
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
