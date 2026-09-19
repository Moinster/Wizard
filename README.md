# Wizard Scorekeeper

Scorekeeping for the trick-taking card game **Wizard**.

It runs two ways off the same code, and works out which one it's in by itself:

| | How to run it | What you get |
|---|---|---|
| **One device** | Open the [web page](https://moinster.github.io/Wizard/) | The scorekeeper's phone takes every bid and every trick. Nothing leaves the device. |
| **Every phone** | `node server.js`, on your Wi-Fi or on a host | Each player bids from their own phone; everyone sees every score update live. |

No accounts, no database, no sign-up either way.

**The GitHub Pages link is always the one-device version.** Pages serves files;
it cannot run a process, so there is no server behind that URL to pass bids
between phones. Multi-phone needs `server.js` running somewhere — a laptop on
your Wi-Fi, or a host (see [Putting it on the internet](#putting-it-on-the-internet)).

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

### Putting it on the internet

To play with people who aren't on your Wi-Fi, run the same server on anything
that runs a Node process. There is nothing to configure: no database, no
environment variables, no build step.

`render.yaml` is a ready-made blueprint — point Render at this repository and it
picks it up. Any equivalent host works the same way; the only thing a platform
has to do is set `PORT`, which the server reads.

Two things to know before you rely on it:

- **Games live in the process's memory.** If the host restarts or redeploys
  mid-game, the game is gone. A game in progress keeps the process awake by
  itself, because every phone polls about once a second.
- **A free tier that sleeps when idle** will take a while to wake on the first
  request of the evening. Start the game a minute before you deal.

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

**Scoring** is the standard rule: hit your bid exactly for `20 + 10 × bid`, or
lose `10` per trick over or under. Round 1 deals one card each and every round
adds one, until the 60-card deck runs out — 20 rounds for three players, 15 for
four, 12 for five, 10 for six.

## Layout

```
server.js               the server: static files plus the API, state in memory
render.yaml             deploy blueprint for a host that runs a Node process
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
