/**
 * Render beacon. Integrators fire the `trackingUrl` returned by `/v1/ad/match` from the device
 * (`GET /v1/ad/i/<token>`). While the platform's billing trigger is still the ad match, the beacon
 * only records the render time; billing on render is a later platform change.
 *
 * `confirmRender(trackingUrl)` tells Ad-API that the ad actually began to render on THIS
 * device. The caller decides the moment (for example the format's own start event); this helper only
 * guarantees "at most once, safely":
 *
 *   - one GET per URL per page lifetime (in-memory Set, added synchronously BEFORE dispatch);
 *   - the URL is opaque: it is fired unmodified (no query, fragment, header or cookie) and is
 *     never parsed, validated, logged or stored anywhere but that Set;
 *   - `fetch(..., { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", ... })`,
 *     `Image()` fallback; NOT `sendBeacon` (POST + credentials, unbilled);
 *   - the response is opaque and never read; no retry once the request resolves (the server
 *     answers 200 to every outcome), one retry only on a network rejection;
 *   - it reads no navigator/UA/language/screen/IP/consent state and writes no storage.
 *
 * It never throws and returns synchronously.
 */

/** Bounded so a long-lived page cannot grow the Set without limit. */
const MAX_FIRED = 256;

const fired = new Set<string>();

const FETCH_INIT = {
  method: "GET",
  mode: "no-cors",
  credentials: "omit",
  cache: "no-store",
  referrerPolicy: "no-referrer",
  keepalive: true,
} as const;

function viaImage(url: string): void {
  if (typeof Image !== "function") return;
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.src = url;
}

export function confirmRender(trackingUrl: string): void {
  try {
    if (typeof trackingUrl !== "string" || trackingUrl.length === 0) return;
    if (fired.has(trackingUrl)) return;

    fired.add(trackingUrl);
    if (fired.size > MAX_FIRED) {
      const oldest = fired.values().next().value;
      if (oldest !== undefined) fired.delete(oldest);
    }

    if (typeof fetch !== "function") {
      viaImage(trackingUrl);
      return;
    }

    const send = (): Promise<unknown> => fetch(trackingUrl, FETCH_INIT);
    // Resolved (opaque) response: done, never retried. Network rejection: one retry, then give up.
    send().catch(() => {
      try {
        send().catch(() => undefined);
      } catch {
        /* swallowed */
      }
    });
  } catch {
    /* never throws into the host page */
  }
}

/** Test seam only (not exported from index.ts). */
export function __resetRenderBeaconForTests(): void {
  fired.clear();
}
