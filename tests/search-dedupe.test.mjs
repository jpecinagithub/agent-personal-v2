// F3 T-V2-032 (dedupe part): strong identity, weak review grouping,
// distinct-posting non-merge, sent exclusion, pending equivalence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  strongKey, weakGroupKey, normalizeUrl, dedupeOffers, excludeSent,
  flagPendingEquivalence, canonicalId,
} from "../packages/shared/search-dedupe.mjs";

function offer(over = {}) {
  return {
    source: "greenhouse-catalog", ats: "greenhouse", tenant: "acme", postingId: "p-1",
    canonicalUrl: "https://example.test/jobs/p-1", applyUrl: "https://example.test/apply/p-1",
    title: "Finance Manager", company: "Acme Test Corp",
    location: { country: "ES", region: "La Rioja", city: "Logroño", raw: "Logroño", remote: false },
    workMode: "onsite", description: "Finance Manager with FP&A experience.",
    skills: ["FP&A"], salary: { published: false }, language: "en",
    sponsorship: "yes", relocation: "no", publishedAt: "2026-10-20T00:00:00Z",
    firstSeenAt: "2026-10-21T00:00:00Z", evidence: {},
    ...over,
  };
}

test("dedupe: strong key is ats+tenant+postingId, else a verified canonical URL", () => {
  assert.equal(strongKey(offer()), "ats:greenhouse|tenant:acme|posting:p-1");
  assert.equal(strongKey(offer({ postingId: "p-2" })), "ats:greenhouse|tenant:acme|posting:p-2");
  // Same canonical URL but NOT verified: no strong key.
  const unverified = offer({ ats: null, tenant: null, postingId: null });
  assert.equal(strongKey(unverified), null);
  const verified = offer({ ats: null, tenant: null, postingId: null, evidence: { canonicalVerified: true } });
  assert.equal(strongKey(verified), "url:https://example.test/jobs/p-1");
});

test("dedupe: tracking parameters are stripped, identifying parameters are kept", () => {
  assert.equal(
    normalizeUrl("https://Example.test/jobs/p-1?utm_source=newsletter&location=ES"),
    "https://example.test/jobs/p-1?location=ES",
  );
  assert.equal(normalizeUrl("https://example.test/jobs/p-1?gclid=abc"), "https://example.test/jobs/p-1");
  assert.equal(normalizeUrl("not a url"), null);
});

test("dedupe: same strong identity dedupes with provenance; relisting is a duplicate, not new", () => {
  const a = offer();
  const b = offer({ source: "lever-catalog", ats: "greenhouse", firstSeenAt: "2026-10-25T00:00:00Z" });
  const { unique, duplicates } = dedupeOffers([a, b]);
  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].canonicalId, "ats:greenhouse|tenant:acme|posting:p-1");
  assert.equal(duplicates[0].provenance.length, 2);
  assert.deepEqual(duplicates[0].provenance.map((p) => p.source), ["greenhouse-catalog", "lever-catalog"]);
});

test("dedupe: distinct postings are never merged — different location, different postingId", () => {
  const a = offer();
  const otherCity = offer({ postingId: "p-1", location: { country: "IE", region: "", city: "Dublin", raw: "Dublin", remote: false } });
  // Same postingId but a different tenant is a different posting.
  const otherTenant = offer({ tenant: "othercorp", postingId: "p-1" });
  const otherPosting = offer({ postingId: "p-2" });
  const { unique, duplicates } = dedupeOffers([a, otherCity, otherTenant, otherPosting]);
  // otherCity shares the strong key with a (same ats/tenant/postingId)
  // so it IS a strong duplicate; the other two are distinct.
  assert.equal(unique.length, 3);
  assert.equal(duplicates.length, 1);
  // And with a different postingId AND a different location, both
  // strong and weak keys differ: fully distinct.
  const far = offer({ postingId: "p-9", location: { country: "NL", region: "", city: "Amsterdam", raw: "Amsterdam", remote: false } });
  const r2 = dedupeOffers([a, far]);
  assert.equal(r2.unique.length, 2);
  assert.equal(r2.duplicates.length, 0);
  assert.notEqual(weakGroupKey(a), weakGroupKey(far));
});

test("dedupe: weak groups are for review only — identical company/title/location/description, different postingId", () => {
  const a = offer();
  const b = offer({ postingId: "p-2", source: "ashby-catalog" });
  const { unique, duplicates, uncertainGroups } = dedupeOffers([a, b]);
  assert.equal(unique.length, 2, "weak matches stay in unique");
  assert.equal(duplicates.length, 0, "weak matches are never duplicates");
  assert.equal(uncertainGroups.length, 1);
  assert.equal(uncertainGroups[0].offers.length, 2);
  assert.equal(weakGroupKey(a), weakGroupKey(b));
});

test("dedupe: excludeSent removes already-sent offers across sources; pending equivalence is flagged, never auto-sendable", () => {
  const a = offer();
  const b = offer({ postingId: "p-2" });
  const sent = excludeSent([a, b], ["ats:greenhouse|tenant:acme|posting:p-1"]);
  assert.equal(sent.kept.length, 1);
  assert.equal(sent.kept[0].postingId, "p-2");
  assert.equal(sent.excluded.length, 1);
  assert.equal(sent.excluded[0].reason, "already_sent");
  const { flagged, unflagged } = flagPendingEquivalence([a, b], [canonicalId(a)]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].pendingEquivalence, true);
  assert.equal(unflagged.length, 1);
  // Flagging does not remove the offer.
  assert.equal(flagged[0].postingId, "p-1");
});
