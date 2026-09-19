# Wizard Scorekeeper

Scorekeeping for the trick-taking card game **Wizard**, for a table playing in
the same room — with everyone on their own phone.

One person starts a game and reads out a four-letter code. Everyone else opens
the link, takes a seat, and **places their own bid from their own phone**. The
scorekeeper sets trump, closes bidding, counts the tricks and scores the round.
Every phone shows every player's running total, updated the moment a round is
scored.

No accounts and no sign-in: anyone with the link and the code can play.

## How a game runs

1. **Start** — the scorekeeper picks the number of seats and rounds, and gets a
   game code plus a share link.
2. **Join** — everyone opens the link (or types the code) and enters a name.
   Seats fill in live on every phone.
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
public/index.html   the whole client: one file, no build step, no framework
api/game.js         Vercel serverless function — HTTP skin over lib/handler.js
lib/game.js         Wizard rules and state transitions (pure, no I/O)
lib/handler.js      API actions, permissions, read-modify-write retry loop
lib/store.js        storage behind a 3-call interface (Vercel Blob, or memory)
test/run.mjs        server tests against the in-memory store
test/browser.mjs    three real browser contexts playing a game together
test/dev-server.mjs local server: static files + the same API, in memory
```

### How concurrent phones stay correct

Every write reads the game with a version tag, applies its change, and writes
back **only if that tag still holds** (`ifMatch` on Vercel Blob). A write that
lost the race is rejected and retried against fresh state, so four players
bidding at the same instant all land. Clients poll with the same tag, so a
steady-state poll costs one metadata lookup and transfers nothing until
something actually changes.

The scorekeeper's device holds a host key; each player's device holds a seat
key. The server checks them: a player can only set their own bid, and only the
scorekeeper can close bidding, enter tricks, score, or undo. Neither key is ever
sent back to other players.

## Running it locally

```bash
npm install
npm run dev            # http://localhost:3000, in-memory store
npm test               # server logic, permissions, concurrency
npm run test:browser   # three browser "phones" playing a game (needs playwright)
```

The dev server keeps games in memory, so restarting it clears them. No Blob
store or token is needed to develop.

## Deploying to Vercel

The app needs a Blob store for shared game state.

1. Create the project — in the Vercel dashboard, **Add New → Project**, and
   import this repository. No framework preset; leave the build settings alone
   (there's no build step).
2. Add storage — in the project, **Storage → Create → Blob**, and connect it to
   this project. That injects `BLOB_READ_WRITE_TOKEN` automatically; nothing
   else needs configuring.
3. Redeploy so the function picks the token up.

Without a Blob store connected, the API returns a clear error rather than
failing silently.

From a terminal instead:

```bash
npm i -g vercel
vercel link
vercel deploy --prod
```

### Storage notes

Game state lives in one JSON blob per game at `games/<CODE>.json`. Blobs are
public-read but the path is only reachable through the API, and the four-letter
code is the only handle — fine for a card game score sheet, not a secret store.
Finished games are small and can be cleared from the Blob dashboard whenever.

If the Blob SDK in use doesn't report an etag, conditional writes degrade to
last-writer-wins. The worst case is a bid that has to be tapped again; the game
can't be corrupted by it.

## Testing status

- `npm test` — 43 checks: the scoring rule, the full round cycle, permissions
  (a player can't start the game, score, or bid for someone else), tricks that
  don't total the cards dealt, undo, end of game, cheap polling, and two
  concurrency races (four phones bidding at once, three joining at once).
- `npm run test:browser` — 20 checks driving three separate browser contexts
  through a real game: joining by deep link, seats filling live, bids crossing
  between phones, scores landing on every phone at once, and a refresh keeping
  your seat.

Not covered: real iOS/Android devices, and the Vercel Blob calls themselves —
those run against the in-memory store here, which implements the same contract.
