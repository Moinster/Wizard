// Pure Wizard rules and game-state transitions.
// No I/O here: every function takes state and returns a value or mutates the
// object it was handed. The API layer owns reading, writing and retrying.

/** Rounds dealt when the whole 60-card deck is used up. */
export const ROUNDS_FOR = { 3: 20, 4: 15, 5: 12, 6: 10, 7: 8, 8: 7 };

export const TRUMPS = ["S", "H", "D", "C", "N"];

/** Round n deals n cards to each player. */
export const cardsFor = (round) => round;

/**
 * Wizard scoring: hit the bid exactly for 20 plus 10 a trick; miss it and
 * lose 10 for every trick over or under.
 */
export function scoreFor(bid, taken) {
  return bid === taken ? 20 + 10 * bid : -10 * Math.abs(bid - taken);
}

export function totalsFrom(history, seatCount) {
  const totals = new Array(seatCount).fill(0);
  for (const r of history) {
    for (let i = 0; i < seatCount; i++) {
      const b = r.bids[i], k = r.tricks[i];
      if (typeof b === "number" && typeof k === "number") totals[i] += scoreFor(b, k);
    }
  }
  return totals;
}

/** The deal moves one seat left each round. */
export const dealerFor = (round, seatCount) => (round - 1) % seatCount;

/** Bidding starts to the dealer's left; the dealer bids last. */
export function bidOrder(round, seatCount) {
  const start = (dealerFor(round, seatCount) + 1) % seatCount;
  return Array.from({ length: seatCount }, (_, i) => (start + i) % seatCount);
}

export function standings(game) {
  const totals = totalsFrom(game.history, game.seats.length);
  const rows = game.seats.map((s, i) => ({ idx: i, name: s.name, total: totals[i] }));
  rows.sort((a, b) => b.total - a.total);
  let rank = 0, seen = null;
  rows.forEach((r, i) => {
    if (r.total !== seen) { rank = i + 1; seen = r.total; }
    r.rank = rank;
  });
  return rows;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1

export function randomCode(len = 4) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

export function randomKey() {
  let out = "";
  for (let i = 0; i < 32; i++) out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return out;
}

export function newGame({ code, hostName, seatCount, rounds, roundsAuto = true }) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    idx: i,
    name: i === 0 ? hostName : "",
    key: i === 0 ? randomKey() : null,
    joined: i === 0,
  }));
  return {
    code,
    v: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "lobby",
    rounds,
    roundsAuto,
    hostKey: randomKey(),
    seats,
    round: 1,
    phase: "bid",
    trump: null,
    bids: {},
    tricks: {},
    history: [],
  };
}

/** Strip every secret before a game goes over the wire. */
export function publicView(game, { hostKey, seatKey } = {}) {
  const isHost = Boolean(hostKey) && hostKey === game.hostKey;
  let youIdx = null;
  if (seatKey) {
    const seat = game.seats.find((s) => s.key && s.key === seatKey);
    if (seat) youIdx = seat.idx;
  }
  return {
    code: game.code,
    v: game.v,
    status: game.status,
    rounds: game.rounds,
    round: game.round,
    cards: cardsFor(game.round),
    phase: game.phase,
    trump: game.trump,
    seats: game.seats.map((s) => ({ idx: s.idx, name: s.name, joined: s.joined })),
    bids: game.bids,
    tricks: game.tricks,
    history: game.history,
    totals: totalsFrom(game.history, game.seats.length),
    dealer: dealerFor(game.round, game.seats.length),
    order: bidOrder(game.round, game.seats.length),
    isHost,
    youIdx,
  };
}

// ---------------------------------------------------------------------------
// Transitions. Each returns {error} to reject, or nothing to accept the
// mutation it made to `g`.
// ---------------------------------------------------------------------------

export function applyJoin(g, { name }) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };
  const seat = g.seats.find((s) => !s.joined);
  if (!seat) return { error: "full", message: "Every seat is taken." };
  seat.joined = true;
  seat.name = (name || "").trim().slice(0, 14) || `Player ${seat.idx + 1}`;
  seat.key = randomKey();
  return { seatIdx: seat.idx, seatKey: seat.key };
}

export function applyRename(g, { idx, name }) {
  const seat = g.seats[idx];
  if (!seat) return { error: "no_seat", message: "That seat doesn't exist." };
  seat.name = (name || "").trim().slice(0, 14) || `Player ${idx + 1}`;
}

export function applyStart(g) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };
  const joined = g.seats.filter((s) => s.joined).length;
  if (joined < 2) return { error: "too_few", message: "At least two players have to join first." };
  // Drop seats nobody claimed so the deal and the scoreboard match the table.
  g.seats = g.seats.filter((s) => s.joined).map((s, i) => ({ ...s, idx: i }));
  // Re-derive the deal only when the host never named a round count of their
  // own -- dropping an empty seat shouldn't silently rewrite their choice.
  if (g.roundsAuto && ROUNDS_FOR[g.seats.length]) g.rounds = ROUNDS_FOR[g.seats.length];
  g.rounds = Math.max(1, Math.min(20, g.rounds));
  g.status = "playing";
  g.round = 1;
  g.phase = "bid";
  g.bids = {};
  g.tricks = {};
}

export function applyBid(g, { idx, value }) {
  if (g.status !== "playing") return { error: "not_playing", message: "The game isn't running." };
  if (g.phase !== "bid") return { error: "wrong_phase", message: "Bidding for this round is closed." };
  const cards = cardsFor(g.round);
  if (!Number.isInteger(value) || value < 0 || value > cards) {
    return { error: "bad_bid", message: `A bid has to be between 0 and ${cards}.` };
  }
  g.bids[idx] = value;
}

export function applyClearBid(g, { idx }) {
  if (g.phase !== "bid") return { error: "wrong_phase", message: "Bidding for this round is closed." };
  delete g.bids[idx];
}

export function applyTrump(g, { trump }) {
  if (trump !== null && !TRUMPS.includes(trump)) return { error: "bad_trump", message: "That isn't a suit." };
  g.trump = trump;
}

export function applyToTricks(g) {
  if (g.phase !== "bid") return { error: "wrong_phase", message: "Bidding for this round is closed." };
  if (Object.keys(g.bids).length !== g.seats.length) {
    return { error: "bids_missing", message: "Every player has to bid first." };
  }
  g.phase = "tricks";
}

export function applyBackToBids(g) {
  g.phase = "bid";
  g.tricks = {};
}

export function applySetTrick(g, { idx, value }) {
  if (g.phase !== "tricks") return { error: "wrong_phase", message: "Bids aren't all in yet." };
  const cards = cardsFor(g.round);
  if (!Number.isInteger(value) || value < 0 || value > cards) {
    return { error: "bad_tricks", message: `Tricks taken has to be between 0 and ${cards}.` };
  }
  g.tricks[idx] = value;
}

export function applyScore(g) {
  if (g.status !== "playing") return { error: "not_playing", message: "The game isn't running." };
  if (g.phase !== "tricks") return { error: "wrong_phase", message: "Bids aren't all in yet." };
  const cards = cardsFor(g.round);
  const entered = Object.keys(g.tricks).length;
  if (entered !== g.seats.length) return { error: "tricks_missing", message: "Enter tricks taken for every player." };
  const sum = Object.values(g.tricks).reduce((a, b) => a + b, 0);
  if (sum !== cards) {
    return { error: "tricks_sum", message: `Tricks taken add up to ${sum}, but ${cards} were dealt.` };
  }
  g.history.push({
    round: g.round,
    cards,
    trump: g.trump,
    bids: { ...g.bids },
    tricks: { ...g.tricks },
  });
  g.bids = {};
  g.tricks = {};
  g.trump = null;
  if (g.history.length >= g.rounds) {
    g.status = "done";
  } else {
    g.round += 1;
    g.phase = "bid";
  }
}

export function applyUndo(g) {
  if (!g.history.length) return { error: "nothing_to_undo", message: "No round has been scored yet." };
  const last = g.history.pop();
  g.status = "playing";
  g.round = last.round;
  g.phase = "tricks";
  g.trump = last.trump;
  g.bids = { ...last.bids };
  g.tricks = { ...last.tricks };
}

export function applyRematch(g) {
  g.status = "playing";
  g.round = 1;
  g.phase = "bid";
  g.trump = null;
  g.bids = {};
  g.tricks = {};
  g.history = [];
}
