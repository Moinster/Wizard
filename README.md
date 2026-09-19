# Wizard Scorekeeper

Scorekeeping for the trick-taking card game **Wizard**, for a table playing in
the same room — with everyone on their own phone.

One person runs the server, everyone else scans a QR code. Each player
**places their own bid from their own phone**; the scorekeeper sets trump,
closes bidding, counts the tricks and scores the round. Every phone shows every
player's running total, updated the moment a round is scored.

No accounts, no database, no internet. Nothing is stored anywhere: the game
lives in the server's memory and is gone when you stop it.

## Game night

On a laptop on the same Wi-Fi as everyone's phones:

```bash
node server.js
```

That's the whole setup — no `npm install`, no dependencies, nothing to
configure. It prints the addresses to use:

```
  Wizard Scorekeeper

  this computer   http://localhost:3000
  other phones    http://192.168.1.37:3000

  Games live in memory: stopping the server clears them.
```

Open the "other phones" address on the scorekeeper's phone, start a game, and
hold the screen up: everyone else points a camera at the QR code and they're in.
Anyone who'd rather type gets a four-letter code instead.

Pass a port as an argument if 3000 is busy: `node server.js 8080`.

## How a game runs

1. **Start** — the scorekeeper picks the number of seats and rounds, and gets a
   QR code and a four-letter game code.
2. **Join** — everyone scans or types the code and enters a name. Seats fill in
   live on every phone.
3. **Bid** — each player taps their own bid. Bids appear for the whole table as
   they land, the way they do when you call them out loud, and can be changed
   until the scorekeeper closes bidding.
4. **Score** — the scorekeeper enters the tricks taken. A round won't score
   until they total the cards dealt. Totals then update on every phone at once.

The scorekeeper can also enter a bid for someone whose phone died, undo the last
round, and start a rematch with the same table.

**Scoring** is the standard rule: hit your bid exactly for `20 + 10 × bid`, or
lose `10` per trick over or under. Round 1 deals one card each and every round
adds one, until the 60-card deck runs out — 20 rounds for three players, 15 for
four, 12 for five, 10 for six.

## Layout

```
server.js           the server: static files plus the API, state in memory
public/index.html   the whole client: one file, no build step, no framework
public/qr.js        QR encoder (byte mode, level M, versions 1-10)
lib/game.js         Wizard rules and state transitions (pure, no I/O)
lib/handler.js      API actions, permissions, read-modify-write retry loop
lib/store.js        the store, behind a three-call interface
test/run.mjs        server logic, permissions, concurrency
test/qr.mjs         QR conformance against golden fixtures
test/browser.mjs    three real browser contexts playing a game together
```

### Why there's a version tag on every write

Two phones bidding at the same instant are two overlapping requests in one
event loop. Every write reads the game with a version tag, applies its change,
and writes back only if that tag still holds; the loser of a race is rejected
and retried against fresh state, so both bids land. Clients poll with the same
tag, so an idle poll transfers nothing until something actually changes.

`lib/store.js` is the only file that knows where state lives. Swapping the
in-memory map for something durable means implementing `read`, `etag` and
`write` against it — nothing above that file changes.

### Who is allowed to do what

The scorekeeper's device holds a host key; each player's device holds a seat
key. The server checks them on every action: a player can only set their own
bid, and only the scorekeeper can close bidding, enter tricks, score, or undo.
Neither key is ever sent to other players.

These are game-night guardrails, not security. Anyone on your Wi-Fi who knows
the code can join an open seat, and the server has no authentication of its own
— it is meant for a living room, not the open internet.

## Tests

```bash
npm test               # server logic and QR conformance, no dependencies
npm run test:browser   # three browser "phones" playing a game (needs playwright)
```

- **`test/run.mjs`** — 43 checks: the scoring rule, the full round cycle,
  permissions (a player can't start the game, score, or bid for someone else),
  tricks that don't total the cards dealt, undo, end of game, cheap polling, and
  two concurrency races — four phones bidding at once, three joining at once.
- **`test/qr.mjs`** — 95 checks against golden fixtures. Those fixtures were
  generated from output verified module-for-module against the `qrcode` npm
  package across all 8 mask patterns and versions 1–10, including automatic
  mask selection. The fixtures are hashes, so the test needs no dependencies.
- **`test/browser.mjs`** — 20 checks driving three separate browser contexts
  through a real game: joining by deep link, seats filling live, bids crossing
  between phones, scores landing on every phone at once, and a refresh keeping
  your seat. It starts its own server.

Not covered: real iOS/Android devices, and player counts other than three
or four.

## If you ever want it on the internet

The first commit in this repository carries a Vercel deployment path — a
serverless function and a Vercel Blob store behind the same `lib/store.js`
interface — which was removed in favour of running locally. `git show` it if
you want it back; only `lib/store.js` and the entry point differ.
