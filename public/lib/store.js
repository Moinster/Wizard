// Storage behind a two-call interface: read a game with its version tag, and
// write it back only if that tag still holds. The tag is what makes concurrent
// bids from several phones safe — a write that lost the race is rejected and
// the caller retries against fresh state.

const keyFor = (code) => `games/${code}.json`;

/** The store. Everything lives in this process and stops with it. */
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
    async read(code) {
      const r = row(code);
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async etag(code) {
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
