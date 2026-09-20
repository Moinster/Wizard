# Wizard Scorekeeper

Scorekeeping for the trick-taking card game **Wizard**.

It runs two ways off the same code, and works out which one it's in by itself:

| | How to run it | What you get |
|---|---|---|
| **One device** | Open the [web page](https://moinster.github.io/Wizard/) | The scorekeeper's phone takes every bid and every trick. Nothing leaves the device. |
| **Every phone** | `node server.js` on the Wi-Fi | Each player bids from their own phone; everyone sees every score update live. |

No accounts, no database, no sign-up either way.

## One device — the web page

<https://moinster.github.io/Wizard/>

Name the table, then take the bids and the tricks round by round. The game is
kept in the browser's own storage, so closing the tab doesn't lose it, and
nothing is ever sent anywhere. This is all a static host can do — there's no
server behind that URL to pass bids between phones.

## Every phone — a server on your Wi-Fi

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

### How a game runs

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

**Scoring** defaults to the standard rule: hit your bid exactly for
`20 + 10 × bid`, or lose `10` per trick over or under. Round 1 deals one card
each and every round adds one, until the 60-card deck runs out — 20 rounds for
three players, 15 for four, 12 for five, 10 for six.

### Before the deal

The scorekeeper sets three things in the lobby, and they hold for the whole game:

- **The seating.** Arrange the list into the order everyone is sitting,
  clockwise. Play and the deal both follow it.
- **Who deals first.** The deal moves one seat down the list each round after
  that, and bidding always begins to the dealer's left — so the dealer bids last.
- **House rules**, below. Each option explains itself as you tap it, and the
  full text is under **Rules**.

| Scoring | |
|---|---|
| **Standard** | Hit your bid exactly for 20 plus 10 a trick. Miss it and lose 10 for every trick over or under. |
| **Zero pays the round** | A successful bid of zero pays 10 per card dealt instead of a flat 20 — passing in round 8 is worth 80. |
| **No minus scores** | Making your bid pays as standard, but missing scores nothing rather than going negative. |

| Bidding | |
|---|---|
| **Open bidding** | Bids called in turn from the dealer's left, visible as they land. The dealer bids last. |
| **Screw the dealer** | Open, except the dealer may not make the bids add up to the tricks available. |
| **Blind bidding** | Everybody bids at once and nobody sees a bid until the last one is in. |

Blind bidding is enforced on the server: a hidden bid is not in the payload at
all, so it cannot be read out of the page.

## Layout

```
server.js               the server: static files plus the API, state in memory
public/index.html       markup and styles
public/app.js           the client
public/qr.js            QR encoder (byte mode, level M, versions 1-10)
public/lib/game.js      Wizard rules and state transitions (pure, no I/O)
public/lib/handler.js   API actions, permissions, read-modify-write retry loop
public/lib/store.js     the store, behind a three-call interface
.github/workflows/      tests, then publish public/ to Pages
```

Everything the browser needs lives under `public/`, which is exactly what gets
published to Pages. The server imports the same `lib/` files the browser does.

### One codebase, two modes

On load the client asks for `/api/health`. A reply means there's a server, so
bids and scores go through it. A 404 means it's on a static host, so it loads
`lib/handler.js` and `lib/store.js` into the page and runs the same game logic
against the browser's own storage. Identical rules, identical scoring, identical
validation — the only difference is where the state lives and how many devices
can see it.

### Why there's a version tag on every write

Two phones bidding at the same instant are two overlapping requests in one
event loop. Every write reads the game with a version tag, applies its change,
and writes back only if that tag still holds; the loser of a race is rejected
and retried against fresh state, so both bids land. Clients poll with the same
tag, so an idle poll transfers nothing until something actually changes.

`lib/store.js` is the only file that knows where state lives. Swapping in
something durable means implementing `read`, `etag` and `write` against it.

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
npm test               # game logic and QR conformance, no dependencies
npm run test:browser   # real browsers, both modes (needs playwright)
```

- **`test/run.mjs`** — 43 checks: the scoring rule, the full round cycle,
  permissions (a player can't start the game, score, or bid for someone else),
  tricks that don't total the cards dealt, undo, end of game, cheap polling, and
  two concurrency races — four phones bidding at once, three joining at once.
- **`test/qr.mjs`** — 95 checks against golden fixtures. Those fixtures came
  from output verified module-for-module against the `qrcode` npm package across
  all 8 mask patterns and versions 1–10, including automatic mask selection. The
  fixtures are hashes, so the test needs no dependencies.
- **`test/lobby.mjs`** — 16 checks over the pre-deal controls: reordering the
  table, the dealer badge following the person rather than the row, the rules
  reaching every phone, players being unable to change them, and a blind bid
  staying out of the payload.
- **`test/latency.mjs`** — reproduces a reported flicker by delaying the API
  write in the browser, then asserts a tap is drawn at once and never reverts.
- **`test/browser.mjs`** — 20 checks driving three separate browser contexts
  through a real game on a running server: joining by link, seats filling live,
  bids crossing between phones, scores landing everywhere at once, and a refresh
  keeping your seat.
- **`test/static.mjs`** — 13 checks against a static host with no API, mounted
  under a project subpath the way Pages serves it: the fallback screen, a full
  round scored with no server, no broken asset paths, and a reload keeping the
  game.

CI runs the dependency-free tests on every push and pull request — they need
no `npm install` — and publishes `public/` to Pages when `main` passes. The
browser tests need Playwright and are run locally.

Not covered: real iOS/Android devices, and player counts other than three
or four.

## Deploying to Vercel

Vercel runs the API as serverless functions. Each request is a fresh, stateless
invocation, so a game **cannot** live in process memory the way it does under
`server.js` — Vercel needs a Blob store to hold games instead. That is the only
real difference; the rules, scoring and validation are the same files.

```
api/game.js             serverless function: the HTTP skin over lib/handler.js
api/health.js           the probe that tells the client a backend exists
vercel.json             serves public/ statically, redirects the old /g/CODE form
public/lib/store.js     gains blobStore(), behind the same three-call interface
```

1. **Import the repository** in Vercel — no framework preset, and nothing to
   configure. `vercel.json` already points the static site at `public/`.
2. **Add a Blob store** — in the project, **Storage → Create → Blob**, and
   connect it to this project. That injects `BLOB_READ_WRITE_TOKEN`
   automatically; there is nothing else to set.
3. **Redeploy** so the functions pick the token up.

Without a Blob store connected, `/api/game` returns a clear error saying so
rather than failing in some confusing way.

### Two things worth knowing

- **`api/health.js` is load-bearing.** The client decides between multi-phone
  and one-device mode by probing `/api/health`. If that endpoint is missing or
  failing, a perfectly good deployment will quietly serve the solo version.
- **Every phone polls about once a second while a game is running.** On Vercel
  that is a function invocation and a Blob metadata read each time, so a long
  game with five players is tens of thousands of invocations. Fine for a hobby
  project; worth knowing before it surprises you on a bill.

Games are stored one JSON blob per game at `games/<CODE>.json`. Blobs are
public-read but only reachable through the API, and the four-letter code is the
only handle — fine for a card game score sheet, not a secret store. Finished
games can be cleared from the Blob dashboard whenever.

If you would rather not run a database at all, `server.js` on any host that runs
a Node process needs none of this — see the sections above.
