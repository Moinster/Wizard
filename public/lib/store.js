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
export function blobStore(loadBlob = () => import("@vercel/blob")) {
  return {
    name: "blob",

    async read(code, ifNoneMatch = null) {
      const { get, BlobNotFoundError } = await loadBlob();
      const ask = () => get(keyFor(code), {
        access: "public",
        useCache: false,
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
      });

      // Reads have been seen to die mid-connection with ECONNRESET. One retry,
      // and then the error goes up: the API has to answer a read it could not
      // make with a 500, never with the 404 that tells a player their game is
      // gone and clears it off their phone.
      let last = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await ask();
          if (res.statusCode === 304) return { unchanged: true, etag: res.blob.etag };
          const body = await new Response(res.stream).text();
          return { data: JSON.parse(body), etag: res.blob.etag };
        } catch (err) {
          if (isMissing(err, BlobNotFoundError)) return null;
          last = err;
        }
      }
      throw last;
    },

    async write(code, data, etag) {
      const { put } = await loadBlob();
      try {
        await put(keyFor(code), JSON.stringify(data), {
          access: "public",
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
