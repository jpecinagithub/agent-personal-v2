// T-V2-013 (part 2): network guard + same-origin check for the control channel.
export const ALLOWED_HOSTS = new Set([
  "boards-api.greenhouse.io",
  "api.lever.co",
  "api.ashbyhq.com",
  "api.smartrecruiters.com",
  "api.x.ai",
]);

export function assertFetchHost(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("only https: URLs are allowed");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`host not allowed: ${url.hostname}`);
  return url;
}

// The private portal's control channel accepts requests with no Origin
// (same-origin server-side callers, curl) or an Origin exactly equal to
// the portal's own origin. Any foreign Origin is rejected.
export function isAllowedControlOrigin(origin, ownOrigin) {
  if (!origin) return true;
  return origin === ownOrigin;
}
