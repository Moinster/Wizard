// What a static host (GitHub Pages) serves: public/ and nothing else -- no
// /api, and mounted under a project subpath, which is where base-path bugs
// show up. The whole game has to run inside the one browser.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = '/wizard/';
const PORT = Number(process.env.PORT) || 3141;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json' };

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (!path.startsWith(PREFIX)) { res.writeHead(404); return res.end('not found'); }
  const rel = path.slice(PREFIX.length) || 'index.html';
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404, {'content-type':'text/plain'}); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, r));
const BASE = `http://localhost:${PORT}${PREFIX}`;

let pass = 0; const fails = [];
const check = (name, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (okv) pass++; else fails.push(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(e.message));
pg.on('requestfailed', (r) => { if (!/fonts\./.test(r.url())) errors.push(`request failed: ${r.url()}`); });
const missing = [];
// The health probe is *meant* to 404 here: that is how the client learns
// there is no server. Any other 404 is a broken asset path.
pg.on('response', (r) => {
  if (r.status() === 404 && !/favicon|api\/health/.test(r.url())) missing.push(r.url());
});

await pg.goto(BASE);
await pg.waitForSelector('[data-seat-name]', { timeout: 10000 });
check('no broken asset paths on a subpath', missing, []);
check('no page errors', errors, []);
check('falls back to the one-device screen', await pg.$$eval('[data-seat-name]', (e) => e.length), 4);
check('no join panel without a server', await pg.$('#do-join'), null);
check('intro names the mode', (await pg.textContent('.lede')).includes('the whole table'), true);

// three players
await pg.click('#s-minus');
await pg.waitForSelector('[data-seat-name="2"]');
for (const [i, n] of [[0,'Mira'],[1,'Jonas'],[2,'Priya']]) await pg.fill(`[data-seat-name="${i}"]`, n);
await pg.click('#do-create');
await pg.waitForSelector('.round-title', { timeout: 10000 });
check('deals straight into round 1', (await pg.textContent('.round-title')).replace(/\s+/g,' ').trim(), 'Round 1 / 20');
check('scoreboard shows the table', await pg.$$eval('.tile-name', (e) => e.map((n) => n.textContent.trim()).sort()), ['Jonas','Mira','Priya']);
// Bidding is in turn by default, so the one device enters bids for the seat
// that is up, one seat at a time: two chips (0 and 1) for the seat due.
check('one device enters the bid for whoever is up', await pg.$$eval('.chip[data-forbid]', (e) => e.length), 2);

const seatOf = async (who) => pg.$$eval('.tile-name', (e, w) => e.findIndex((n) => n.textContent.trim() === w), who);
const mira = await seatOf('Mira');
for (let k = 0; k < 3; k++) {
  const idx = await pg.$eval('.chip[data-forbid]', (e) => +e.dataset.idx);
  await pg.click(`.chip[data-forbid="${idx === mira ? 1 : 0}"][data-idx="${idx}"]`);
  // The seat that is due comes first; the last bid stays open below it in
  // case of a slip, which is why "every bid is in" is also a way out here.
  await pg.waitForFunction((prev) => {
    const c = document.querySelector('.chip[data-forbid]');
    const t = document.querySelector('#to-tricks');
    return (t && !t.disabled) || !c || +c.dataset.idx !== prev;
  }, idx, { timeout: 8000 });
}
await pg.waitForFunction(() => { const x = document.querySelector('#to-tricks'); return x && !x.disabled; }, null, { timeout: 8000 });
await pg.click('#to-tricks');
await pg.waitForSelector('.chip[data-trick]');
for (let i = 0; i < 3; i++) await pg.click(`.chip[data-trick="${i === mira ? 1 : 0}"][data-idx="${i}"]`);
await pg.waitForFunction(() => { const x = document.querySelector('#do-score'); return x && !x.disabled; }, null, { timeout: 8000 });
await pg.click('#do-score');
await pg.waitForFunction(() => [...document.querySelectorAll('[data-score-for]')].some((n) => +n.dataset.value !== 0), null, { timeout: 8000 });

const want = [20, 20, 20]; want[mira] = 30;
check('scores the round with no server', await pg.$$eval('[data-score-for]', (e) => e.map((n) => +n.dataset.value)), want);
check('advances the round', (await pg.textContent('.round-title')).replace(/\s+/g,' ').trim(), 'Round 2 / 20');

await pg.reload();
await pg.waitForSelector('.round-title', { timeout: 10000 });
check('the game survives a reload', await pg.$$eval('[data-score-for]', (e) => e.map((n) => +n.dataset.value)), want);
check('still on round 2 after reload', (await pg.textContent('.round-title')).replace(/\s+/g,' ').trim(), 'Round 2 / 20');
check('no errors across the whole run', errors, []);

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) console.log('\n' + fails.join('\n'));
await b.close();
server.close();
process.exit(fails.length ? 1 : 0);
