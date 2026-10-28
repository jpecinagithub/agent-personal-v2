// T-V2-012: sequenced events + sanitizer.
// Payloads are sanitized recursively: any key matching a secret-like
// pattern is replaced, never stored. Sequence numbers come from the
// AUTOINCREMENT primary key, so replay from a seq is gap-free by construction.
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;

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

export function appendEvent(db, type, payload = {}) {
  const clean = sanitize(payload);
  const row = db.prepare("INSERT INTO events (type, payload_json) VALUES (?, ?) RETURNING seq").get(type, JSON.stringify(clean));
  return row.seq;
}

export function listEvents(db, sinceSeq = 0) {
  return db.prepare("SELECT seq, type, payload_json, created_at FROM events WHERE seq > ? ORDER BY seq ASC").all(sinceSeq).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
}
