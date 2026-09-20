// The pre-deal controls: seating, who deals, and the house rules -- all of
// which have to agree across phones before anyone is dealt a card.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3161;
const BASE = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['server.js', String(PORT)], { stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);
for (let i = 0; i < 50; i++) {
  try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

let pass = 0; const fails = [];
const check = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const phone = async () => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => fails.push(`FAIL page error: ${e.message}`));
  return pg;
};

const host = await phone();
await host.goto(BASE);
await host.fill('#host-name', 'Ana');
await host.click('#s-minus');                  // 4 -> 3 seats
await host.click('#do-create');
await host.waitForSelector('.code-hero .code');
const code = (await host.textContent('.code-hero .code')).trim();

const p2 = await phone();
await p2.goto(`${BASE}/?g=${code}`);
await p2.fill('#join-name', 'Ben');
await p2.click('#do-join');
const p3 = await phone();
await p3.goto(`${BASE}/?g=${code}`);
await p3.fill('#join-name', 'Cass');
await p3.click('#do-join');
await host.waitForFunction(() => document.querySelectorAll('.badge.good, .roster-name:not(.empty)').length >= 3, null, { timeout: 8000 });

const names = (pg) => pg.$$eval('.roster-name:not(.empty)', (e) => e.map((n) => n.textContent.trim()));
const dealsFirst = (pg) => pg.$eval('.roster-row:has(.badge.gold) .roster-name', (e) => e.textContent.trim()).catch(() => null);

check('the lobby lists the table in join order', await names(host), ['Ana', 'Ben', 'Cass']);
check('seat one deals until told otherwise', await dealsFirst(host), 'Ana');

// ---- reordering -----------------------------------------------------------
await host.click('.mini[data-move="down"][data-idx="0"]');   // Ana down one
await host.waitForFunction(() => {
  const n = [...document.querySelectorAll('.roster-name:not(.empty)')].map((e) => e.textContent.trim());
  return n[0] === 'Ben';
}, null, { timeout: 8000 });
check('the host can reorder the table', await names(host), ['Ben', 'Ana', 'Cass']);
check('the dealer badge follows the person, not the row', await dealsFirst(host), 'Ana');

await p2.waitForFunction(() => {
  const n = [...document.querySelectorAll('.roster-name:not(.empty)')].map((e) => e.textContent.trim());
  return n[0] === 'Ben';
}, null, { timeout: 8000 });
check('the other phones see the new order', await names(p2), ['Ben', 'Ana', 'Cass']);
check('a player gets no reorder controls', await p2.$('.mini[data-move]'), null);

// ---- choosing the dealer --------------------------------------------------
await host.click('.mini[data-dealer="2"]');    // third row (Cass)
await host.waitForFunction(() => {
  const row = document.querySelector('.roster-row:has(.badge.gold) .roster-name');
  return row && row.textContent.trim() === 'Cass';
}, null, { timeout: 8000 });
check('the host picks who deals first', await dealsFirst(host), 'Cass');

// ---- house rules ----------------------------------------------------------
const chosen = (pg, attr) => pg.$eval(`.opt[data-${attr}][aria-pressed="true"]`, (e) => e.textContent.trim());
const note = (pg, attr) => pg.$eval(`.opt[data-${attr}]`, (e) => e.closest('.field').querySelector('.opt-note').textContent.trim());

check('scoring defaults to standard', await chosen(host, 'scoring'), 'Standard');
check('bidding defaults to open', await chosen(host, 'bidding'), 'Open bidding');
check('each option explains itself', (await note(host, 'scoring')).includes('20 plus 10 a trick'), true);

await host.click('.opt[data-scoring="zeroScales"]');
await host.waitForFunction(() => {
  const el = document.querySelector('.opt[data-scoring][aria-pressed="true"]');
  return el && /Zero/.test(el.textContent);
}, null, { timeout: 8000 });
check('picking a variant updates the instructions', (await note(host, 'scoring')).includes('10 per card dealt'), true);

await host.click('.opt[data-bidding="blind"]');
await p3.waitForFunction(() => {
  const el = document.querySelector('.opt[data-bidding][aria-pressed="true"]');
  return el && /Blind/.test(el.textContent);
}, null, { timeout: 8000 });
check('the rules reach the other phones', await chosen(p3, 'bidding'), 'Blind bidding');
check('a player cannot change them', await p3.$eval('.opt[data-bidding="open"]', (e) => e.disabled), true);

// ---- and they hold once dealt ---------------------------------------------
await host.click('#do-start');
await host.waitForSelector('.round-title', { timeout: 8000 });
await p2.waitForSelector('.round-title', { timeout: 8000 });
await p3.waitForSelector('.round-title', { timeout: 8000 });
check('round 1 is dealt by the chosen dealer',
  (await host.textContent('.round-meta')).includes('Cass deals'), true);

// Blind bidding: Ben bids, and Cass must not be able to see the value.
await p2.waitForSelector('.your-turn .chip', { timeout: 8000 });
await p2.click('.chip[data-mybid="1"]');
await p3.waitForFunction(() => document.querySelectorAll('.bid-chip.in').length >= 1, null, { timeout: 8000 });
const seenByCass = await p3.$$eval('.bid-chip.in', (e) => e.map((n) => n.textContent.trim()));
check('a blind bid shows as placed but not as a number', seenByCass, ['✓']);
const leaked = await p3.evaluate(async () => {
  const r = await fetch(`api/game?code=${new URLSearchParams(location.search).get('g')}`);
  return JSON.stringify((await r.json()).game.bids);
});
check('and the value is not in the payload either', leaked, '{}');

// ---- an impatient double-tap must not take two seats -----------------------
{
  // A cold serverless function makes the first tap look like it did nothing,
  // so players tap again. That used to burn a second seat and lock someone out.
  const slow = await b.newContext({ viewport: { width: 390, height: 844 } });
  const imp = await slow.newPage();
  await imp.route('**/api/game', async (r) => {
    if (r.request().method() === 'POST') await new Promise((x) => setTimeout(x, 700));
    await r.continue();
  });

  const fresh = await phone();
  await fresh.goto(BASE);
  await fresh.fill('#host-name', 'Host');
  await fresh.click('#s-minus');                     // 3 seats
  await fresh.click('#do-create');
  await fresh.waitForSelector('.code-hero .code');
  const c2 = (await fresh.textContent('.code-hero .code')).trim();

  await imp.goto(`${BASE}/?g=${c2}`);
  await imp.fill('#join-name', 'Impatient');
  await imp.evaluate(() => { const el = document.querySelector('#do-join'); el.click(); el.click(); });
  await imp.waitForSelector('.roster-row', { timeout: 10000 });
  await imp.waitForTimeout(1800);

  const seated = await fresh.$$eval('.roster-name:not(.empty)', (e) => e.map((n) => n.textContent.trim()));
  check('a double-tapped join takes exactly one seat', seated, ['Host', 'Impatient']);
  check('and that phone has a seat of its own',
    await imp.$$eval('.roster-row', (e) => e.some((r) => /\bYou\b/.test(r.textContent))), true);

  const last = await phone();
  await last.goto(`${BASE}/?g=${c2}`);
  await last.fill('#join-name', 'Third');
  await last.click('#do-join');
  await last.waitForSelector('.roster-row', { timeout: 10000 });
  await last.waitForTimeout(600);
  check('so the next player is not locked out of a full table',
    await last.$$eval('.roster-row', (e) => e.some((r) => /\bYou\b/.test(r.textContent))), true);
  await slow.close();
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) console.log('\n' + fails.join('\n'));
await b.close();
stop();
process.exit(fails.length ? 1 : 0);
