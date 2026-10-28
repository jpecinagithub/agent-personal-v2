// T-V2-012: sequenced events + sanitizer + live publication.
// Payloads are sanitized recursively: any key matching a secret-like
// pattern is replaced, never stored. Sequence numbers come from the
// AUTOINCREMENT primary key, so replay from a seq is gap-free by construction.
// Live delivery: appendEvent notifies subscribers registered for the same
// database, so an SSE client connected before the event is appended
// receives it over the open connection; subscribers never receive events
// from a different database.
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;

/** @type {Map<object, Set<(event: {seq: number, type: string, payload: object}) => void>>} */
const subscribers = new Map();

export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitize(v);
    }
    return out;
  }
  return value;
}

/**
 * Subscribe to events appended to `db` after this call. Returns an
 * unsubscribe function. A listener that throws is dropped, never allowed
 * to break appendEvent for other subscribers.
 * @param {object} db
 * @param {(event: {seq: number, type: string, payload: object}) => void} listener
 * @returns {() => void}
 */
export function subscribe(db, listener) {
  let set = subscribers.get(db);
  if (!set) {
    set = new Set();
    subscribers.set(db, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) subscribers.delete(db);
  };
}

export function appendEvent(db, type, payload = {}) {
  const clean = sanitize(payload);
  const row = db.prepare("INSERT INTO events (type, payload_json) VALUES (?, ?) RETURNING seq").get(type, JSON.stringify(clean));
  const event = { seq: row.seq, type, payload: clean };
  const set = subscribers.get(db);
  if (set) {
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        set.delete(listener);
      }
    }
  }
  return row.seq;
}

export function listEvents(db, sinceSeq = 0) {
  return db.prepare("SELECT seq, type, payload_json, created_at FROM events WHERE seq > ? ORDER BY seq ASC").all(sinceSeq).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
}
