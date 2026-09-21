// Drives three independent browser contexts -- a scorekeeper and two players --
// through a real game against the dev server. Each context has its own
// localStorage, so these are three separate "phones".
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3111;
const BASE = process.env.BASE || `http://localhost:${PORT}`;

// Run a server of our own so the test is self-contained.
const server = spawn(process.execPath, ['server.js', String(PORT)], { stdio: 'ignore' });
const stopServer = () => { try { server.kill(); } catch {} };
process.on('exit', stopServer);
for (let i = 0; i < 50; i++) {
  try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let pass = 0; const fails = [];
const check = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

const b = await chromium.launch({ executablePath: EXEC });
const phone = async (name) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => fails.push(`FAIL js error on ${name}: ${e.message}`));
  return pg;
};
const tiles = (pg) => pg.$$eval('[data-score-for]', (e) => e.map((n) => +n.dataset.value));
const names = (pg) => pg.$$eval('.tile-name', (e) => e.map((n) => n.textContent.trim()));

// ---- host starts a game ----
const host = await phone('host');
await host.goto(BASE);
await host.fill('#host-name', 'Mira');
await host.click('#s-minus');                 // 4 -> 3 seats
await host.click('#do-create');
await host.waitForSelector('.code-hero .code');
const code = (await host.textContent('.code-hero .code')).trim();
check('room code is 4 chars', code.length, 4);
check('host sees 1 of 3 seats filled', (await host.textContent('.panel-title >> nth=0')).includes('1 of 3'), true);

// ---- two players join from the shared link ----
const p2 = await phone('p2');
await p2.goto(`${BASE}/g/${code}`);
await p2.waitForSelector('#join-code');
check('deep link prefills the code', await p2.inputValue('#join-code'), code);
await p2.fill('#join-name', 'Jonas');
await p2.click('#do-join');
await p2.waitForSelector('.roster-row');

const p3 = await phone('p3');
await p3.goto(`${BASE}/g/${code}`);
await p3.fill('#join-name', 'Priya');
await p3.click('#do-join');
await p3.waitForSelector('.roster-row');

// the host's lobby should fill in by itself, with no reload
await host.waitForFunction(() => document.querySelectorAll('.roster-name:not(.empty)').length === 3, null, { timeout: 8000 });
check('host sees all three joined without reloading', await host.$$eval('.roster-name', (e) => e.map((n) => n.textContent.trim())), ['Mira', 'Jonas', 'Priya']);
check('a player cannot start the game', await p2.$('#do-start'), null);

// ---- start ----
await host.click('#do-start');
await host.waitForSelector('.round-title');
await p2.waitForSelector('.round-title', { timeout: 8000 });
await p3.waitForSelector('.round-title', { timeout: 8000 });
check('players get pushed into the round', (await p2.textContent('.round-title')).replace(/\s+/g, ' ').trim(), 'Round 1 / 20');
check('everyone sees three score tiles', await tiles(p2), [0, 0, 0]);
check('tiles name the whole table', (await names(p3)).sort(), ['Jonas', 'Mira', 'Priya']);

// ---- each phone places its own bid, in turn ----
// Bidding is in turn by default: Mira (seat 0) deals, so Jonas bids first,
// then Priya, then Mira. A bid is a pick and a confirm; nothing is sent by
// the pick alone.
const pick = (pg, v) => pg.click(`.chip[data-mybid="${v}"]`);
const myBid = async (pg, v) => { await pick(pg, v); await pg.click('#confirm-bid'); };
check('the player who is up gets bid chips', await p2.$$eval('.your-turn .chip[data-mybid]', (e) => e.length), 2);
check('a player who is not up gets none', await p3.$('.chip[data-mybid]'), null);
check('and is told who they are waiting for', (await p3.textContent('.waiting')).includes('Jonas'), true);

await pick(p2, 1);
await p2.waitForTimeout(300);
check('picking a number sends nothing yet', await host.$$eval('.bid-chip.in', (e) => e.length), 0);
check('the confirm button says what it will send', (await p2.textContent('#confirm-bid')).trim(), 'Confirm bid of 1');
await p2.click('#confirm-bid');
await host.waitForFunction(() => document.querySelectorAll('.bid-chip.in').length === 1, null, { timeout: 8000 });
check('host sees the confirmed bid arrive', await host.$$eval('.bid-chip.in', (e) => e.map((n) => n.textContent.trim())), ['1']);
await p2.waitForSelector('.pill.sent', { timeout: 8000 });
check('the bidder is told it went in', (await p2.textContent('.pill.sent')).includes('Bid of 1 in'), true);
check('host cannot close bidding early', await host.isDisabled('#to-tricks'), true);

await p3.waitForSelector('.chip[data-mybid]', { timeout: 8000 });
await myBid(p3, 0);
await host.waitForSelector('.chip[data-mybid]', { timeout: 8000 });
await myBid(host, 0);
await host.waitForFunction(() => { const b = document.querySelector('#to-tricks'); return b && !b.disabled; }, null, { timeout: 8000 });
// The host knows from its own reply; the other phones learn on their next poll.
await p3.waitForFunction(() => document.querySelectorAll('.bid-chip.in').length === 3, null, { timeout: 8000 });
check('bids are visible to every phone', await p3.$$eval('.bid-chip', (e) => e.map((n) => n.textContent.trim())).then((a) => a.sort()), ['0', '0', '1']);

// Only the last bidder may change their mind; the order never gets a hole.
check('an earlier bidder cannot change theirs', await p2.$('#change-bid'), null);
await host.click('#change-bid');
await myBid(host, 1);
await p2.waitForFunction(() => [...document.querySelectorAll('.bid-chip')].map((n) => n.textContent.trim()).sort().join() === '0,1,1', null, { timeout: 8000 });
check('the last bidder can', await p2.$$eval('.bid-chip', (e) => e.map((n) => n.textContent.trim())).then((a) => a.sort()), ['0', '1', '1']);
await host.click('#change-bid');
await myBid(host, 0);
await host.waitForFunction(() => { const b = document.querySelector('#to-tricks'); return b && !b.disabled; }, null, { timeout: 8000 });

// ---- host closes bidding and scores ----
await host.click('#to-tricks');
await host.waitForSelector('.chip[data-trick]');
await p2.waitForFunction(
  () => { const w = document.querySelector('.waiting'); return w && /scorekeeper/i.test(w.textContent); },
  null, { timeout: 8000 });
check('players are told to wait', (await p2.textContent('.waiting')).includes('scorekeeper'), true);
check('a player has no trick entry', await p2.$('.chip[data-trick]'), null);

const seatOf = async (pg, who) => pg.$$eval('.tile-name', (e, w) => e.findIndex((n) => n.textContent.trim() === w), who);
const jonas = await seatOf(host, 'Jonas');
// The sheet is filled in locally and sent once; nothing scores by itself.
await host.click(`.chip[data-trick="1"][data-idx="${jonas}"]`);
await host.click(`.chip[data-trick="1"][data-idx="${(jonas + 1) % 3}"]`);
check('the sheet refuses a total that does not add up', await host.isDisabled('#do-score'), true);
check('and says why', (await host.textContent('.tally .pill')).includes('still to enter'), true);
await host.click(`.chip[data-trick="0"][data-idx="${(jonas + 2) % 3}"]`);
check('still refused when every seat is in but the sum is wrong', await host.isDisabled('#do-score'), true);
check('naming the surplus', (await host.textContent('.tally .pill')).includes('too many'), true);
await host.click(`.chip[data-trick="0"][data-idx="${(jonas + 1) % 3}"]`);
await host.waitForFunction(() => { const b = document.querySelector('#do-score'); return b && !b.disabled; }, null, { timeout: 8000 });
check('nothing has been sent while the sheet was being filled', await p2.$$eval('.round-title', (e) => e.map((n) => n.textContent.replace(/\s+/g, ' ').trim())), ['Round 1 / 20']);
await host.click('#do-score');

await p3.waitForFunction(() => [...document.querySelectorAll('[data-score-for]')].some((n) => +n.dataset.value !== 0), null, { timeout: 8000 });
const want = [0, 0, 0]; want[jonas] = 30; want[await seatOf(host, 'Mira')] = 20; want[await seatOf(host, 'Priya')] = 20;
check('scores update on every phone at once', await tiles(p3), want);
check('and match on the host', await tiles(host), want);
await p2.waitForFunction(
  () => /Round 2/.test(document.querySelector('.round-title')?.textContent || ''),
  null, { timeout: 8000 });
check('round advanced everywhere', (await p2.textContent('.round-title')).replace(/\s+/g, ' ').trim(), 'Round 2 / 20');

// ---- a refresh keeps your seat ----
await p2.reload();
await p2.waitForSelector('.round-title', { timeout: 8000 });
// In round 2 Jonas deals, so he is not up to bid and gets no bid panel; the
// "You" badge on the roster is what says the reload landed on his seat.
check('reload rejoins the same seat', await p2.$$eval('.badge', (e) => e.filter((n) => n.textContent.trim() === 'You').length), 1);
check('reload keeps the scores', await tiles(p2), want);

// ---- big scores view ----
await p3.click('#btn-table');
await p3.waitForSelector('.big-row');
check('scores overlay sorted desc', await p3.$$eval('.big-score', (e) => e.map((n) => +n.textContent)), [30, 20, 20]);

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) console.log('\n' + fails.join('\n'));
await b.close();
stopServer();
process.exit(fails.length ? 1 : 0);
