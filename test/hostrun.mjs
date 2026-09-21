// One phone runs the whole table -- names everyone, takes the bids, counts
// the tricks -- while another phone follows along and can only watch. And a
// phones table can seat someone who has no phone at all.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3171;
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
const names = (pg) => pg.$$eval('.roster-name:not(.empty)', (e) => e.map((n) => n.textContent.trim()));
const text = (pg, sel) => pg.$eval(sel, (e) => e.textContent.trim()).catch(() => null);

// ---- the scorekeeper names the table ---------------------------------------
const host = await phone();
await host.goto(BASE);
check('the setup offers both ways to run a table', await host.$$eval('.seg button', (e) => e.length), 2);
check('phones is the default', await host.$eval('#mode-phones', (e) => e.getAttribute('aria-pressed')), 'true');
await host.click('#mode-host');
await host.waitForSelector('[data-seat-name="0"]');
check('choosing to keep score asks for everyone\'s name', await host.$$eval('[data-seat-name]', (e) => e.length), 4);
check('and says what it is', (await host.textContent('.lede')).includes('the rest can watch'), true);
await host.click('#s-minus');
await host.waitForSelector('[data-seat-name="2"]');
for (const [i, n] of [[0, 'Ana'], [1, 'Ben'], [2, 'Cass']]) await host.fill(`[data-seat-name="${i}"]`, n);
await host.click('#do-create');
await host.waitForSelector('.code-hero .code', { timeout: 8000 });
const code = (await host.textContent('.code-hero .code')).trim();
check('the table lands in the lobby with everyone seated', await names(host), ['Ana', 'Ben', 'Cass']);
check('nobody is marked as this phone', await host.$('.badge:has-text("You")'), null);
check('no open seats are shown', await host.$('.roster-name.empty'), null);
check('the link invites people to follow along', (await text(host, '.code-hero .hint')).includes('follow along'), true);

// ---- adding and removing in the lobby ---------------------------------------
{
  // The Add button once inherited the full-width primary style and squeezed
  // the name field to a sliver; the field has to be the wide one.
  const field = await host.$eval('#add-name', (e) => e.getBoundingClientRect().width);
  const button = await host.$eval('#do-add', (e) => e.getBoundingClientRect().width);
  check('the name field is wider than its Add button', field > button * 1.5, true);
  check('and the field is wide enough to read a name in', field > 150, true);
}
await host.fill('#add-name', 'Dee');
await host.press('#add-name', 'Enter');
await host.waitForFunction(() => document.querySelectorAll('.roster-name:not(.empty)').length === 4, null, { timeout: 8000 });
check('a player can be added from the lobby', await names(host), ['Ana', 'Ben', 'Cass', 'Dee']);
check('the host is told', (await text(host, '.pill.sent')).includes('Dee added'), true);
check('every seat can be removed again', await host.$$eval('.mini[data-remove]', (e) => e.length), 4);
await host.click('.mini[data-remove="1"]');
await host.waitForFunction(() => document.querySelectorAll('.roster-name:not(.empty)').length === 3, null, { timeout: 8000 });
check('and removed', await names(host), ['Ana', 'Cass', 'Dee']);

// ---- another phone can only follow ------------------------------------------
const fan = await phone();
await fan.goto(`${BASE}/?g=${code}`);
await fan.waitForSelector('#do-watch', { timeout: 8000 });
check('an invite to this table offers to follow, not to join', await fan.$('#do-join'), null);
check('and explains why', (await text(fan, '.panel-title')) !== null && (await fan.textContent('body')).includes('scored on one phone'), true);
await fan.click('#do-watch');
await fan.waitForSelector('.roster', { timeout: 8000 });
check('the follower sees the lobby', await names(fan), ['Ana', 'Cass', 'Dee']);
check('with no controls', await fan.$('.mini'), null);
check('and knows it is following', (await fan.textContent('body')).includes('following along'), true);

// ---- the host runs the round ------------------------------------------------
await host.click('#do-start');
await host.waitForSelector('.round-title', { timeout: 8000 });
await fan.waitForSelector('.round-title', { timeout: 8000 });
check('the host gets the bid entry, one seat at a time', await host.$$eval('.entry', (e) => e.length), 1);
const due = await text(host, '.entry .entry-name');
check('starting to the dealer\'s left', due, 'Cass');
await host.click('.entry .chip[data-forbid="1"]');
await host.waitForFunction(() => document.querySelectorAll('.entry').length === 2, null, { timeout: 8000 });
check('the next seat is due, and the last bid stays open to change below it',
  await host.$$eval('.entry .entry-name', (e) => e.map((n) => n.textContent.trim())), ['Dee', 'Cass']);
await fan.waitForFunction(() => document.querySelector('.bid-chip.in'), null, { timeout: 8000 });
check('the follower sees the bid land', await fan.$$eval('.bid-chip.in', (e) => e.map((n) => n.textContent.trim())), ['1']);
check('and has nothing to tap', await fan.$('.chip'), null);
const entryOf = (name) => `.entry:has(.entry-name:text-is("${name}"))`;
await host.click(`${entryOf('Dee')} .chip[data-forbid="0"]`);
await host.waitForSelector(entryOf('Ana'), { timeout: 8000 });
check('the dealer bids last', await host.$$eval('.entry .entry-name', (e) => e.map((n) => n.textContent.trim())), ['Ana', 'Dee']);
await host.click(`${entryOf('Ana')} .chip[data-forbid="0"]`);
await host.waitForSelector('#to-tricks:not([disabled])', { timeout: 8000 });
await host.click('#to-tricks');
await host.waitForSelector('.chip[data-trick]', { timeout: 8000 });
for (const [idx, v] of [[0, 0], [1, 1], [2, 0]]) await host.click(`.chip[data-trick="${v}"][data-idx="${idx}"]`);
await host.click('#do-score');
await host.waitForFunction(() => /Round 2/.test(document.querySelector('.round-title').textContent), null, { timeout: 8000 });
await fan.waitForFunction(() => /Round 2/.test((document.querySelector('.round-title') || {}).textContent || ''), null, { timeout: 8000 });
const totals = (pg) => pg.$$eval('[data-score-for]', (e) => e.map((n) => n.dataset.value));
check('the follower sees the round scored', await totals(fan), ['20', '30', '20']);

// ---- a phones table seats someone with no phone -------------------------------
{
  const h = await phone();
  await h.goto(BASE);
  await h.fill('#host-name', 'Mira');
  await h.click('#s-minus');
  await h.click('#do-create');
  await h.waitForSelector('.code-hero .code');
  const c2 = (await h.textContent('.code-hero .code')).trim();
  const p = await phone();
  await p.goto(`${BASE}/?g=${c2}`);
  await p.waitForSelector('#do-join');
  check('an invite to a phones table still offers a seat', await p.$('#do-join') !== null, true);
  check('and a way to just watch', await p.$('#do-watch') !== null, true);
  await p.fill('#join-name', 'Jonas');
  await p.click('#do-join');
  await h.waitForFunction(() => document.querySelectorAll('.roster-name:not(.empty)').length === 2, null, { timeout: 8000 });
  await h.fill('#add-name', 'Gran');
  await h.click('#do-add');
  await h.waitForFunction(() => document.querySelectorAll('.roster-name:not(.empty)').length === 3, null, { timeout: 8000 });
  check('the no-phone player is marked', await h.$$eval('.badge.quiet', (e) => e.map((n) => n.textContent.trim())).then((t) => t.includes('No phone')), true);
  check('only the no-phone seat can be removed', await h.$$eval('.mini[data-remove]', (e) => e.map((n) => n.dataset.remove)), ['2']);

  const w = await phone();
  await w.goto(BASE);
  await w.fill('#join-code', c2);
  await w.click('#do-watch');
  await w.waitForSelector('.roster', { timeout: 8000 });
  check('a watcher typed the code and sees the lobby', await names(w), ['Mira', 'Jonas', 'Gran']);

  await h.click('.opt[data-bidding="open"]');
  await h.click('#save-seating');
  await h.waitForSelector('.pill.sent', { timeout: 8000 });
  await h.click('#do-start');
  await h.waitForSelector('.round-title', { timeout: 8000 });
  await h.waitForSelector('.entry .chip[data-forbid]', { timeout: 8000 });
  check('the host gets an open panel for the no-phone bid', await text(h, '.panel-title:has-text("Bids you enter")') !== null, true);
  check('for the right person', await h.$$eval('.panel .entry .entry-name', (e) => e.map((n) => n.textContent.trim())), ['Gran']);
  check('while filling in for a phone stays tucked away', await h.$$eval('details .entry .entry-name', (e) => e.map((n) => n.textContent.trim())), ['Jonas']);
  await h.click('.entry .chip[data-forbid="0"][data-idx="2"]');
  await w.waitForFunction(() => document.querySelector('.bid-chip.in'), null, { timeout: 8000 });
  check('the watcher sees it', await w.$$eval('.bid-chip.in', (e) => e.length), 1);
  await p.waitForSelector('.your-turn .chip', { timeout: 8000 });
  await p.click('.chip[data-mybid="1"]');
  await p.click('#confirm-bid');
  await p.waitForSelector('.pill.sent', { timeout: 8000 });
  check('and the phone still bids for itself', (await text(p, '.pill.sent')).includes('Bid of 1'), true);
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) console.log('\n' + fails.join('\n'));
await b.close();
stop();
process.exit(fails.length ? 1 : 0);
