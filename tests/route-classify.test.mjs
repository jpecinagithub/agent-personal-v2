// F4 T-V2-035 (RF-V2-041, RF-V2-042, RF-V2-043): inspection, route
// classification and ATS recognition. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectExtraction, classifyRoute, recogniseAts, analyseRoute,
  capabilityMatrixFor, detectPaywallSignals, ROUTE_KINDS,
} from "../packages/shared/route-classify.mjs";

const okExtraction = {
  status: "ok", url: "https://example.test/jobs/1", title: "Finance Manager",
  description: "A long enough description of the role and its requirements. ".repeat(10),
  language: "en", languageMethod: "local", evidence: { title: "html:h1", description: "html:main text" },
};

test("T-V2-035: a valid extraction inspects as an offer; blocked/insufficient/error are never offers", () => {
  assert.equal(inspectExtraction(okExtraction).isOffer, true);
  assert.equal(inspectExtraction(okExtraction).status, "offer");
  assert.equal(inspectExtraction({ status: "blocked", reason: "http_403" }).isOffer, false);
  assert.equal(inspectExtraction({ status: "blocked", reason: "http_403" }).status, "blocked");
  assert.equal(inspectExtraction({ status: "insufficient", reason: "insufficient_content" }).status, "insufficient");
  assert.equal(inspectExtraction({ status: "unavailable", reason: "http_500" }).status, "error");
  assert.equal(inspectExtraction({ status: "unavailable", reason: "http_500" }).isOffer, false);
  assert.equal(inspectExtraction(null).status, "error");
});

test("T-V2-035: paywall signals in page text report paywall, never a valid offer", () => {
  const pageText = "Subscribe to continue reading this exclusive job posting. ".repeat(5);
  assert.deepEqual(detectPaywallSignals(pageText), ["subscribe to continue"]);
  const inspected = inspectExtraction(okExtraction, { pageText });
  assert.equal(inspected.isOffer, false);
  assert.equal(inspected.status, "paywall");
});

test("T-V2-035: route classifier returns every pliego kind from observable signals", () => {
  assert.deepEqual(ROUTE_KINDS.sort(), ["access_registration", "aggregator_portal", "assisted", "direct_form", "email_application", "external_redirect", "process_with_tests", "wizard"].sort());
  const page = (text) => ({ url: "https://example.test/jobs/1", pageText: text });
  assert.equal(classifyRoute({ url: "https://example.test/jobs/1", applyUrl: "mailto:jobs@example.test" }).route, "email_application");
  assert.equal(classifyRoute(page("This role includes a Hackerrank coding challenge as a first stage.")).route, "process_with_tests");
  assert.equal(classifyRoute(page("Create an account to apply for this position.")).route, "access_registration");
  assert.equal(classifyRoute(page("Application form — Step 2 of 4. Please complete each step.")).route, "wizard");
  assert.equal(classifyRoute(page('<form action="/apply"><button>Apply now</button> Upload your CV below.</form>')).route, "direct_form");
  assert.equal(classifyRoute({ url: "https://www.linkedin.com/jobs/view/123", pageText: "A job page." }).route, "aggregator_portal");
  assert.equal(classifyRoute({ url: "https://example.test/jobs/1", redirectChain: ["https://example.test/jobs/1", "https://jobs.lever.co/acme/123"] }).route, "external_redirect");
  assert.equal(classifyRoute(page("A short generic page with no application signal.")).route, "assisted");
  assert.equal(classifyRoute(page('<form>Apply now</form> Please complete the recaptcha to continue.')).route, "assisted");
});

test("T-V2-035: ATS recognition is certified only on a strong host signal; title similarity never picks an adapter", () => {
  const gh = recogniseAts({ url: "https://boards.greenhouse.io/acme/jobs/1" });
  assert.equal(gh.ats, "greenhouse");
  assert.equal(gh.engine, "certified");
  assert.equal(gh.capabilityMatrix.engine, "certified");
  const lever = recogniseAts({ url: "https://jobs.lever.co/acme/123", applyUrl: "https://jobs.lever.co/acme/123/apply" });
  assert.equal(lever.ats, "lever");
  assert.equal(lever.tenant, "acme");
  assert.equal(lever.engine, "certified");
  // Title similarity alone: a role titled "Greenhouse Manager" on an
  // unknown host must NOT select the Greenhouse adapter.
  const titleOnly = recogniseAts({ url: "https://unknown-corp.example/careers/1", pageText: "Greenhouse Manager wanted. We use Greenhouse for hiring." });
  assert.equal(titleOnly.ats, "unknown");
  assert.equal(titleOnly.engine, "generic");
  assert.equal(titleOnly.capabilityMatrix.engine, "generic");
  // A recognised-but-uncertified ATS (Workday host) still runs generic.
  const workday = recogniseAts({ url: "https://acme.myworkdayjobs.com/en-US/careers/job/123" });
  assert.equal(workday.ats, "workday");
  assert.equal(workday.engine, "generic");
  // Unknown signature selects the generic engine, never an adapter.
  const unknown = recogniseAts({ url: "https://some-portal.example/jobs/9", pageText: "Apply here." });
  assert.equal(unknown.ats, "unknown");
  assert.equal(unknown.capabilityMatrix.ats, "unknown");
  assert.equal(capabilityMatrixFor("unknown").engine, "generic");
});

test("T-V2-035: analyseRoute combines inspection, route and ATS; a non-offer is never classified as a form route", () => {
  const analysed = analyseRoute({ extraction: okExtraction, url: "https://boards.greenhouse.io/acme/jobs/1", pageText: '<form>Apply now</form>' });
  assert.equal(analysed.inspection.isOffer, true);
  assert.equal(analysed.ats.ats, "greenhouse");
  assert.equal(analysed.route.route, "direct_form");
  const blocked = analyseRoute({ extraction: { status: "blocked", reason: "http_403" }, url: "https://example.test/jobs/1" });
  assert.equal(blocked.inspection.isOffer, false);
  assert.equal(blocked.route.route, "assisted");
});
