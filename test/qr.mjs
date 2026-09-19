// Conformance test for the QR encoder.
//
// The fixture hashes were generated from output verified module-for-module
// against the `qrcode` npm package (all 8 mask patterns, versions 1-10,
// including automatic mask selection). Keeping them as hashes lets this run
// with no dependencies.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { qrMatrix, qrSvg } from "../public/qr.js";

const fixtures = JSON.parse(readFileSync(new URL("./qr-fixtures.json", import.meta.url)));
const digest = (m) =>
  createHash("sha256").update(m.cells.map((r) => r.map((v) => (v ? 1 : 0)).join("")).join("")).digest("hex").slice(0, 16);

let pass = 0; const fails = [];
for (const [label, fx] of Object.entries(fixtures)) {
  const auto = qrMatrix(fx.text);
  if (auto.size === fx.size) pass++; else fails.push(`${label}: size ${auto.size} want ${fx.size}`);
  if (auto.mask === fx.auto) pass++; else fails.push(`${label}: chose mask ${auto.mask} want ${fx.auto}`);
  for (const [mask, want] of Object.entries(fx.masks)) {
    const got = digest(qrMatrix(fx.text, { mask: Number(mask) }));
    if (got === want) pass++; else fails.push(`${label} mask ${mask}: ${got} want ${want}`);
  }
}

// The three finder patterns must be present and correctly shaped.
const { size, cells } = qrMatrix("http://192.168.1.37:3000/g/ABCD");
const finderOK = (r0, c0) => {
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const ring = r === 0 || r === 6 || c === 0 || c === 6;
    const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    if (cells[r0 + r][c0 + c] !== (ring || core)) return false;
  }
  return true;
};
for (const [name, r, c] of [["top-left",0,0],["top-right",0,size-7],["bottom-left",size-7,0]]) {
  if (finderOK(r, c)) pass++; else fails.push(`${name} finder pattern is malformed`);
}
// The module below the top-left finder's format strip is always dark.
if (cells[size - 8][8] === true) pass++; else fails.push("the always-dark module is not dark");

const svg = qrSvg("http://192.168.1.37:3000/g/ABCD");
if (svg.startsWith("<svg") && svg.includes("</svg>") && svg.includes("<path")) pass++;
else fails.push("qrSvg did not produce an svg");

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\n" + fails.join("\n")); process.exit(1); }
