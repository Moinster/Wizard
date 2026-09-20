"use strict";
import { qrSvg } from "./qr.js";
import { scoreFor, SCORING_VARIANTS, BIDDING_VARIANTS } from "./lib/game.js";

const SESSION_KEY = "wizard.session.v1";
const CLIENT_KEY = "wizard.client.v1";
const TRUMPS = [
  { k:"S", glyph:"♠", name:"Spades", red:false },
  { k:"H", glyph:"♥", name:"Hearts", red:true },
  { k:"D", glyph:"♦", name:"Diamonds", red:true },
  { k:"C", glyph:"♣", name:"Clubs", red:false },
  { k:"N", glyph:"None", name:"No trump", red:false },
];
const ROUNDS_FOR = { 3:20, 4:15, 5:12, 6:10, 7:8, 8:7 };
const CROWN = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 18h18l1.2-11-5.4 3.9L12 3 7.2 10.9 1.8 7 3 18Z"/></svg>';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const signed = (n) => (n > 0 ? "+" : "") + n;
/** Older saved games predate house rules; fall back to the standard ones. */
const rules = () => (game && game.settings) || { scoring: "standard", bidding: "open" };
const placedBids = () => (game.bidPlaced || Object.keys(game.bids).map(Number));
const scoreRound = (bid, taken, cards) => scoreFor(bid, taken, { scoring: rules().scoring, cards });

/* ------------------------------ session ------------------------------ */
let session = null;      // {code, hostKey, seatKey, seatIdx}
let game = null;         // public view from the server
let etag = null;
let prevTotals = null;
let polling = false;
let stale = false;
let setupDraft = { name:"", seats:4, rounds:null, names:[] };
let writesInFlight = 0;    // a tap we've drawn locally but the server hasn't confirmed
let solo = false;          // true when there's no server: the game runs in this browser
let localApi = null;       // {store, handlePost, handleGet, sanitize} in solo mode
let joinDraft = { name:"", code:"" };

/**
 * A stable id for this device, so a retried or double-tapped join lands back
 * on the seat it already has instead of taking a second one.
 */
let fallbackClientId = null;
function clientId(){
  const fresh = () => (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`);
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) { id = fresh(); localStorage.setItem(CLIENT_KEY, id); }
    return id;
  } catch {
    return (fallbackClientId ||= fresh());   // private window: per-tab is still better than none
  }
}

function loadSession(){
  try { const raw = localStorage.getItem(SESSION_KEY); if (raw) return JSON.parse(raw); } catch {}
  return null;
}
function saveSession(s){
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
}

/* ------------------------------ transport ------------------------------ */
const apiUrl = (path) => new URL(path, location.href);

/**
 * A static host has no /api/health, so a failed probe means "run the whole
 * game in this browser". Keeping it to one request makes the answer stable
 * for the life of the page.
 */
async function detectBackend(){
  try {
    const res = await fetch(apiUrl("api/health"), { cache:"no-store" });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && body.ok) return false;
    }
  } catch {}
  return true;
}

async function loadLocalBackend(){
  const [store, handler] = await Promise.all([
    import("./lib/store.js"),
    import("./lib/handler.js"),
  ]);
  localApi = {
    store: store.localStorageStore(),
    handlePost: handler.handlePost,
    handleGet: handler.handleGet,
    sanitize: handler.sanitize,
  };
}
function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(body){
  if (solo) {
    const out = await localApi.handlePost(localApi.store, body);
    if (out.status !== 200) { toast(out.body.message || "That didn't work."); return null; }
    return localApi.sanitize(out.body, { hostKey: body.hostKey, seatKey: out.body.seatKey || body.seatKey });
  }
  const res = await fetch(apiUrl("api/game"), {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.message || "That didn't work."); return null; }
  return data;
}

async function poll(){
  // A poll that overlaps our own in-flight write would answer with the board
  // as it was before the tap, and the tap would appear to undo itself.
  if (!session || solo || writesInFlight) return;
  const q = new URLSearchParams({ code: session.code });
  if (etag) q.set("etag", etag);
  if (session.hostKey) q.set("hostKey", session.hostKey);
  if (session.seatKey) q.set("seatKey", session.seatKey);
  try {
    const res = await fetch(`${apiUrl("api/game")}?${q}`, { cache:"no-store" });
    if (res.status === 404) { toast("That game is gone."); saveSession(null); game = null; render(); return; }
    const data = await res.json();
    stale = false;
    if (data.unchanged) { quietPolls++; return; }
    if (data.game) { quietPolls = 0; adopt(data); }
  } catch {
    stale = true;
    updateConn();
  }
}

function adopt(data){
  if (data.etag) etag = data.etag;
  if (!data.game) return;
  // Responses can arrive out of order: a poll sent before a bid landed can
  // answer after it, carrying the older board. Every write bumps `v`, so a
  // lower one is stale and applying it would undo what the player just did.
  if (game && typeof game.v === "number" && typeof data.game.v === "number" && data.game.v < game.v) return;
  const before = game ? game.totals : null;
  const scored = game && data.game.history.length !== game.history.length;
  game = data.game;
  if (scored && before) prevTotals = before;
  render();
  if (scored) animateTotals();
}

/**
 * How long to wait before asking again. The lobby stays brisk because that is
 * where people watch for each other arriving; a table that has gone quiet
 * eases off, and any change snaps it straight back.
 */
let quietPolls = 0;
function pollGap(){
  if (document.hidden) return 5000;
  if (!game) return 2000;
  if (game.status === "lobby") return 1200;
  if (game.status === "done") return 3000;
  return quietPolls >= 10 ? 2500 : 1200;
}

function startPolling(){
  if (polling || solo) return;
  polling = true;
  const tick = async () => {
    if (!polling) return;
    if (!document.hidden) await poll();
    setTimeout(tick, pollGap());
  };
  tick();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

/* ------------------------------ derived ------------------------------ */
function standings(){
  const rows = game.seats.map((s) => ({ idx:s.idx, name:s.name, total:game.totals[s.idx] }));
  rows.sort((a,b) => b.total - a.total);
  let rank = 0, seen = null;
  rows.forEach((r,i) => { if (r.total !== seen) { rank = i+1; seen = r.total; } r.rank = rank; });
  return rows;
}
const bidsIn = () => placedBids().length;
const allBidsIn = () => bidsIn() === game.seats.length;
const trickSum = () => Object.values(game.tricks).reduce((a,b) => a+b, 0);
const tricksIn = () => Object.keys(game.tricks).length;
const myBid = () => (game.youIdx === null ? undefined : game.bids[game.youIdx]);

/* ------------------------------ render ------------------------------ */
function render(){
  const actions = [];
  if (game) actions.push('<button class="icon-btn" id="btn-table">Scores</button>');
  actions.push('<button class="icon-btn" id="btn-rules">Rules</button>');
  if (session) actions.push(`<button class="icon-btn" id="btn-leave">${solo ? "New" : "Leave"}</button>`);
  $("topbar-actions").innerHTML = actions.join("");

  const main = $("main");
  if (!session || !game) main.innerHTML = homeHTML();
  else if (game.status === "lobby") main.innerHTML = lobbyHTML();
  else main.innerHTML = playHTML();

  wire();
  updateConn();
}

function updateConn(){
  const el = document.querySelector(".conn");
  if (el) el.classList.toggle("stale", stale);
}

/* ---- home ---- */
function homeHTML(){
  const n = setupDraft.seats;
  const rounds = setupDraft.rounds ?? (ROUNDS_FOR[n] || 15);

  const intro = solo
    ? `<p class="lede">One phone, <em>the whole table.</em></p>
       <p class="lede-sub">Name everyone, then take the bids and the tricks round by round. Scores stay on this device \u2014 nothing is sent anywhere, and closing the tab won't lose the game.</p>`
    : `<p class="lede">Everyone bids from <em>their own phone.</em></p>
       <p class="lede-sub">Start a game, read out the four-letter code, and the table joins. Bids come in from each player; the scorekeeper counts the tricks; every phone shows every score.</p>`;

  const whoField = solo
    ? `<div class="field">
        <label>Players</label>
        <div class="roster">${Array.from({ length: n }, (_, i) => `
          <div class="roster-row">
            <span class="seat-pip">${i + 1}</span>
            <input data-seat-name="${i}" id="seat-name-${i}" type="text" maxlength="14" autocomplete="off"
                   aria-label="Player ${i + 1} name" placeholder="Player ${i + 1}" value="${esc(setupDraft.names[i] || "")}">
          </div>`).join("")}</div>
      </div>`
    : `<div class="field">
        <label for="host-name">Your name</label>
        <input id="host-name" type="text" maxlength="14" autocomplete="off" placeholder="Scorekeeper" value="${esc(setupDraft.name)}">
      </div>`;

  return `
  <div>${intro}</div>

  <div class="panel">
    <div class="panel-title">${solo ? "New game" : "Start a game"}</div>
    ${whoField}
    <div class="field">
      <label>${solo ? "How many playing" : "Seats at the table"}</label>
      <div class="counter">
        <button class="round-btn" id="s-minus" ${n<=2?"disabled":""} aria-label="One seat fewer">&minus;</button>
        <span class="counter-val num">${n}</span>
        <button class="round-btn" id="s-plus" ${n>=8?"disabled":""} aria-label="One seat more">+</button>
        <span class="counter-note">${ROUNDS_FOR[n]
          ? `The 60-card deck deals out over <b>${rounds} rounds</b>.`
          : `Over six players needs a second deck — <b>${rounds} rounds</b>.`}</span>
      </div>
    </div>
    <div class="field">
      <label>Rounds</label>
      <div class="counter">
        <button class="round-btn" id="r-minus" ${rounds<=1?"disabled":""} aria-label="One round fewer">&minus;</button>
        <span class="counter-val num">${rounds}</span>
        <button class="round-btn" id="r-plus" ${rounds>=20?"disabled":""} aria-label="One round more">+</button>
        <span class="counter-note">Round 1 deals one card each and every round adds one.</span>
      </div>
    </div>
    <button class="btn" id="do-create">${solo ? "Start scoring" : "Start a game"}</button>
  </div>

  ${solo ? "" : `
  <div class="panel">
    <div class="panel-title">Join a game</div>
    <div class="field">
      <label for="join-name">Your name</label>
      <input id="join-name" type="text" maxlength="14" autocomplete="off" placeholder="Your name" value="${esc(joinDraft.name)}">
    </div>
    <div class="field">
      <label for="join-code">Game code</label>
      <input id="join-code" class="code-input num" type="text" maxlength="4" autocomplete="off"
             autocapitalize="characters" spellcheck="false" placeholder="––––" value="${esc(joinDraft.code)}">
    </div>
    <button class="btn btn-ghost" id="do-join">Join</button>
  </div>`}`;
}

/* ---- lobby ---- */

/** One rule group: the choices, and what the chosen one does. */
function optionGroup(label, variants, current, attr, editable){
  const chosen = variants.find((v) => v.key === current) || variants[0];
  return `
    <div class="field">
      <label>${label}</label>
      <div class="opts" role="group" aria-label="${label}">
        ${variants.map((v) => `
          <button class="opt" data-${attr}="${v.key}" aria-pressed="${current === v.key}"
            ${editable ? "" : "disabled"}>${esc(v.name)}</button>`).join("")}
      </div>
      <p class="opt-note">${esc(chosen.blurb)}</p>
    </div>`;
}

function lobbyHTML(){
  const seated = game.seats.filter((s) => s.joined);
  const joined = seated.length;
  const link = `${location.origin}${location.pathname}?g=${game.code}`;
  const host = game.isHost;

  const rows = game.seats.map((s, i) => {
    if (!s.joined) {
      return `<div class="roster-row">
        <span class="seat-pip empty">${i + 1}</span>
        <span class="roster-name empty">waiting\u2026</span>
        <span class="badge quiet">Open</span>
      </div>`;
    }
    const deals = s.idx === game.dealerStart;
    return `<div class="roster-row">
      <span class="seat-pip">${i + 1}</span>
      <span class="roster-name">${esc(s.name)}</span>
      ${s.idx === game.youIdx ? '<span class="badge">You</span>' : ""}
      ${deals ? '<span class="badge gold">Deals first</span>' : ""}
      ${host ? `
        <button class="mini" data-dealer="${s.idx}" ${deals ? "disabled" : ""}
          aria-label="${esc(s.name)} deals first" title="${esc(s.name)} deals first">Deal</button>
        <button class="mini" data-move="up" data-idx="${s.idx}" ${i === 0 ? "disabled" : ""}
          aria-label="Move ${esc(s.name)} earlier">\u2191</button>
        <button class="mini" data-move="down" data-idx="${s.idx}" ${i >= joined - 1 ? "disabled" : ""}
          aria-label="Move ${esc(s.name)} later">\u2193</button>` : ""}
    </div>`;
  }).join("");

  const orderNote = host
    ? `Put the list in the order you're sitting, clockwise. Round 1 is dealt by whoever has <b>Deals first</b>, and the deal moves one seat down the list each round.`
    : `Play goes down this list, clockwise. The deal starts with <b>Deals first</b> and moves one seat each round.`;

  return `
  <div class="panel">
    <div class="qr-wrap"><div class="qr">${qrSvg(link, { light:"#ffffff", dark:"#141020" })}</div></div>
    <div class="code-hero">
      <div class="kicker">Point a camera at it, or type the code</div>
      <div class="code num">${esc(game.code)}</div>
      <div class="hint">Anyone with the link can join an open seat.</div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" id="copy-link">Copy link</button>
      ${navigator.share ? '<button class="btn btn-ghost" id="share-link">Share</button>' : ""}
    </div>
    <p class="lede-sub" style="margin-top:10px;font-size:.8rem">${esc(link)}</p>
  </div>

  <div class="panel">
    <div class="panel-title">${joined} of ${game.seats.length} seats \u00b7 deal order</div>
    <div class="roster">${rows}</div>
    <p class="opt-note">${orderNote}</p>
  </div>

  <div class="panel">
    <div class="panel-title">House rules</div>
    ${optionGroup("Scoring", SCORING_VARIANTS, rules().scoring, "scoring", host)}
    ${optionGroup("Bidding", BIDDING_VARIANTS, rules().bidding, "bidding", host)}
    <p class="opt-note" style="opacity:.75">${host
      ? "Tap one to read what it does. These are fixed once you deal \u2014 <b>Rules</b> up top has the full text."
      : "The scorekeeper sets these before the deal. <b>Rules</b> up top has the full text."}</p>
  </div>

  ${host ? `
  <div class="bar-spacer"></div>
  <div class="actionbar">
    <div class="tally"><span class="pill">${joined < 2 ? "At least two players have to join" : `${game.rounds} rounds \u00b7 ready when you are`}</span></div>
    <button class="btn" id="do-start" ${joined < 2 ? "disabled" : ""}>Start the game</button>
    <div class="conn"><span class="led"></span>${stale ? "Reconnecting" : "Live"}</div>
  </div>` : `
  <div class="panel">
    <div class="waiting"><span class="dot"></span>Waiting for the scorekeeper to start.</div>
    <div class="conn" style="justify-content:flex-start;padding-top:8px"><span class="led"></span>${stale ? "Reconnecting" : "Live"}</div>
  </div>`}`;
}

/* ---- scoreboard ---- */
function boardHTML(){
  const rows = standings();
  const byId = {}; rows.forEach((r) => { byId[r.idx] = r; });
  const last = game.history[game.history.length - 1] || null;
  const n = game.seats.length;
  const cols = n <= 4 ? 2 : 3;
  const size = cols === 2 ? "clamp(2.9rem, 14vw, 4.4rem)" : "clamp(2rem, 9.5vw, 3.2rem)";
  const tiles = game.seats.map((s) => {
    const row = byId[s.idx];
    const lead = row.rank === 1 && row.total > 0;
    let d = "", cls = "blank";
    if (last && typeof last.bids[s.idx] === "number") {
      const v = scoreRound(last.bids[s.idx], last.tricks[s.idx], last.cards);
      d = signed(v); cls = v >= 0 ? "up" : "down";
    }
    return `<div class="tile${lead?" leader":""}${s.idx===game.youIdx?" you":""}">
      ${s.idx === game.dealer && game.status === "playing" ? '<span class="tile-dealer" title="Dealer">D</span>' : ""}
      <span class="tile-name">${lead?CROWN:""}${esc(s.name)}</span>
      <span class="tile-score num" data-score-for="${s.idx}" data-value="${row.total}">${row.total}</span>
      <span class="tile-delta ${cls}">${d || "0"}</span>
    </div>`;
  }).join("");
  return `<div class="board" style="grid-template-columns:repeat(${cols},1fr);--score-size:${size}">${tiles}</div>`;
}

/* ---- play ---- */
function playHTML(){
  if (game.status === "done") return boardHTML() + winnerHTML() + historyHTML();
  return boardHTML() + roundHTML() + historyHTML();
}

function roundHTML(){
  const cards = game.cards;
  const dealer = game.seats[game.dealer];
  const first = game.seats[game.order[0]];
  const isBid = game.phase === "bid";
  const trumps = TRUMPS.map((t) => `
    <button class="trump${t.k==="N"?" none":""}" data-trump="${t.k}" data-red="${t.red?1:0}"
      aria-pressed="${game.trump===t.k}" title="${t.name}" aria-label="Trump: ${t.name}"
      ${game.isHost ? "" : "disabled"}>${t.glyph}</button>`).join("");

  const head = `
    <div class="round-head">
      <div>
        <div class="round-title">Round ${game.round}<span style="color:var(--ink-3);font-weight:600"> / ${game.rounds}</span></div>
        <div class="round-meta"><b>${cards} card${cards===1?"":"s"}</b> each · ${esc(dealer.name)} deals · ${esc(first.name)} bids first</div>
      </div>
      <div class="trumps" role="group" aria-label="Trump suit">${trumps}</div>
    </div>`;

  // Everyone sees who has bid what, in bid order.
  const roster = game.order.map((idx) => {
    const s = game.seats[idx];
    const b = game.bids[idx];
    const has = typeof b === "number";
    const placed = placedBids().includes(idx);
    const tags = [];
    if (idx === game.dealer) tags.push('<span class="badge quiet">Dealer</span>');
    if (idx === game.youIdx) tags.push('<span class="badge">You</span>');
    let right;
    // Under blind bidding the value is withheld until the last bid lands, so
    // a tick stands in for "they have bid, you just can't see what".
    if (isBid) right = `<span class="bid-chip ${placed?"in":""}">${has ? b : (placed ? "\u2713" : "\u2013")}</span>`;
    else {
      const k = game.tricks[idx];
      const hit = typeof k === "number" && k === b;
      right = `<span class="badge ${hit?"gold":"quiet"}">Bid ${b}</span>
               <span class="bid-chip ${typeof k==="number"?"in":""}">${typeof k==="number"?k:"–"}</span>`;
    }
    return `<div class="roster-row">
      <span class="seat-pip">${idx+1}</span>
      <span class="roster-name">${esc(s.name)}</span>${tags.join("")}${right}
    </div>`;
  }).join("");

  // In solo mode one device holds the whole table, so it enters every bid.
  let mine = "";
  if (isBid && solo) {
    mine = `<div class="panel"><div class="panel-title">Bids \u2014 ${bidsIn()} of ${game.seats.length} in</div>${
      game.order.map((idx) => {
        const picked = game.bids[idx];
        let chips = "";
        for (let v = 0; v <= cards; v++) {
          chips += `<button class="chip" data-forbid="${v}" data-idx="${idx}" aria-pressed="${picked === v}"
            aria-label="${esc(game.seats[idx].name)} bids ${v}">${v}</button>`;
        }
        return `<div class="entry">
          <div class="entry-head"><span class="entry-name">${esc(game.seats[idx].name)}</span>
            ${idx === game.dealer ? '<span class="badge quiet">Dealer</span>' : ""}</div>
          <div class="chips small">${chips}</div>
        </div>`;
      }).join("")}</div>`;
  } else if (isBid && game.youIdx !== null) {
    const picked = myBid();
    let chips = "";
    for (let v = 0; v <= cards; v++) {
      chips += `<button class="chip" data-mybid="${v}" aria-pressed="${picked===v}"
        aria-label="Bid ${v}">${v}</button>`;
    }
    mine = `<div class="panel your-turn">
      <div class="panel-title">${typeof picked === "number" ? "Your bid" : "Your bid — how many tricks will you take?"}</div>
      <div class="chips">${chips}</div>
      ${typeof picked === "number"
        ? '<p class="lede-sub" style="margin-top:10px;font-size:.82rem">Tap another number to change it, until the scorekeeper closes bidding.</p>'
        : ""}
    </div>`;
  }

  let hostPanel = "";
  if (game.isHost && !isBid) {
    hostPanel = game.order.map((idx) => {
      const s = game.seats[idx];
      const picked = game.tricks[idx];
      let chips = "";
      for (let v = 0; v <= cards; v++) {
        const on = picked === v;
        const exact = on && game.bids[idx] === v;
        chips += `<button class="chip${exact?" exact":""}" data-trick="${v}" data-idx="${idx}"
          aria-pressed="${on}" aria-label="${esc(s.name)}: ${v} tricks">${v}</button>`;
      }
      return `<div class="entry">
        <div class="entry-head"><span class="entry-name">${esc(s.name)}</span>
          <span class="badge ${picked===game.bids[idx]?"gold":"quiet"}">Bid ${game.bids[idx]}</span></div>
        <div class="chips small">${chips}</div>
      </div>`;
    }).join("");
    hostPanel = `<div class="panel"><div class="panel-title">Tricks taken</div>${hostPanel}</div>`;
  }

  // Host can fill in a bid for a player whose phone died.
  let fillIn = "";
  if (game.isHost && isBid && !solo && !allBidsIn()) {
    const missing = game.order.filter((i) => typeof game.bids[i] !== "number" && i !== game.youIdx);
    if (missing.length) {
      fillIn = `<details class="history"><summary>Enter a bid for someone</summary>
        <div style="padding:0 16px 14px">${missing.map((idx) => {
          let chips = "";
          for (let v = 0; v <= cards; v++) chips += `<button class="chip" data-forbid="${v}" data-idx="${idx}" aria-label="${esc(game.seats[idx].name)} bids ${v}">${v}</button>`;
          return `<div class="entry"><div class="entry-head"><span class="entry-name">${esc(game.seats[idx].name)}</span></div>
            <div class="chips small">${chips}</div></div>`;
        }).join("")}</div></details>`;
    }
  }

  let bar = "";
  if (isBid) {
    const pending = game.order.filter((i) => typeof game.bids[i] !== "number");
    const waiting = pending
      .sort((a, b) => (a === game.youIdx ? -1 : b === game.youIdx ? 1 : 0))
      .map((i) => (i === game.youIdx ? "you" : game.seats[i].name));
    const hookDiff = Object.values(game.bids).reduce((a,b)=>a+b,0) - cards;
    const blindPending = rules().bidding === "blind" && !allBidsIn();
    const status = blindPending
      ? `Bids are hidden \u2014 ${bidsIn()} of ${game.seats.length} in`
      : solo && !allBidsIn()
      ? `${bidsIn()} of ${game.seats.length} bids in`
      : allBidsIn()
      ? (hookDiff === 0
          ? `Bids total ${cards} — dead even, someone is going down`
          : `Bids total ${cards + hookDiff} of ${cards} — ${Math.abs(hookDiff)} ${hookDiff>0?"over":"under"}`)
      : `Waiting on ${waiting.slice(0,3).map(esc).join(", ")}${waiting.length>3?` +${waiting.length-3}`:""}`;
    bar = `<div class="actionbar">
      <div class="tally"><span class="pill${allBidsIn()&&hookDiff===0?" warn":""}">${status}</span></div>
      ${game.isHost
        ? `<button class="btn" id="to-tricks" ${allBidsIn()?"":"disabled"}>${allBidsIn()?"Close bidding — count the tricks →":"Every bid has to be in"}</button>`
        : `<div class="waiting" style="justify-content:center"><span class="dot"></span>${allBidsIn()?"All bids in — play the round":"Bidding"}</div>`}
      ${solo ? "" : `<div class="conn"><span class="led"></span>${stale?"Reconnecting":"Live"}</div>`}
    </div>`;
  } else {
    const sum = trickSum(), valid = tricksIn() === game.seats.length && sum === cards;
    const left = cards - sum;
    const text = valid ? `All ${cards} trick${cards===1?"":"s"} accounted for`
      : sum > cards ? `${sum} tricks entered — ${sum-cards} too many`
      : `${left} trick${left===1?"":"s"} still unassigned`;
    bar = `<div class="actionbar">
      ${game.isHost ? `<div class="tally"><span class="pill ${valid?"ok":(sum>cards?"warn":"")}">${text}</span></div>
        <button class="btn" id="do-score" ${valid?"":"disabled"}>${valid?`Score round ${game.round}`:`Tricks must total ${cards}`}</button>
        <button class="btn btn-ghost" id="back-bids">Back to bidding</button>`
        : `<div class="waiting" style="justify-content:center"><span class="dot"></span>The scorekeeper is counting tricks.</div>`}
      <div class="conn"><span class="led"></span>${stale?"Reconnecting":"Live"}</div>
    </div>`;
  }

  // Solo mode already lists every player in its own panels; repeating the
  // roster underneath is just the same names twice.
  const rosterBlock = solo ? "" : `<div class="roster">${roster}</div>`;
  return `${mine}<div class="panel">${head}${rosterBlock}</div>${fillIn}${hostPanel}<div class="bar-spacer"></div>${bar}`;
}

function winnerHTML(){
  const rows = standings();
  const top = rows.filter((r) => r.rank === 1);
  const who = top.length > 1 ? top.map((r) => r.name).join(" & ") + " tie" : top[0].name + " wins";
  return `<div class="panel winner">
    <div class="kicker">${game.rounds} rounds played</div>
    <div class="who">${esc(who)}</div>
    <div class="score-line num">${top[0].total} points · ${rows[top.length] ? esc(rows[top.length].name)+" "+rows[top.length].total : "clean sweep"}</div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn" id="btn-table-2">Show the table</button>
      ${game.isHost ? '<button class="btn btn-ghost" id="do-rematch">Rematch</button>' : ""}
    </div>
  </div>`;
}

function historyHTML(){
  const head = game.seats.map((s) => `<th>${esc(s.name)}</th>`).join("");
  const running = {}; game.seats.forEach((s) => { running[s.idx] = 0; });
  const body = game.history.map((r) => {
    const cells = game.seats.map((s) => {
      const b = r.bids[s.idx], k = r.tricks[s.idx], v = scoreRound(b, k, r.cards);
      running[s.idx] += v;
      return `<td><span class="cell-bid">${b} → ${k}</span><br>
        <span class="cell-delta num ${v>=0?"up":"down"}">${signed(v)}</span></td>`;
    }).join("");
    const tr = TRUMPS.find((t) => t.k === r.trump);
    return `<tr><td class="rnd"><b>R${r.round}</b>
      <span style="color:var(--ink-3)">${r.cards}c${tr?" "+(tr.k==="N"?"—":tr.glyph):""}</span></td>${cells}</tr>`;
  }).join("");
  const totals = game.seats.map((s) => `<td class="num" style="font-weight:900">${running[s.idx]}</td>`).join("");
  const inner = game.history.length
    ? `<div class="scroll-x"><table class="log">
         <thead><tr><th class="rnd">Round</th>${head}</tr></thead>
         <tbody>${body}</tbody>
         <tfoot><tr><td class="rnd" style="font-weight:800">Total</td>${totals}</tr></tfoot>
       </table></div>
       ${game.isHost ? `<div class="history-foot"><button class="btn btn-ghost" id="do-undo">Undo round ${game.history[game.history.length-1].round}</button></div>` : ""}`
    : '<p class="empty">Nothing scored yet. Finish round 1 and it lands here.</p>';
  return `<details class="history"><summary>Round log · ${game.history.length} scored</summary>${inner}</details>`;
}

/* ------------------------------ wiring ------------------------------ */
function wire(){
  const r = $("btn-rules"); if (r) r.onclick = openRules;
  const t = $("btn-table"); if (t) t.onclick = openTable;
  const l = $("btn-leave"); if (l) l.onclick = leave;

  const main = $("main");

  main.oninput = (e) => {
    const el = e.target;
    if (el.id === "host-name") setupDraft.name = el.value;
    if (el.id === "join-name") joinDraft.name = el.value;
    if (el.id === "join-code") { joinDraft.code = el.value.toUpperCase(); el.value = joinDraft.code; }
    if (el.dataset.seatName !== undefined) setupDraft.names[Number(el.dataset.seatName)] = el.value;
  };

  main.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;

    // --- home ---
    if (b.id === "s-minus" || b.id === "s-plus") {
      setupDraft.seats = Math.max(2, Math.min(8, setupDraft.seats + (b.id === "s-plus" ? 1 : -1)));
      setupDraft.rounds = null;
      return render();
    }
    if (b.id === "r-minus" || b.id === "r-plus") {
      const cur = setupDraft.rounds ?? (ROUNDS_FOR[setupDraft.seats] || 15);
      setupDraft.rounds = Math.max(1, Math.min(20, cur + (b.id === "r-plus" ? 1 : -1)));
      return render();
    }
    if (b.id === "do-create") return whileBusy("do-create", "Starting\u2026", create);
    if (b.id === "do-join")  return whileBusy("do-join", "Joining\u2026", join);

    // --- lobby ---
    if (b.id === "copy-link") {
      const link = `${location.origin}${location.pathname}?g=${game.code}`;
      try { await navigator.clipboard.writeText(link); toast("Link copied"); }
      catch { toast(link); }
      return;
    }
    if (b.id === "share-link") {
      try { await navigator.share({ title:"Wizard", text:`Join my Wizard game — code ${game.code}`, url:`${location.origin}${location.pathname}?g=${game.code}` }); } catch {}
      return;
    }
    if (b.id === "do-start") return act({ action:"start" });
    if (b.dataset.scoring) {
      const scoring = b.dataset.scoring;
      return optimistic((g) => { g.settings = { ...g.settings, scoring }; }, { action:"settings", scoring });
    }
    if (b.dataset.bidding) {
      const bidding = b.dataset.bidding;
      return optimistic((g) => { g.settings = { ...g.settings, bidding }; }, { action:"settings", bidding });
    }
    if (b.dataset.dealer !== undefined) {
      const idx = Number(b.dataset.dealer);
      return optimistic((g) => { g.dealerStart = idx; }, { action:"dealerStart", idx });
    }
    if (b.dataset.move) {
      const idx = Number(b.dataset.idx);
      const order = game.seats.filter((s) => s.joined).map((s) => s.idx);
      const at = order.indexOf(idx), to = at + (b.dataset.move === "up" ? -1 : 1);
      if (at < 0 || to < 0 || to >= order.length) return;
      order.splice(to, 0, order.splice(at, 1)[0]);
      return optimistic((g) => {
        // Mirror what the server will do, so the row moves under the thumb.
        const moved = order.map((old) => g.seats[old]);
        const empties = g.seats.filter((x) => !x.joined);
        const dealerAt = order.indexOf(g.dealerStart);
        const youAt = g.youIdx === null ? -1 : order.indexOf(g.youIdx);
        g.seats = [...moved, ...empties].map((x, i) => ({ ...x, idx: i }));
        g.dealerStart = dealerAt === -1 ? 0 : dealerAt;
        if (youAt !== -1) g.youIdx = youAt;
      }, { action:"reorder", order });
    }

    // --- play ---
    if (b.dataset.mybid !== undefined) {
      const v = Number(b.dataset.mybid), idx = game.youIdx;
      if (myBid() === v) return optimistic((g) => { delete g.bids[idx]; }, { action:"clearBid", idx });
      return optimistic((g) => { g.bids[idx] = v; }, { action:"bid", idx, value: v });
    }
    if (b.dataset.forbid !== undefined) {
      const v = Number(b.dataset.forbid), idx = Number(b.dataset.idx);
      return optimistic((g) => { g.bids[idx] = v; }, { action:"bid", idx, value: v });
    }
    if (b.dataset.trick !== undefined) {
      const v = Number(b.dataset.trick), idx = Number(b.dataset.idx);
      return optimistic((g) => { g.tricks[idx] = v; }, { action:"setTrick", idx, value: v });
    }
    if (b.dataset.trump) {
      const trump = game.trump === b.dataset.trump ? null : b.dataset.trump;
      return optimistic((g) => { g.trump = trump; }, { action:"trump", trump });
    }
    if (b.id === "to-tricks")  return act({ action:"toTricks" });
    if (b.id === "back-bids")  return act({ action:"backToBids" });
    if (b.id === "do-score")   return act({ action:"score" });
    if (b.id === "do-undo")    return act({ action:"undo" });
    if (b.id === "do-rematch") return act({ action:"rematch" });
    if (b.id === "btn-table-2") return openTable();
  };
}

async function act(body){
  if (!session) return;
  writesInFlight++;
  let data = null;
  try {
    data = await api({ ...body, code: session.code, hostKey: session.hostKey, seatKey: session.seatKey });
  } finally {
    writesInFlight--;
  }
  // The reply already carries the new board, so there is nothing to poll for.
  // Clearing the etag just makes the next scheduled poll a full read.
  etag = null;
  if (data) adopt({ game: data.game });
  else poll();   // the write was refused: drop our optimistic guess for the truth
}

/**
 * Draw a tap immediately, then send it. Waiting for a round trip before
 * drawing is what made bidding feel laggy once the backend stopped being
 * a laptop on the same Wi-Fi.
 */
function optimistic(apply, body){
  if (game) { apply(game); render(); }
  return act(body);
}

async function create(){
  if (solo) return createSolo();
  const data = await api({
    action:"create",
    name: setupDraft.name,
    clientId: clientId(),
    seatCount: setupDraft.seats,
    ...(setupDraft.rounds === null ? {} : { rounds: setupDraft.rounds }),
  });
  if (!data) return;
  saveSession({ code:data.code, hostKey:data.hostKey, seatKey:data.seatKey, seatIdx:data.seatIdx });
  etag = null; adopt({ game:data.game });
  history.replaceState(null, "", `?g=${data.code}`);
  startPolling();
}

/** With no server there is nobody to wait for: seat everyone and deal. */
async function createSolo(){
  const names = Array.from({ length: setupDraft.seats }, (_, i) =>
    (setupDraft.names[i] || "").trim() || `Player ${i + 1}`);
  const made = await api({
    action:"create", name:names[0], clientId: clientId(), seatCount:setupDraft.seats,
    ...(setupDraft.rounds === null ? {} : { rounds: setupDraft.rounds }),
  });
  if (!made) return;
  for (let i = 1; i < names.length; i++) {
    if (!await api({ action:"join", code: made.code, name: names[i] })) return;
  }
  const started = await api({ action:"start", code: made.code, hostKey: made.hostKey });
  if (!started) return;
  saveSession({ code: made.code, hostKey: made.hostKey, seatKey: made.seatKey, seatIdx: 0 });
  etag = null;
  adopt({ game: started.game });
  history.replaceState(null, "", `?g=${made.code}`);
}

/** Hold a button down for the length of its request so a second tap can't fire. */
async function whileBusy(id, label, run){
  const btn = $(id);
  if (btn && btn.disabled) return;
  const was = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { return await run(); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; } }
}

async function join(){
  const code = (joinDraft.code || "").trim().toUpperCase();
  if (code.length !== 4) return toast("A game code is four letters.");
  const data = await api({ action:"join", code, name: joinDraft.name, clientId: clientId() });
  if (!data) return;
  saveSession({ code, seatKey:data.seatKey, seatIdx:data.seatIdx });
  etag = null; adopt({ game:data.game });
  history.replaceState(null, "", `?g=${code}`);
  startPolling();
}

function leave(){
  saveSession(null);
  game = null; etag = null; prevTotals = null;
  history.replaceState(null, "", location.pathname);
  render();
}

function animateTotals(){
  if (!prevTotals) return;
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll("[data-score-for]").forEach((node) => {
    const to = +node.dataset.value;
    const from = prevTotals[+node.dataset.scoreFor];
    if (typeof from !== "number" || from === to) return;
    node.classList.add("flash");
    const t0 = performance.now(), dur = 520;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      node.textContent = Math.round(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step); else node.textContent = to;
    };
    requestAnimationFrame(step);
  });
  prevTotals = null;
}

/* ------------------------------ overlays ------------------------------ */
function openTable(){
  const rows = standings();
  const size = rows.length <= 4 ? "clamp(3.2rem, 17vw, 6rem)" : "clamp(2.4rem, 13vw, 4.5rem)";
  const list = rows.map((r) => `<div class="big-row${r.rank===1?" leader":""}">
      <span class="big-rank num">${r.rank}</span>
      <span class="big-name">${esc(r.name)}</span>
      <span class="big-score num">${r.total}</span>
    </div>`).join("");
  const foot = game.status === "done"
    ? `Final scores after ${game.rounds} rounds`
    : `After round ${game.history.length} of ${game.rounds}`;
  const o = $("overlay-table");
  o.style.setProperty("--big-size", size);
  o.innerHTML = `<div class="overlay-head"><h2>Scores</h2>
      <button class="close-btn" id="close-table" aria-label="Close">✕</button></div>
    <div class="big-list">${list}</div><div class="overlay-foot">${esc(foot)}</div>`;
  o.hidden = false;
  $("close-table").onclick = () => { o.hidden = true; };
}

function openRules(){
  const o = $("overlay-rules");
  o.innerHTML = `<div class="overlay-head"><h2>How Wizard scores</h2>
      <button class="close-btn" id="close-rules" aria-label="Close">✕</button></div>
    <div class="prose">
      <h3>The bet</h3>
      <p>Before a round is played, every player calls exactly how many tricks they expect to take. Bidding starts to the dealer's left; the dealer bids last.</p>
      <h3>The payout</h3>
      <ul>
        <li><b>Hit your bid exactly:</b> <span class="rule-eq">20 + 10 × tricks bid</span>. A bid of 0 made is worth 20; a bid of 3 made is worth 50.</li>
        <li><b>Miss it:</b> <span class="rule-eq">−10 per trick off</span>, over or under.</li>
      </ul>
      <h3>The deal</h3>
      <p>Round 1 deals one card each and every round adds one, until the 60-card deck runs out — 20 rounds for three players, 15 for four, 12 for five, 10 for six. The deal moves one seat left each round.</p>
      <h3>House rules</h3>
      <p>The scorekeeper picks these before the deal, and they hold for the whole game. ${game ? "The one in use is marked." : ""}</p>
      <p><b>Scoring</b></p>
      <ul>${SCORING_VARIANTS.map((v) => `<li><b>${esc(v.name)}</b>${game && rules().scoring === v.key ? ' <span class="rule-eq">in use</span>' : ""} \u2014 ${esc(v.blurb)}</li>`).join("")}</ul>
      <p><b>Bidding</b></p>
      <ul>${BIDDING_VARIANTS.map((v) => `<li><b>${esc(v.name)}</b>${game && rules().bidding === v.key ? ' <span class="rule-eq">in use</span>' : ""} \u2014 ${esc(v.blurb)}</li>`).join("")}</ul>

      <h3>Who deals</h3>
      <p>Before starting, the scorekeeper arranges the list into the order everyone is sitting and marks who deals the first round. After that the deal moves one seat down the list each round, and bidding always begins to the dealer's left \u2014 so the dealer bids last.</p>

      <h3>Around the table</h3>
      <ul>
        <li>Everyone bids on their own phone. Bids show up for the whole table as they land, the way they do when you call them out loud.</li>
        <li>The <b>scorekeeper</b> — whoever started the game — sets trump, closes bidding, enters the tricks taken and scores the round.</li>
        <li>Tricks taken must total the cards dealt, so a round won't score until they do.</li>
        <li>Someone's phone died? The scorekeeper can enter a bid for them.</li>
        <li><b>Scores</b> fills the screen with names and totals — hold it up so the whole table can read it.</li>
      </ul>
    </div>`;
  o.hidden = false;
  $("close-rules").onclick = () => { o.hidden = true; };
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  $("overlay-table").hidden = true;
  $("overlay-rules").hidden = true;
});

/* ------------------------------ boot ------------------------------ */
(async function boot(){
  solo = await detectBackend();
  if (solo) await loadLocalBackend();

  const fromPath = location.pathname.match(/^\/g\/([A-Za-z0-9]{4})$/);
  const fromQuery = new URLSearchParams(location.search).get("g");
  const deepCode = (fromPath ? fromPath[1] : fromQuery || "").toUpperCase();

  session = loadSession();
  if (deepCode && (!session || session.code !== deepCode)) {
    // Arriving on someone else's invite: drop a stale session and prefill.
    session = null;
    joinDraft.code = deepCode;
  }
  render();
  if (session) {
    if (solo) { await poll_solo(); } else { startPolling(); poll(); }
  }
})();

/** Solo mode has no polling loop; a reload just re-reads the stored game. */
async function poll_solo(){
  const out = await localApi.handleGet(localApi.store, {
    code: session.code, hostKey: session.hostKey, seatKey: session.seatKey,
  });
  if (out.status !== 200) { saveSession(null); game = null; render(); return; }
  adopt(out.body);
}
