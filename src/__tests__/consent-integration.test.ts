import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdEventTracker } from "../AdEventTracker.js";
import { AdApiConsent, resetSharedConsentForTests } from "../consent.js";

const BASE_URL = "https://gateway.test";

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 201, headers: { get: () => null } });
}

/** One tracker per ad, each with its own token. */
function trackerFor(token: string): AdEventTracker {
  return new AdEventTracker({ baseUrl: BASE_URL, trackingToken: token });
}

const lastHeaders = (send: ReturnType<typeof vi.fn>) => send.mock.lastCall![1].headers as Record<string, string>;

describe("AdEventTracker consent header emission", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetSharedConsentForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSharedConsentForTests();
  });

  it("POST /v1/tracking/event carries no consent headers before any consent is set", async () => {
    const send = okFetch();
    globalThis.fetch = send;

    await trackerFor("tok-1").track({ type: "engagement_start" });

    expect(send.mock.lastCall![0]).toBe(`${BASE_URL}/v1/tracking/event`);
    const headers = lastHeaders(send);
    expect(headers["x-gdpr-applies"]).toBeUndefined();
    expect(headers["x-coppa-child-directed"]).toBeUndefined();
    expect(headers["x-gpc"]).toBeUndefined();
    expect(headers["x-consent-ad-personalization"]).toBeUndefined();
  });

  it("an SDK-wide AdApiConsent.set() rides on the event request next to the token", async () => {
    const send = okFetch();
    globalThis.fetch = send;
    AdApiConsent.set({ gdprApplies: true, personalizationAllowed: true });

    await trackerFor("tok-1").track({ type: "engagement_start" });

    const headers = lastHeaders(send);
    expect(headers["x-gdpr-applies"]).toBe("true");
    expect(headers["x-consent-ad-personalization"]).toBe("granted");
    expect(headers["x-tracking-token"]).toBe("tok-1");
  });

  it("D-4: a tracker created AFTER AdApiConsent.set() sends the same headers (consent is not per tracker)", async () => {
    const send = okFetch();
    globalThis.fetch = send;
    AdApiConsent.set({ childDirected: true, doNotSell: true });

    await trackerFor("first-ad").track({ type: "engagement_start" });
    const first = lastHeaders(send);
    await trackerFor("second-ad").track({ type: "engagement_start" });
    const second = lastHeaders(send);

    expect(second["x-coppa-child-directed"]).toBe("true");
    expect(second["x-consent-ad-personalization"]).toBe("denied");
    expect(second["x-tracking-token"]).toBe("second-ad");
    expect({ ...second, "x-tracking-token": "" }).toEqual({ ...first, "x-tracking-token": "" });
  });

  it("an existing tracker sees a later AdApiConsent.set(), and the latest decision replaces the last", async () => {
    const send = okFetch();
    globalThis.fetch = send;
    const tracker = trackerFor("tok-1");

    AdApiConsent.set({ gdprApplies: true });
    await tracker.track({ type: "engagement_start" });
    expect(lastHeaders(send)["x-gdpr-applies"]).toBe("true");

    AdApiConsent.set({ doNotSell: true });
    await tracker.track({ type: "engagement_progress" });
    expect(lastHeaders(send)["x-gdpr-applies"]).toBeUndefined();
    expect(lastHeaders(send)["x-consent-ad-personalization"]).toBe("denied");
  });

  it("a per-tracker setConsent() overrides the SDK-wide decision for that tracker only", async () => {
    const send = okFetch();
    globalThis.fetch = send;
    AdApiConsent.set({ gdprApplies: true });
    const overridden = trackerFor("tok-1");
    overridden.setConsent({ childDirected: true });

    await overridden.track({ type: "engagement_start" });
    expect(lastHeaders(send)["x-coppa-child-directed"]).toBe("true");
    expect(lastHeaders(send)["x-gdpr-applies"]).toBeUndefined();

    await trackerFor("tok-2").track({ type: "engagement_start" });
    expect(lastHeaders(send)["x-gdpr-applies"]).toBe("true");
    expect(lastHeaders(send)["x-coppa-child-directed"]).toBeUndefined();
  });

  it("the live GPC signal rides on /v1/tracking/event even without any consent call", async () => {
    vi.stubGlobal("navigator", { globalPrivacyControl: true });
    const send = okFetch();
    globalThis.fetch = send;

    await trackerFor("tok-1").track({ type: "engagement_start" });

    expect(lastHeaders(send)["x-gpc"]).toBe("true");
    expect(lastHeaders(send)["x-consent-ad-personalization"]).toBe("denied");
  });

  it("never sends the Sec-GPC spelling (fetch() cannot set Sec-* headers)", async () => {
    vi.stubGlobal("navigator", { globalPrivacyControl: true });
    const send = okFetch();
    globalThis.fetch = send;
    AdApiConsent.set({ gdprApplies: true, personalizationAllowed: true, childDirected: true, doNotSell: true });

    await trackerFor("tok-1").track({ type: "engagement_start" });

    expect(Object.keys(lastHeaders(send)).some((h) => h.toLowerCase().startsWith("sec-"))).toBe(false);
  });
});
