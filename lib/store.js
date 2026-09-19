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
