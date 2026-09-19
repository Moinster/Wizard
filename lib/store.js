// Storage behind a two-call interface: read a game with its version tag, and
// write it back only if that tag still holds. The tag is what makes concurrent
// bids from several phones safe — a write that lost the race is rejected and
// the caller retries against fresh state.

const keyFor = (code) => `games/${code}.json`;

/** In-memory store, for the test harness. Same contract as the Blob one. */
export function memoryStore() {
  const rows = new Map();
  let seq = 0;
  return {
    name: "memory",
    async read(code) {
      const row = rows.get(code);
      if (!row) return null;
      return { data: JSON.parse(row.body), etag: row.etag };
    },
    async etag(code) {
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
 * Vercel Blob store. Needs BLOB_READ_WRITE_TOKEN, which Vercel injects once a
 * Blob store is linked to the project.
 *
 * `ifMatch` gives us a real compare-and-swap. If the SDK in use doesn't report
 * an etag, `etag()` returns null, writes fall back to last-writer-wins, and the
 * worst case is a bid that has to be re-tapped — never a corrupted game.
 */
export function blobStore() {
  return {
    name: "blob",
    async read(code) {
      const { head } = await import("@vercel/blob");
      let meta;
      try {
        meta = await head(keyFor(code));
      } catch {
        return null; // BlobNotFoundError, and anything else that means "no game"
      }
      const res = await fetch(meta.url, { cache: "no-store" });
      if (!res.ok) return null;
      return { data: await res.json(), etag: meta.etag ?? null };
    },
    async etag(code) {
      const { head } = await import("@vercel/blob");
      try {
        const meta = await head(keyFor(code));
        return meta.etag ?? null;
      } catch {
        return null;
      }
    },
    async write(code, data, etag) {
      const { put } = await import("@vercel/blob");
      try {
        await put(keyFor(code), JSON.stringify(data), {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: etag !== null,
          contentType: "application/json",
          cacheControlMaxAge: 0,
          ...(etag ? { ifMatch: etag } : {}),
        });
        return { ok: true };
      } catch (err) {
        // A precondition failure means another phone wrote first: the caller
        // retries. Anything else is a real fault and should surface.
        if (isConflict(err)) return { ok: false };
        throw err;
      }
    },
  };
}

function isConflict(err) {
  const status = err && (err.status || err.statusCode);
  if (status === 412 || status === 409) return true;
  const text = String((err && err.message) || "").toLowerCase();
  return text.includes("precondition") || text.includes("already exists") || text.includes("conflict");
}

export function defaultStore() {
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStore() : null;
}
