// The client probes this on load: a reply means there's a backend and the game
// is multi-phone; a 404 means a static host and it falls back to one device.
// Without this endpoint a Vercel deployment would quietly serve the solo
// version, which is the whole thing we are deploying to avoid.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, server: "wizard" });
}
