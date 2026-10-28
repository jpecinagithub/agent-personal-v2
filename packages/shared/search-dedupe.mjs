// Pliego F3 T-V2-032 (RF-V2-036, RF-V2-040, RF-V2-077): canonical
// identity and dedupe between sources, campaigns and profiles.
//
// Rules that must never be bent (03 §8):
// - Strong identity merges: ATS + tenant + postingId, or a VERIFIED
//   canonical URL. Nothing else merges.
// - Weak identity (normalised company + title + location + description
//   hash) groups POSSIBLE duplicates for REVIEW only. It never
//   removes an offer.
// - Same title, different location = distinct. Same title, different
//   postingId = distinct. A relisting (same strong identity, new
//   firstSeenAt) is a duplicate, not a new offer.
// - An already-sent offer stays excluded even when rediscovered from
//   another source or profile; a pending-equivalence offer is never
//   auto-sendable.
import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "gbraid", "wbraid", "fbclid", "mc_cid", "mc_eid",
  "igshid", "vero_id", "_ga", "yclid", "msclkid", "twclid", "li_fat_id",
]);

/**
 * Normalise a URL for identity: lowercase host, drop the fragment,
 * drop known tracking parameters only (parameters that identify a
 * posting, location or form version are KEPT), sort remaining params.
 * @param {string} url
 * @returns {string | null}
 */
export function normalizeUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
      .sort(([a, an], [b, bn]) => (a === b ? String(an).localeCompare(String(bn)) : a.localeCompare(b)));
    u.search = "";
    for (const [k, v] of kept) u.searchParams.append(k, v);
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

function normText(v) {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Normalise a company name: case, punctuation and legal suffixes stripped. */
export function normalizeCompany(company) {
  return normText(company)
    .replace(/[.,&]/g, " ")
    .replace(/\b(inc|ltd|llc|corp|corporation|company|co|s\.a\.|sa|sl|gmbh|bv|nv|plc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normTitle(title) {
  return normText(title).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
}

function normLocation(location) {
  if (!location || typeof location !== "object") return "";
  return [location.country, location.region, location.city].map((v) => normText(v)).filter(Boolean).join("|");
}

function descriptionHash(description) {
  const norm = normText(description).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/**
 * Strong identity, or null when there is none. ATS + tenant +
 * postingId wins; otherwise a canonical URL counts ONLY when the
 * offer carries evidence.canonicalVerified === true (an unverified
 * URL is not an identity — 03 §8: identity is verified, not assumed).
 * @param {any} offer
 * @returns {string | null}
 */
export function strongKey(offer) {
  if (!offer || typeof offer !== "object") return null;
  const ats = normText(offer.ats);
  const tenant = normText(offer.tenant);
  const postingId = normText(offer.postingId);
  if (ats && tenant && postingId) return `ats:${ats}|tenant:${tenant}|posting:${postingId}`;
  if (offer.evidence?.canonicalVerified === true) {
    const url = normalizeUrl(offer.canonicalUrl);
    if (url) return `url:${url}`;
  }
  return null;
}

/**
 * Weak grouping key for REVIEW only: normalised company + title +
 * location + description hash. Two offers sharing it are possible
 * duplicates, never automatically the same posting.
 * @param {any} offer
 * @returns {string}
 */
export function weakGroupKey(offer) {
  if (!offer || typeof offer !== "object") return "empty";
  return [
    normalizeCompany(offer.company),
    normTitle(offer.title),
    normLocation(offer.location),
    descriptionHash(offer.description),
  ].join("|");
}

/** The canonical id used for sent/pending checks: strong key, else normalised canonical URL. */
export function canonicalId(offer) {
  const strong = strongKey(offer);
  if (strong) return strong;
  const url = normalizeUrl(offer.canonicalUrl);
  return url ? `url:${url}` : null;
}

function provenanceOf(group) {
  return group.map((o) => ({
    source: o.source ?? null,
    ats: o.ats ?? null,
    tenant: o.tenant ?? null,
    postingId: o.postingId ?? null,
    canonicalUrl: o.canonicalUrl ?? null,
    applyUrl: o.applyUrl ?? null,
    firstSeenAt: o.firstSeenAt ?? null,
  }));
}

/**
 * Dedupe a list of offers.
 * - `unique`: one offer per strong identity (first occurrence wins),
 *   plus every offer without a strong identity (they are never merged
 *   on weak evidence).
 * - `duplicates`: every further offer sharing a strong identity, with
 *   its canonical id and the full provenance of its group.
 * - `uncertainGroups`: groups of unique offers sharing a weak key
 *   (same company/title/location/description, different postingId or
 *   no strong identity). They STAY in `unique`; the group exists only
 *   so a human can review them.
 * @param {any[]} offers
 * @returns {{unique: any[], duplicates: {offer: any, canonicalId: string, provenance: any[]}[], uncertainGroups: {key: string, offers: any[]}[]}}
 */
export function dedupeOffers(offers) {
  if (!Array.isArray(offers)) throw new Error("offers must be an array");
  const byStrong = new Map();
  const unique = [];
  const duplicates = [];
  for (const offer of offers) {
    const key = strongKey(offer);
    if (key && byStrong.has(key)) {
      byStrong.get(key).push(offer);
      duplicates.push({ offer, canonicalId: key, provenance: [] }); // filled below
    } else {
      if (key) byStrong.set(key, [offer]);
      unique.push(offer);
    }
  }
  for (const d of duplicates) {
    d.provenance = provenanceOf(byStrong.get(d.canonicalId) ?? []);
  }
  const byWeak = new Map();
  for (const offer of unique) {
    const key = weakGroupKey(offer);
    if (!byWeak.has(key)) byWeak.set(key, []);
    byWeak.get(key).push(offer);
  }
  const uncertainGroups = [...byWeak.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, offers: group }));
  return { unique, duplicates, uncertainGroups };
}

/**
 * Exclude already-sent offers. `sentCanonicalIds` holds canonical ids
 * (strong keys or normalised canonical URLs). Returns kept and
 * excluded offers separately; exclusion is by person + canonical
 * offer, across all sources and profiles.
 * @param {any[]} offers
 * @param {Iterable<string>} sentCanonicalIds
 * @returns {{kept: any[], excluded: {offer: any, canonicalId: string, reason: string}[]}}
 */
export function excludeSent(offers, sentCanonicalIds) {
  if (!Array.isArray(offers)) throw new Error("offers must be an array");
  const sent = new Set(sentCanonicalIds ?? []);
  const kept = [];
  const excluded = [];
  for (const offer of offers) {
    const id = canonicalId(offer);
    if (id && sent.has(id)) {
      excluded.push({ offer, canonicalId: id, reason: "already_sent" });
    } else {
      kept.push(offer);
    }
  }
  return { kept, excluded };
}

/**
 * Flag offers whose canonical id OR weak group key appears in a
 * pending-equivalence set. Flagged copies carry
 * `pendingEquivalence: true` and must never be auto-sent (RF-V2-077);
 * flagging never removes or merges them.
 * @param {any[]} offers
 * @param {Iterable<string>} pendingIds
 * @returns {{flagged: any[], unflagged: any[]}}
 */
export function flagPendingEquivalence(offers, pendingIds) {
  if (!Array.isArray(offers)) throw new Error("offers must be an array");
  const pending = new Set(pendingIds ?? []);
  const flagged = [];
  const unflagged = [];
  for (const offer of offers) {
    const id = canonicalId(offer);
    if ((id && pending.has(id)) || pending.has(weakGroupKey(offer))) {
      flagged.push({ ...offer, pendingEquivalence: true });
    } else {
      unflagged.push(offer);
    }
  }
  return { flagged, unflagged };
}
