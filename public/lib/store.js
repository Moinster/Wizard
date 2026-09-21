// Storage behind a two-call interface: read a game with its version tag, and
// write it back only if that tag still holds. The tag is what makes concurrent
// bids from several phones safe — a write that lost the race is rejected and
// the caller retries against fresh state.
//
// `read(code, ifNoneMatch)` answers one of three things:
//   null                        no game with that code
//   { unchanged: true, etag }   the caller's tag is still current
//   { data, etag }              the game, and the tag to write against
//
// The unchanged answer is what a polling phone gets nearly every time, so it
// has to be one round trip and it has to be consistent with the body it is
// standing in for. Asking for the tag and the body separately is what broke
// this before: the tag came back current while the body was a version behind.

const keyFor = (code) => `games/${code}.json`;

/** The store. Everything lives in this process and stops with it. */
export function memoryStore() {
  const rows = new Map();
  let seq = 0;
  return {
    name: "memory",
    async read(code, ifNoneMatch = null) {
      const row = rows.get(code);
      if (!row) return null;
      if (ifNoneMatch && row.etag === ifNoneMatch) return { unchanged: true, etag: row.etag };
      return { data: JSON.parse(row.body), etag: row.etag };
    },
    async fresh(code) {
      const row = rows.get(code);
      return row ? row.etag : null;
    },
    async write(code, data, etag) {
      const row = rows.get(code);
      if (etag === null) {
        if (row) return { ok: false }; // create-only: someone got there first
      } else if (!row || row.etag !== etag) {
        return { ok: false };
      }
      rows.set(code, { body: JSON.stringify(data), etag: `m${++seq}` });
      return { ok: true };
    },
  };
}

/**
 * Browser store, for running the whole game inside one device with no server
 * at all — which is what a static host (GitHub Pages) can offer. Same contract;
 * survives a reload because it writes through to localStorage.
 */
export function localStorageStore(prefix = "wizard.game.") {
  let seq = 0;
  const row = (code) => {
    try {
      const raw = localStorage.getItem(prefix + code);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };
  return {
    name: "localStorage",
    async read(code, ifNoneMatch = null) {
      const r = row(code);
      if (!r) return null;
      if (ifNoneMatch && r.etag === ifNoneMatch) return { unchanged: true, etag: r.etag };
      return { data: r.data, etag: r.etag };
    },
    async fresh(code) {
      const r = row(code);
      return r ? r.etag : null;
    },
    async write(code, data, etag) {
      const r = row(code);
      if (etag === null) {
        if (r) return { ok: false };
      } else if (!r || r.etag !== etag) {
        return { ok: false };
      }
      try {
        localStorage.setItem(prefix + code, JSON.stringify({ data, etag: `l${Date.now()}.${++seq}` }));
      } catch {
        return { ok: false }; // private window, or storage full
      }
      return { ok: true };
    },
  };
}

/**
 * Vercel Blob store, for a serverless deployment where nothing can be held in
 * process memory. Needs BLOB_READ_WRITE_TOKEN, which Vercel injects once a
 * Blob store is linked to the project.
 *
 * Three options here are load-bearing, and all three were wrong in production
 * because this talked to an SDK older than the API it was written against:
 *
 *   `useCache: false` reads from origin storage. Blob bodies are otherwise
 *   served through the CDN, which will hand back a copy from before the last
 *   write while the metadata already reports the new version — a current tag
 *   beside stale state, which makes the caller stop asking and looks to a
 *   player like the table froze.
 *
 *   `ifNoneMatch` turns the poll into a 304 with no body, which is the whole
 *   reason a phone can ask twice a second without costing anything.
 *
 *   `ifMatch` is the compare-and-swap. Without it every write is a blind
 *   overwrite, so two phones acting at the same moment silently lose one of
 *   the two. That is not a "tap it again" failure; nothing tells anyone.
 *
 * All three need @vercel/blob 2.x. The 0.27 line has none of them and ignores
 * unknown options rather than refusing them, so a version slip costs the lot
 * in silence — test/blob.mjs is what catches that now, by checking the fake it
 * tests against still matches the installed package's own type definitions.
 *
 * The import is a parameter so tests can drive this against that fake, and so
 * this module stays loadable in a browser, where the client only ever reaches
 * localStorageStore and never enters this function.
 */
/**
 * Public and private blobs live at different hosts, so a game written one way
 * cannot be read the other. Reads must be private (see read()), and a write
 * has to match its reads. Nothing else may see the token-guarded URL anyway;
 * the phones only ever talk to the API.
 */
const ACCESS = "private";

export function blobStore(loadBlob = () => import("@vercel/blob")) {
  return {
    name: "blob",

    async read(code, ifNoneMatch = null) {
      const { get, BlobNotFoundError } = await loadBlob();
      // Private, not public, and not for secrecy: in this SDK useCache:false
      // only adds cache=0 to the URL when the access is private. Ask for a
      // public blob and the option is dropped without a word, so every read
      // comes off the CDN -- seconds behind a write, and behind one's OWN
      // write, which is what kept a lone host's Start busy for a full budget
      // and made the other phones wait half a minute to see it.
      const ask = () => get(keyFor(code), {
        access: ACCESS,
        useCache: false,
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
      });

      // Reads fail transiently in two ways, and both used to reach the player.
      // They die mid-connection with ECONNRESET; and, because an origin read
      // bypasses the CDN, the store RATE LIMITS them and answers 403 once a
      // burst gets hot enough — which is exactly what a table bidding at once
      // produces. Neither means anything is wrong with the game, so both are
      // backed off and retried here instead of becoming "something broke".
      //
      // Only after that does the error go up: the API has to answer a read it could not
      // make with a 500, never with the 404 that tells a player their game is
      // gone and clears it off their phone.
      let last = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        // 150, 400, 900ms-ish: long enough to outlast a shedding window.
        if (attempt > 0) await pause(150 * 2.4 ** (attempt - 1) * (0.7 + 0.6 * Math.random()));
        try {
          const res = await ask();
          // get() reports an absent blob by RETURNING null, not by throwing --
          // its signature says so, and missing this is what made a mistyped
          // join code answer 500 instead of "no game with that code". A throw
          // is still handled below, in case a later version prefers one.
          if (!res) return null;
          if (res.statusCode === 304) {
            // A 304 carries no body and, in this SDK, sometimes no etag header
            // either. The caller's tag is the one that matched, so it is the
            // current one; handing back "" would make the phone drop its tag
            // and fetch the whole game on every poll.
            return { unchanged: true, etag: res.blob.etag || ifNoneMatch };
          }
          const body = await new Response(res.stream).text();
          return { data: JSON.parse(body), etag: res.blob.etag };
        } catch (err) {
          if (isMissing(err, BlobNotFoundError)) return null;
          last = err;
          if (!isTransient(err)) break;
        }
      }
      throw last;
    },

    /**
     * The version the store will actually check a write against. head() goes
     * to the API and is current at once; a body read from origin can lag a
     * write by seconds, and a phone that trusts the lagging read burns its
     * whole budget writing against a version that is already gone.
     */
    async fresh(code) {
      const { head } = await loadBlob();
      try {
        const meta = await head(keyFor(code));
        return meta.etag || null;
      } catch (err) {
        if (isMissing(err, null)) return null;
        throw err;
      }
    },

    async write(code, data, etag) {
      const { put } = await loadBlob();
      try {
        await put(keyFor(code), JSON.stringify(data), {
          access: ACCESS,
          addRandomSuffix: false,
          allowOverwrite: etag !== null,
          contentType: "application/json",
          ...(etag ? { ifMatch: etag } : {}),
        });
        return { ok: true };
      } catch (err) {
        // A precondition failure means another phone wrote first, and the
        // caller retries. Anything else is a real fault and should surface.
        if (isConflict(err)) return { ok: false };
        throw err;
      }
    },
  };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Worth trying again. A 403 here is the store shedding load from origin reads,
 * not a permissions problem — the same token read the same key a moment ago.
 * 429 and 5xx are the same story, and a connection that dies mid-read is too.
 */
function isTransient(err) {
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 403 || status === 429 || (status >= 500 && status < 600)) return true;
  const text = String(err.message || "") + " " + String((err.cause && err.cause.message) || "");
  return /(\b403\b|\b429\b|forbidden|too many requests|rate limit)/i.test(text)
    || /econnreset|etimedout|socket hang up|fetch failed/i.test(text);
}

/** No blob under that key — the one error that means "no game", not "broken". */
function isMissing(err, BlobNotFoundError) {
  if (!err) return false;
  if (typeof BlobNotFoundError === "function" && err instanceof BlobNotFoundError) return true;
  if ((err.status || err.statusCode) === 404) return true;
  return err.name === "BlobNotFoundError";
}

function isConflict(err) {
  const status = err && (err.status || err.statusCode);
  if (status === 412 || status === 409) return true;
  if (err && err.name === "BlobPreconditionFailedError") return true;
  const text = String((err && err.message) || "").toLowerCase();
  return text.includes("precondition") || text.includes("already exists") || text.includes("conflict");
}

/** The store a serverless deployment should use, or null if none is configured. */
export function defaultStore() {
  return typeof process !== "undefined" && process.env && process.env.BLOB_READ_WRITE_TOKEN
    ? blobStore()
    : null;
}
