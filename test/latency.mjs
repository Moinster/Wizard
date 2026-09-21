// Reproduces the reported symptom: tapping a bid, seeing it deselect, then
// reselect. It needs a slow backend to show up -- the in-memory dev server
// answers too fast -- so the API POST is delayed in the browser to stand in
// for a serverless round trip against Blob storage.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3151;
const BASE = `http://localhost:${PORT}`;
const WRITE_DELAY_MS = 600;   // a plausible serverless + blob round trip

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
const phone = async (slow) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  if (slow) {
    // Only writes are slowed; polling stays at its normal speed so the race
    // between an in-flight write and a poll is the thing under test.
    await pg.route('**/api/game', async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, WRITE_DELAY_MS));
      await route.continue();
    });
  }
  return pg;
};

const host = await phone(false);
await host.goto(BASE);
await host.fill('#host-name', 'Mira');
await host.click('#s-minus');            // 4 -> 3 seats
await host.click('#do-create');
await host.waitForSelector('.code-hero .code');
const code = (await host.textContent('.code-hero .code')).trim();

const me = await phone(true);            // the slow phone: the one under test
await me.goto(`${BASE}/?g=${code}`);
await me.waitForSelector('#join-code');
await me.fill('#join-name', 'Jonas');
await me.click('#do-join');
await me.waitForSelector('.roster-row');

const p3 = await phone(false);
await p3.goto(`${BASE}/?g=${code}`);
await p3.fill('#join-name', 'Priya');
await p3.click('#do-join');
await p3.waitForSelector('.roster-row');

await host.waitForFunction(() => document.querySelectorAll('.roster-name:not(.empty)').length === 3, null, { timeout: 8000 });
await host.click('#do-start');
await me.waitForSelector('.your-turn .chip', { timeout: 8000 });

// Round 1 deals one card, so the bid chips are 0 and 1. Jonas is left of the
// dealer, so he is up first.
const pressed = () => me.$eval('.chip[data-mybid="1"]', (el) => el.getAttribute('aria-pressed') === 'true');

await me.click('.chip[data-mybid="1"]');

// 1. The pick is local: it shows at once, and nothing has gone anywhere.
await me.waitForTimeout(150);
check('the pick shows as selected right after the tap', await pressed(), true);

// 2. And it must stay selected -- a pick never flickers, because no poll can
//    disagree with a draft that only this phone knows about.
const samples = [];
for (let i = 0; i < 25; i++) {
  samples.push(await pressed());
  await me.waitForTimeout(100);
}
const flickers = samples.filter((v) => v === false).length;
check('it never flickers back off over 2.5s', flickers, 0);
check('and the other phone has seen nothing yet', await host.$$eval('.bid-chip.in', (e) => e.length), 0);

// 3. Confirming sends it. The button holds until the slow write returns, so a
//    second tap cannot send it twice, and the phone says when it is in.
const t0 = Date.now();
await me.click('#confirm-bid');
await me.waitForSelector('.pill.sent', { timeout: 8000 });
const took = Date.now() - t0;
check('the phone confirms once the server has it', (await me.textContent('.pill.sent')).includes('Bid of 1 in'), true);
check('and not before the write returned', took >= WRITE_DELAY_MS - 50, true);
console.log(`    (the confirm held for ${took}ms against a ${WRITE_DELAY_MS}ms write)`);
await host.waitForFunction(() => document.querySelectorAll('.bid-chip.in').length >= 1, null, { timeout: 8000 });
check('the other phone sees the bid', await host.$$eval('.bid-chip.in', (e) => e.map((n) => n.textContent.trim())), ['1']);
console.log(`    (a confirmed bid reached the other phone in ${Date.now() - t0}ms)`);

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) console.log('\n' + fails.join('\n'));
await b.close();
stop();
process.exit(fails.length ? 1 : 0);
