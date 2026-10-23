import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdEventTracker, parseRetryAfterMs } from "../AdEventTracker.js";

const BASE_URL = "https://gateway.test";
const TOKEN = "sealed-token-abc";

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}

function response(status: number, headers: Record<string, string> = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

function mockFetch(status = 201, headers: Record<string, string> = {}) {
  return vi.fn().mockImplementation(() => Promise.resolve(response(status, headers)));
}

function newTracker(extra: Partial<ConstructorParameters<typeof AdEventTracker>[0]> = {}) {
  return new AdEventTracker({ baseUrl: BASE_URL, trackingToken: TOKEN, ...extra });
}

describe("AdEventTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts to <baseUrl>/v1/tracking/event with the ad's token in x-tracking-token, and no API key", async () => {
    const send = mockFetch();
    globalThis.fetch = send;

    await newTracker().track({ type: "engagement_start" });

    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/v1/tracking/event`);
    expect(init.method).toBe("POST");
    expect(init.headers["x-tracking-token"]).toBe(TOKEN);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(init.headers).some((h) => /api-key|authorization/i.test(h))).toBe(false);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const send = mockFetch();
    globalThis.fetch = send;
    await new AdEventTracker({ baseUrl: `${BASE_URL}//`, trackingToken: TOKEN }).track({ type: "close" });
    expect(send.mock.calls[0][0]).toBe(`${BASE_URL}/v1/tracking/event`);
  });

  it("never puts the token in the URL", async () => {
    const send = mockFetch();
    globalThis.fetch = send;
    await newTracker().track({ type: "cta_click" });
    expect(String(send.mock.calls[0][0])).not.toContain(TOKEN);
    expect(String(send.mock.calls[0][0])).not.toContain("?");
  });

  it("fetch options: credentials omit, no-referrer, keepalive; and no sendBeacon fallback exists", async () => {
    const send = mockFetch();
    globalThis.fetch = send;
    const beacon = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    try {
      await newTracker().track({ type: "close", metadata: { elapsed: 3 } });
    } finally {
      vi.unstubAllGlobals();
    }
    const init = send.mock.calls[0][1];
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.keepalive).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
  });

  it("sends exactly eventId, eventType and metadata (no timestamp, creativeId or campaignId)", async () => {
    const send = mockFetch();
    globalThis.fetch = send;
    await newTracker().track({ type: "engagement_progress", metadata: { progress: 5, totalDuration: 15 } });

    const body = JSON.parse(send.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(["eventId", "eventType", "metadata"]);
    expect(body.eventType).toBe("engagement_progress");
    expect(body.metadata).toEqual({ progress: 5, totalDuration: 15 });
    expect(body.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("omits metadata from the JSON when the event carries none", async () => {
    const send = mockFetch();
    globalThis.fetch = send;
    await newTracker().track({ type: "cta_click" });
    expect(Object.keys(JSON.parse(send.mock.calls[0][1].body)).sort()).toEqual(["eventId", "eventType"]);
  });

  it("calls onEvent when provided", async () => {
    const onEvent = vi.fn();
    globalThis.fetch = mockFetch();
    const event = { type: "cta_click" as const };
    await newTracker({ onEvent }).track(event);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("fails silently on network errors", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    await expect(newTracker().track({ type: "engagement_start" })).resolves.toBeUndefined();

    expect(consoleWarn).toHaveBeenCalled();
    // the warning never includes the token
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(TOKEN);
  });

  it("relays a caller-supplied eventId verbatim on every call (no client-side dedup), and generates a fresh one when omitted", async () => {
    const send = mockFetch();
    globalThis.fetch = send;
    const tracker = newTracker();
    const eventWithId = { type: "engagement_complete" as const, eventId: "11111111-2222-3333-4444-555555555555" };

    // The same eventId twice: the SDK must not suppress the second call. Dedup is the server's job.
    await tracker.track(eventWithId);
    await tracker.track(eventWithId);
    await tracker.track({ type: "engagement_complete" });

    expect(send).toHaveBeenCalledTimes(3);
    const ids = send.mock.calls.map((call: unknown[]) => JSON.parse((call[1] as { body: string }).body).eventId as string);
    expect(ids[0]).toBe("11111111-2222-3333-4444-555555555555");
    expect(ids[1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(ids[2]).not.toBe("11111111-2222-3333-4444-555555555555");
    expect(ids[2].length).toBeGreaterThan(0);
  });

  describe("401: the ad's token is expired or invalid", () => {
    it("drops that ad's remaining events without a retry", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const send = mockFetch(401);
      globalThis.fetch = send;
      const tracker = newTracker();

      await tracker.track({ type: "engagement_start" });
      await tracker.track({ type: "engagement_progress" });
      await tracker.track({ type: "close" });

      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does not affect a tracker built with another ad's token", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = mockFetch(401);
      await newTracker().track({ type: "engagement_start" });

      const send = mockFetch();
      globalThis.fetch = send;
      await new AdEventTracker({ baseUrl: BASE_URL, trackingToken: "another-ad-token" }).track({ type: "engagement_start" });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("still calls onEvent for a dropped event", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = mockFetch(401);
      const onEvent = vi.fn();
      const tracker = newTracker({ onEvent });
      await tracker.track({ type: "engagement_start" });
      await tracker.track({ type: "close" });
      expect(onEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("429: honour Retry-After before the next send", () => {
    it("pauses for Retry-After seconds, sends nothing meanwhile, then resumes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
      const send = mockFetch(429, { "retry-after": "30" });
      globalThis.fetch = send;
      const tracker = newTracker();

      await tracker.track({ type: "engagement_progress" });
      expect(send).toHaveBeenCalledTimes(1);

      // Inside the window: dropped, not sent and not queued (never a tight loop).
      await tracker.track({ type: "engagement_progress" });
      vi.advanceTimersByTime(29_000);
      await tracker.track({ type: "engagement_progress" });
      expect(send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_001);
      await tracker.track({ type: "engagement_complete" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("accepts an HTTP-date Retry-After", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
      const send = mockFetch(429, { "retry-after": "Fri, 23 Oct 2026 12:01:00 GMT" });
      globalThis.fetch = send;
      const tracker = newTracker();

      await tracker.track({ type: "engagement_progress" });
      vi.advanceTimersByTime(59_000);
      await tracker.track({ type: "engagement_progress" });
      expect(send).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_500);
      await tracker.track({ type: "engagement_progress" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("falls back to a 60 s pause when Retry-After is missing", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
      const send = mockFetch(429);
      globalThis.fetch = send;
      const tracker = newTracker();
      await tracker.track({ type: "engagement_progress" });
      vi.advanceTimersByTime(59_000);
      await tracker.track({ type: "engagement_progress" });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe("parseRetryAfterMs", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    it("reads delta-seconds", () => expect(parseRetryAfterMs("12", now)).toBe(12_000));
    it("reads an HTTP-date", () => expect(parseRetryAfterMs("Fri, 23 Oct 2026 12:00:45 GMT", now)).toBe(45_000));
    it("clamps to between 1 s and 1 h", () => {
      expect(parseRetryAfterMs("0", now)).toBe(1_000);
      expect(parseRetryAfterMs("Fri, 23 Oct 2026 11:00:00 GMT", now)).toBe(1_000);
      expect(parseRetryAfterMs("999999", now)).toBe(3_600_000);
    });
    it("defaults to 60 s for a missing or unparseable value", () => {
      expect(parseRetryAfterMs(null, now)).toBe(60_000);
      expect(parseRetryAfterMs("", now)).toBe(60_000);
      expect(parseRetryAfterMs("soon", now)).toBe(60_000);
    });
  });
});
