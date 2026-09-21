// The end of a game: the scorekeeper closes the table and it stops existing,
// while a phone that was following keeps the final scores on its screen.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3191;
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
const api = async (body) => (await fetch(`${BASE}/api/game`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const phone = async () => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => fails.push(`FAIL page error: ${e.message}`));
  return pg;
};

// A one-round table the scorekeeper runs, so the game ends in a few taps.
const made = await api({ action: 'create', hostRuns: true, names: ['Ana', 'Ben'], rounds: 1 });
const { code, hostKey } = made;

const host = await phone();
await host.goto(BASE);
await host.evaluate(([c, k]) => localStorage.setItem('wizard.session.v1', JSON.stringify({ code: c, hostKey: k })), [code, hostKey]);
await host.goto(`${BASE}/?g=${code}`);
await host.waitForSelector('#do-start', { timeout: 8000 });

const fan = await phone();
await fan.goto(`${BASE}/?g=${code}`);
await fan.waitForSelector('#do-watch', { timeout: 8000 });
await fan.click('#do-watch');
await fan.waitForSelector('.roster', { timeout: 8000 });

await host.click('#do-start');
await host.waitForSelector('.entry .chip[data-forbid]', { timeout: 8000 });
await host.click('.entry:has(.entry-name:text-is("Ben")) .chip[data-forbid="1"]');
await host.waitForSelector('.entry:has(.entry-name:text-is("Ana")) .chip[data-forbid]', { timeout: 8000 });
await host.click('.entry:has(.entry-name:text-is("Ana")) .chip[data-forbid="0"]');
await host.waitForSelector('#to-tricks:not([disabled])', { timeout: 8000 });
await host.click('#to-tricks');
await host.waitForSelector('.chip[data-trick]', { timeout: 8000 });
await host.click('.chip[data-trick="0"][data-idx="0"]');
await host.click('.chip[data-trick="1"][data-idx="1"]');
await host.click('#do-score');
await host.waitForSelector('#do-end', { timeout: 8000 });
check('the final screen offers to close the table', await host.$eval('#do-end', (e) => e.textContent.trim()), 'Close the table');
check('and says what that means', (await host.textContent('.winner')).includes('erases the game'), true);
await fan.waitForSelector('.winner', { timeout: 8000 });
check('the follower sees the result', (await fan.textContent('.winner .who')).trim(), 'Ben wins');
check('but gets no way to close it', await fan.$('#do-end'), null);

// ---- the scorekeeper closes the table --------------------------------------
await host.click('#do-end');
await host.waitForSelector('#do-create', { timeout: 8000 });
check('the scorekeeper is back at the start', await host.$('#do-create') !== null, true);
const gone = await fetch(`${BASE}/api/game?code=${code}`);
check('and the game no longer exists', gone.status, 404);

await fan.waitForFunction(() => /closed the table/.test(document.body.textContent), null, { timeout: 8000 });
check('the follower is told, and keeps the scores', (await fan.textContent('.winner .who')).trim(), 'Ben wins');
check('and its phone has stopped asking', await fan.evaluate(() => new Promise((r) => {
  let polls = 0;
  const orig = window.fetch;
  window.fetch = (...a) => { if (String(a[0]).includes('api/game')) polls++; return orig(...a); };
  setTimeout(() => r(polls), 2600);
})), 0);
await fan.click('#btn-leave');
await fan.waitForSelector('#do-create', { timeout: 8000 });
check('leaving clears the phone', await fan.$('.winner'), null);

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) console.log('\n' + fails.join('\n'));
await b.close();
stop();
process.exit(fails.length ? 1 : 0);
