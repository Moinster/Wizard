// Pure Wizard rules and game-state transitions.
// No I/O here: every function takes state and returns a value or mutates the
// object it was handed. The API layer owns reading, writing and retrying.

/** Rounds dealt when the whole 60-card deck is used up. */
export const ROUNDS_FOR = { 3: 20, 4: 15, 5: 12, 6: 10, 7: 8, 8: 7 };

export const TRUMPS = ["S", "H", "D", "C", "N"];

/**
 * House rules. Each carries the text the page shows beside it, so the server
 * and the page can never disagree about what an option means.
 */
export const SCORING_VARIANTS = [
  {
    key: "standard",
    name: "Standard",
    blurb: "Hit your bid exactly for 20 plus 10 a trick. Miss it and lose 10 for every trick over or under.",
  },
  {
    key: "zeroScales",
    name: "Zero pays the round",
    blurb: "As standard, except a successful bid of zero pays 10 per card dealt instead of a flat 20 \u2014 so passing in round 8 is worth 80. Bidding nothing gets harder to do and better to pull off as the hands grow.",
  },
  {
    key: "noNegative",
    name: "No minus scores",
    blurb: "Making your bid pays as standard, but missing it scores nothing at all rather than going negative. Gentler, and it keeps anyone from falling out of the game early.",
  },
];

export const BIDDING_VARIANTS = [
  {
    key: "turn",
    name: "In turn",
    inTurn: true,
    blurb: "Bids go round the table one at a time, starting to the dealer\u2019s left, and everyone sees each one as it lands. The dealer bids last and knows the whole table. Only the player whose turn it is can bid.",
  },
  {
    key: "screwDealer",
    name: "In turn, screw the dealer",
    inTurn: true,
    blurb: "As in turn, except the dealer may not make the bids add up to the number of tricks. Somebody is always going to miss, and the dealer is stuck choosing who.",
  },
  {
    key: "open",
    name: "All at once",
    inTurn: false,
    blurb: "Everyone bids whenever they like and every bid shows as it lands. Quicker, and nobody has to wait their turn.",
  },
  {
    key: "blind",
    name: "All at once, blind",
    inTurn: false,
    blurb: "Everybody bids at once and nobody sees another bid until the last one is in. No reading the table \u2014 and the totals can land anywhere.",
  },
];

/** Whether a bidding rule makes players wait their turn. */
export const biddingInTurn = (bidding) =>
  Boolean((BIDDING_VARIANTS.find((v) => v.key === bidding) || {}).inTurn);

export const DEFAULT_SETTINGS = { scoring: "standard", bidding: "turn" };

const scoringKeys = SCORING_VARIANTS.map((v) => v.key);
const biddingKeys = BIDDING_VARIANTS.map((v) => v.key);

/** Round n deals n cards to each player. */
export const cardsFor = (round) => round;

/**
 * Wizard scoring. `cards` is how many were dealt that round, which only the
 * "zero pays the round" variant cares about.
 */
export function scoreFor(bid, taken, { scoring = "standard", cards = 0 } = {}) {
  if (bid === taken) {
    if (scoring === "zeroScales" && bid === 0) return 10 * cards;
    return 20 + 10 * bid;
  }
  return scoring === "noNegative" ? 0 : -10 * Math.abs(bid - taken);
}

export function totalsFrom(history, seatCount, settings = DEFAULT_SETTINGS) {
  const totals = new Array(seatCount).fill(0);
  for (const r of history) {
    for (let i = 0; i < seatCount; i++) {
      const b = r.bids[i], k = r.tricks[i];
      if (typeof b === "number" && typeof k === "number") {
        totals[i] += scoreFor(b, k, { scoring: settings.scoring, cards: r.cards });
      }
    }
  }
  return totals;
}

/** The deal starts wherever the table put it and moves one seat left a round. */
export const dealerFor = (round, seatCount, dealerStart = 0) =>
  (dealerStart + round - 1) % seatCount;

/** Bidding starts to the dealer's left; the dealer bids last. */
export function bidOrder(round, seatCount, dealerStart = 0) {
  const start = (dealerFor(round, seatCount, dealerStart) + 1) % seatCount;
  return Array.from({ length: seatCount }, (_, i) => (start + i) % seatCount);
}

/**
 * Under in-turn bidding, the seat whose bid is due: the first in bid order
 * without one. Null once every bid is in, or when bids need no turn.
 */
export function nextToBid(g) {
  if (!biddingInTurn(g.settings.bidding)) return null;
  const order = bidOrder(g.round, g.seats.length, g.dealerStart);
  const due = order.find((idx) => typeof g.bids[idx] !== "number");
  return due === undefined ? null : due;
}

export function standings(game) {
  const totals = totalsFrom(game.history, game.seats.length, game.settings);
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

export function newGame({ code, hostName, seatCount, rounds, roundsAuto = true, clientId = null }) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    idx: i,
    name: i === 0 ? hostName : "",
    key: i === 0 ? randomKey() : null,
    joined: i === 0,
    clientId: i === 0 ? clientId : null,
  }));
  return {
    code,
    v: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "lobby",
    rounds,
    roundsAuto,
    settings: { ...DEFAULT_SETTINGS },
    dealerStart: 0,
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
    bids: visibleBids(game, youIdx),
    // Who has bid, which stays true even when the values are hidden.
    bidPlaced: Object.keys(game.bids).map(Number),
    tricks: game.tricks,
    history: game.history,
    totals: totalsFrom(game.history, game.seats.length, game.settings),
    dealer: dealerFor(game.round, game.seats.length, game.dealerStart),
    order: bidOrder(game.round, game.seats.length, game.dealerStart),
    settings: game.settings,
    dealerStart: game.dealerStart,
    inTurn: biddingInTurn(game.settings.bidding),
    nextToBid: game.status === "playing" && game.phase === "bid" ? nextToBid(game) : null,
    isHost,
    youIdx,
  };
}

/**
 * Blind bidding has to be enforced here, not in the page: a value merely
 * hidden by the client is still sitting in the JSON for anyone who looks.
 * Once every bid is in, or once the round moves on to tricks, they all show.
 */
function visibleBids(game, youIdx) {
  const hidden =
    game.settings.bidding === "blind" &&
    game.phase === "bid" &&
    Object.keys(game.bids).length !== game.seats.length;
  if (!hidden) return { ...game.bids };
  return youIdx !== null && typeof game.bids[youIdx] === "number"
    ? { [youIdx]: game.bids[youIdx] }
    : {};
}

// ---------------------------------------------------------------------------
// Transitions. Each returns {error} to reject, or nothing to accept the
// mutation it made to `g`.
// ---------------------------------------------------------------------------

export function applyJoin(g, { name, clientId }) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };

  // Joining has to be idempotent per device. A slow first tap invites a second
  // one, and a lost response invites a retry; either way a device that already
  // holds a seat gets that seat back rather than burning another and leaving a
  // real player locked out of a table that looks full.
  if (clientId) {
    const mine = g.seats.find((s) => s.joined && s.clientId === clientId);
    if (mine) {
      const typed = (name || "").trim().slice(0, 14);
      if (typed) mine.name = typed;
      return { seatIdx: mine.idx, seatKey: mine.key, rejoined: true };
    }
  }

  const seat = g.seats.find((s) => !s.joined);
  if (!seat) return { error: "full", message: "Every seat is taken." };
  seat.joined = true;
  seat.name = (name || "").trim().slice(0, 14) || `Player ${seat.idx + 1}`;
  seat.key = randomKey();
  seat.clientId = clientId || null;
  return { seatIdx: seat.idx, seatKey: seat.key };
}

export function applyRename(g, { idx, name }) {
  const seat = g.seats[idx];
  if (!seat) return { error: "no_seat", message: "That seat doesn't exist." };
  seat.name = (name || "").trim().slice(0, 14) || `Player ${idx + 1}`;
}

/** Rearrange the table. Seats carry their keys with them as they move. */
export function applyReorder(g, { order }) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };
  const joined = g.seats.filter((s) => s.joined).map((s) => s.idx);
  const ok =
    Array.isArray(order) &&
    order.length === joined.length &&
    new Set(order).size === order.length &&
    order.every((i) => joined.includes(i));
  if (!ok) return { error: "bad_order", message: "That isn't a seating for this table." };

  const empties = g.seats.filter((s) => !s.joined);
  const moved = order.map((oldIdx) => g.seats[oldIdx]);
  // The dealer is a person, not a position, so follow them to their new seat.
  const dealerAt = order.indexOf(g.dealerStart);
  g.seats = [...moved, ...empties].map((s, i) => ({ ...s, idx: i }));
  g.dealerStart = dealerAt === -1 ? 0 : dealerAt;
}

/** Choose who deals the first round; it moves one seat left after that. */
export function applyDealerStart(g, { idx }) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };
  const seat = g.seats[idx];
  if (!seat || !seat.joined) return { error: "no_seat", message: "Nobody is sitting there." };
  g.dealerStart = idx;
}

/** House rules, fixed before the deal so a game cannot change how it scores. */
export function applySettings(g, { scoring, bidding }) {
  if (g.status !== "lobby") return { error: "already_started", message: "House rules are set before the deal." };
  if (scoring !== undefined) {
    if (!scoringKeys.includes(scoring)) return { error: "bad_scoring", message: "That isn't a scoring rule." };
    g.settings.scoring = scoring;
  }
  if (bidding !== undefined) {
    if (!biddingKeys.includes(bidding)) return { error: "bad_bidding", message: "That isn't a bidding rule." };
    g.settings.bidding = bidding;
  }
}

export function applyStart(g) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };
  const joined = g.seats.filter((s) => s.joined).length;
  if (joined < 2) return { error: "too_few", message: "At least two players have to join first." };
  // Drop seats nobody claimed so the deal and the scoreboard match the table.
  // Dropping the empty seats renumbers the rest, so the chosen first dealer
  // has to be found again by who they are rather than where they sat.
  const kept = g.seats.filter((s) => s.joined);
  const movedDealer = kept.findIndex((s) => s.idx === g.dealerStart);
  g.seats = kept.map((s, i) => ({ ...s, idx: i }));
  g.dealerStart = movedDealer === -1 ? 0 : movedDealer;
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

/**
 * A phone declares a bid once, deliberately, so a submit carries the round it
 * was meant for. A retry that lands after the round has moved on is refused
 * rather than becoming a bid for the wrong hand.
 */
function wrongRound(g, round) {
  if (round === undefined || round === null) return null;
  if (Number(round) === g.round) return null;
  return { error: "stale_round", message: `That was for round ${round}; the table is on round ${g.round}.` };
}

export function applyBid(g, { idx, value, round }) {
  if (g.status !== "playing") return { error: "not_playing", message: "The game isn't running." };
  if (g.phase !== "bid") return { error: "wrong_phase", message: "Bidding for this round is closed." };
  const stale = wrongRound(g, round);
  if (stale) return stale;
  const cards = cardsFor(g.round);
  if (!Number.isInteger(value) || value < 0 || value > cards) {
    return { error: "bad_bid", message: `A bid has to be between 0 and ${cards}.` };
  }

  // In turn: only the seat whose bid is due may bid. Changing a bid already
  // made is allowed only for whoever bid last, so the order never has a hole
  // in it. Enforced here, not in the page, because a phone's view can lag.
  if (biddingInTurn(g.settings.bidding)) {
    const due = nextToBid(g);
    const order = bidOrder(g.round, g.seats.length, g.dealerStart);
    const placed = order.filter((i) => typeof g.bids[i] === "number");
    const last = placed.length ? placed[placed.length - 1] : null;
    if (idx !== due && idx !== last) {
      const who = due === null ? null : g.seats[due];
      return {
        error: "not_your_turn",
        message: who ? `It's ${who.name}'s turn to bid.` : "Every bid is already in.",
      };
    }
  }

  // Screw the dealer: once everyone else has bid, the dealer may not make the
  // bids add up to the tricks available.
  if (g.settings.bidding === "screwDealer") {
    const dealer = dealerFor(g.round, g.seats.length, g.dealerStart);
    const othersIn = g.seats.every((s) => s.idx === dealer || typeof g.bids[s.idx] === "number");
    if (idx === dealer && othersIn) {
      const total = g.seats.reduce(
        (sum, s) => sum + (s.idx === dealer ? value : g.bids[s.idx]), 0);
      if (total === cards) {
        return {
          error: "hooked",
          message: `That would make the bids add up to ${cards}. The dealer has to leave it uneven.`,
        };
      }
    }
  }

  g.bids[idx] = value;
}

export function applyClearBid(g, { idx }) {
  if (g.phase !== "bid") return { error: "wrong_phase", message: "Bidding for this round is closed." };
  if (biddingInTurn(g.settings.bidding)) {
    const order = bidOrder(g.round, g.seats.length, g.dealerStart);
    const placed = order.filter((i) => typeof g.bids[i] === "number");
    if (placed.length && placed[placed.length - 1] !== idx) {
      return { error: "not_your_turn", message: "Only the last bid can be taken back." };
    }
  }
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

/**
 * The scorekeeper enters every seat's tricks, checks the total, and submits
 * once. One write scores the round, and the checks that used to fire only on
 * the final tap now fire on the whole form -- a wrong total is refused before
 * it can become a wrong score.
 */
export function applyScoreRound(g, { tricks, round }) {
  if (g.status !== "playing") return { error: "not_playing", message: "The game isn't running." };
  if (g.phase !== "tricks") return { error: "wrong_phase", message: "Bids aren't all in yet." };
  const stale = wrongRound(g, round);
  if (stale) return stale;
  const cards = cardsFor(g.round);
  const entered = {};
  for (const s of g.seats) {
    const v = tricks && tricks[s.idx];
    if (!Number.isInteger(v) || v < 0 || v > cards) {
      return { error: "tricks_missing", message: `Enter tricks taken for ${s.name} (0 to ${cards}).` };
    }
    entered[s.idx] = v;
  }
  const sum = Object.values(entered).reduce((a, b) => a + b, 0);
  if (sum !== cards) {
    return { error: "tricks_sum", message: `Tricks taken add up to ${sum}, but ${cards} were dealt.` };
  }
  g.tricks = entered;
  return applyScore(g);
}

/**
 * The host arranges the table and saves it in one go: order, first dealer and
 * house rules together, rather than a write for every nudge of a row.
 */
export function applySeating(g, { order, dealerStart, scoring, bidding }) {
  if (g.status !== "lobby") return { error: "already_started", message: "That game has already started." };
  if (order !== undefined) {
    const out = applyReorder(g, { order });
    if (out && out.error) return out;
  }
  if (dealerStart !== undefined && dealerStart !== null) {
    // After a reorder the dealer is named by their NEW position, which is what
    // the page shows and the host tapped.
    const out = applyDealerStart(g, { idx: Number(dealerStart) });
    if (out && out.error) return out;
  }
  if (scoring !== undefined || bidding !== undefined) {
    const out = applySettings(g, { scoring, bidding });
    if (out && out.error) return out;
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
