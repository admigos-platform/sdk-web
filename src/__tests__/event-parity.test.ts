import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AdEventTracker, type AdEvent, type AdEventType } from "../AdEventTracker.js";
import { AdPlayableView } from "../AdPlayableView.js";

// Event-schema parity across sdk-web, sdk-android and sdk-ios.
//
// The wire contract is what `tracking-service` accepts and rolls up (`POST /v1/tracking/event`):
// `eventType` in { engagement_start, engagement_progress, engagement_complete, cta_click } (the four
// rollup types) plus `close` (recorded, not rolled up), body keys { eventId, eventType, metadata }
// (the creative comes from the tracking token, so no creativeId and no client timestamp), metadata keys
// limited to the four integer measurement keys. Part A/B drive the real web code. Part C statically compares the Kotlin and Swift
// sources (they cannot be compiled or run here) and is skipped when the sibling SDK trees are absent
// (e.g. this package checked out on its own).

const WIRE_EVENT_TYPES: AdEventType[] = [
  "engagement_start",
  "engagement_progress",
  "engagement_complete",
  "close",
  "cta_click",
];
const WIRE_BODY_KEYS = ["eventId", "eventType", "metadata"];
const METADATA_KEYS = ["elapsed", "playDuration", "progress", "totalDuration"];

// ─── Part A: tracker wire shape ─────────────────────────────────────────────

describe("AdEventTracker wire shape", () => {
  beforeEach(() => vi.restoreAllMocks());

  async function trackedBody(event: AdEvent): Promise<Record<string, unknown>> {
    const tracker = new AdEventTracker({ baseUrl: "https://gateway.test", trackingToken: "t" });
    const send = vi.fn().mockResolvedValue({ ok: true, status: 201, headers: { get: () => null } });
    globalThis.fetch = send;
    await tracker.track(event);
    return JSON.parse((send.mock.calls[0][1] as { body: string }).body);
  }

  it("sends exactly the three body keys the SDK contract declares, for every wire event type", async () => {
    for (const type of WIRE_EVENT_TYPES) {
      const body = await trackedBody({ type, metadata: { progress: 5 } });
      expect(Object.keys(body).sort()).toEqual(WIRE_BODY_KEYS);
      expect(body.eventType).toBe(type);
    }
  });

  it("generates a lower-case UUID eventId when omitted (the shape the server's UUID pattern requires)", async () => {
    const body = await trackedBody({ type: "cta_click" });
    expect(body.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ─── Part B: the playable view emits the shared sequence ────────────────────

type Listener = () => void;
interface FakeEl {
  tagName: string;
  style: Record<string, string>;
  children: FakeEl[];
  parentNode: FakeEl | null;
  textContent?: string;
  listeners: Record<string, Listener[]>;
  setAttribute(n: string, v: string): void;
  addEventListener(t: string, l: Listener): void;
  removeEventListener(t: string, l: Listener): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  click(): void;
}
function el(tag: string): FakeEl {
  const e: FakeEl = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    parentNode: null,
    listeners: {},
    setAttribute() {},
    addEventListener(t, l) {
      (e.listeners[t] ||= []).push(l);
    },
    removeEventListener(t, l) {
      e.listeners[t] = (e.listeners[t] || []).filter((x) => x !== l);
    },
    appendChild(c) {
      c.parentNode = e;
      e.children.push(c);
      return c;
    },
    removeChild(c) {
      e.children = e.children.filter((x) => x !== c);
      c.parentNode = null;
      return c;
    },
    click() {
      [...(e.listeners.click || [])].forEach((l) => l());
    },
  };
  return e;
}

describe("AdPlayableView event sequence", () => {
  const g = globalThis as Record<string, unknown>;
  const origDoc = g.document;
  const tracker = { track: vi.fn() };

  function build() {
    const container = el("div");
    const view = new AdPlayableView().create({
      container: container as unknown as HTMLElement,
      bundleUrl: "https://bundles.example.test/b1/index.html",
      dimensions: "300x250",
      playDuration: 12,
      closeDelay: 3,
      eventTracker: tracker as never,
    });
    const wrapper = container.children[0];
    const buttons = wrapper.children.filter((c) => c.tagName === "BUTTON");
    // creation order in AdPlayableView: closeButton ("X") then ctaButton ("Learn More")
    const closeButton = buttons.find((b) => b.textContent === "X")!;
    const ctaButton = buttons.find((b) => b.textContent === "Learn More")!;
    return { view, closeButton, ctaButton };
  }
  const sent = () => tracker.track.mock.calls.map((c) => c[0] as AdEvent);

  beforeEach(() => {
    vi.useFakeTimers();
    tracker.track.mockClear();
    g.document = { createElement: (t: string) => el(t) };
  });
  afterEach(() => {
    vi.useRealTimers();
    g.document = origDoc;
  });

  it("start at create, a progress heartbeat every 5 elapsed seconds, then complete with playDuration", () => {
    build();
    expect(sent().map((e) => e.type)).toEqual(["engagement_start"]);
    expect(sent()[0].metadata).toEqual({ totalDuration: 12 });

    vi.advanceTimersByTime(12_000);
    const events = sent();
    expect(events.map((e) => e.type)).toEqual([
      "engagement_start",
      "engagement_progress",
      "engagement_progress",
      "engagement_complete",
    ]);
    expect(events[1].metadata).toEqual({ progress: 5, totalDuration: 12 });
    expect(events[2].metadata).toEqual({ progress: 10, totalDuration: 12 });
    expect(events[3].metadata).toEqual({ playDuration: 12 });
  });

  it("CTA tap emits cta_click with no metadata; early close emits close with elapsed and stops the sequence", () => {
    const { closeButton, ctaButton } = build();
    vi.advanceTimersByTime(7_000);
    ctaButton.click();
    closeButton.click();
    const events = sent();
    expect(events.at(-2)).toMatchObject({ type: "cta_click" });
    expect(events.at(-2)!.metadata).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "close", metadata: { elapsed: 7 } });

    const countAfterClose = sent().length;
    vi.advanceTimersByTime(20_000);
    expect(sent().length).toBe(countAfterClose); // no complete after an early close
  });

  it("every emitted type and metadata key is inside the shared vocabulary", () => {
    const { ctaButton, closeButton } = build();
    vi.advanceTimersByTime(12_000);
    ctaButton.click();
    closeButton.click();
    for (const e of sent()) {
      expect(WIRE_EVENT_TYPES).toContain(e.type);
      for (const key of Object.keys(e.metadata ?? {})) expect(METADATA_KEYS).toContain(key);
    }
    expect(new Set(sent().map((e) => e.type))).toEqual(new Set(WIRE_EVENT_TYPES));
  });
});

// ─── Part C: static cross-SDK parity (Kotlin and Swift cannot be compiled on a Linux CI host) ───

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const PATHS = {
  webView: root("sdk-web/src/AdPlayableView.ts"),
  ktView: root("sdk-android/src/main/java/org/adapi/sdk/AdPlayableView.kt"),
  ktTracker: root("sdk-android/src/main/java/org/adapi/sdk/AdEventTracker.kt"),
  swView: root("sdk-ios/Sources/AdAPI/AdPlayableView.swift"),
  swTracker: root("sdk-ios/Sources/AdAPI/AdEventTracker.swift"),
  serverService: root("tracking-service/src/services/tracking.service.ts"),
};
const haveSiblings = [PATHS.webView, PATHS.ktView, PATHS.ktTracker, PATHS.swView, PATHS.swTracker].every(existsSync);
const read = (p: string) => readFileSync(p, "utf8");
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const matchAll = (src: string, re: RegExp, group = 1) => [...src.matchAll(re)].map((m) => m[group]);

/** Used by the non-vacuity test below can run the production extractors on planted sources. */
const extract = {
  webTypes: (src: string) => sorted(matchAll(src, /\btype:\s*"([a-z_]+)"/g)),
  ktConstants: (src: string) => sorted(matchAll(src, /const val [A-Z_]+ = "([a-z_]+)"/g)),
  swConstants: (src: string) => sorted(matchAll(src, /static let [a-zA-Z]+ = "([a-z_]+)"/g)),
  ktUsed: (src: string) => sorted(matchAll(src, /AdEventType\.([A-Z_]+)/g)),
  swUsed: (src: string) => sorted(matchAll(src, /AdEventType\.([a-zA-Z]+)/g)),
  ktMetaKeys: (src: string) => sorted(matchAll(src, /"([A-Za-z]+)" to /g)),
  swMetaKeys: (src: string) => sorted(matchAll(src, /"([A-Za-z]+)": /g)),
  webMetaKeys: (src: string) =>
    sorted(
      matchAll(src, /metadata:\s*\{([^}]*)\}/g).flatMap((body) =>
        body.split(",").map((part) => part.trim().split(":")[0].trim()).filter(Boolean),
      ),
    ),
  ktBodyKeys: (src: string) => sorted(matchAll(src, /put\("([A-Za-z]+)"/g)),
  oldNativeNames: (src: string) => matchAll(src, /"(completed|closed|cta_clicked)"/g),
};

describe.skipIf(!haveSiblings)("cross-SDK event parity (static)", () => {
  const wire = sorted(WIRE_EVENT_TYPES);

  it("sdk-web emits exactly the shared event types", () => {
    expect(extract.webTypes(read(PATHS.webView))).toEqual(wire);
  });

  it("sdk-android declares and uses exactly the shared event types, and none of the retired names", () => {
    expect(extract.ktConstants(read(PATHS.ktTracker))).toEqual(wire);
    expect(extract.ktUsed(read(PATHS.ktView))).toEqual(
      ["CLOSE", "CTA_CLICK", "ENGAGEMENT_COMPLETE", "ENGAGEMENT_PROGRESS", "ENGAGEMENT_START"],
    );
    expect(extract.oldNativeNames(read(PATHS.ktView))).toEqual([]);
  });

  it("sdk-ios declares and uses exactly the shared event types, and none of the retired names", () => {
    expect(extract.swConstants(read(PATHS.swTracker))).toEqual(wire);
    expect(extract.swUsed(read(PATHS.swView))).toEqual(
      ["close", "ctaClick", "engagementComplete", "engagementProgress", "engagementStart"],
    );
    expect(extract.oldNativeNames(read(PATHS.swView))).toEqual([]);
  });

  it("all three SDKs attach the same metadata keys", () => {
    const web = extract.webMetaKeys(read(PATHS.webView));
    expect(web).toEqual(METADATA_KEYS);
    expect(extract.ktMetaKeys(read(PATHS.ktView))).toEqual(web);
    expect(extract.swMetaKeys(read(PATHS.swView))).toEqual(web);
  });

  it("sdk-android sends the same body key set as sdk-web; sdk-ios encodes the same property names", () => {
    expect(extract.ktBodyKeys(read(PATHS.ktTracker))).toEqual(WIRE_BODY_KEYS);
    const swEvent = read(PATHS.swTracker);
    for (const key of WIRE_BODY_KEYS) expect(swEvent).toMatch(new RegExp(`public let ${key}\\b`));
  });

  it("native AdEvent defaults eventId to a UUID and the tracker keeps the x-tracking-token + consent header path", () => {
    expect(read(PATHS.ktTracker)).toMatch(/val eventId: String = UUID\.randomUUID\(\)\.toString\(\)/);
    expect(read(PATHS.swTracker)).toMatch(/eventId: String = UUID\(\)\.uuidString\.lowercased\(\)/);
  });

  it("all three trackers drop on 401, honour Retry-After on 429, and read the SDK-wide consent (AdApiConsent)", () => {
    const web = read(root("sdk-web/src/AdEventTracker.ts"));
    const kt = read(PATHS.ktTracker);
    const sw = read(PATHS.swTracker);
    for (const [name, src] of [["web", web], ["android", kt], ["ios", sw]] as const) {
      expect(src, name).toMatch(/\b401\b/);
      expect(src, name).toMatch(/\b429\b/);
      expect(src, name).toMatch(/retry-after/i);
      expect(src, name).toMatch(/AdApiConsent|sharedConsentHeaders/);
      expect(src, name).toContain("/v1/tracking/event");
      expect(src, name).toContain("x-tracking-token");
    }
    // the same clamp on every platform: default 60 s, 1 s minimum, 1 h maximum
    expect(web).toMatch(/DEFAULT_RETRY_AFTER_MS = 60_000/);
    expect(kt).toMatch(/DEFAULT_MILLIS = 60_000L/);
    expect(sw).toMatch(/defaultSeconds: TimeInterval = 60/);
    expect(web).toMatch(/MAX_RETRY_AFTER_MS = 3_600_000/);
    expect(kt).toMatch(/MAX_MILLIS = 3_600_000L/);
    expect(sw).toMatch(/maxSeconds: TimeInterval = 3600/);
  });

  it.skipIf(!existsSync(PATHS.serverService))(
    "every shared event type is one tracking-service rolls up or knowingly records (`close`)",
    () => {
      const server = read(PATHS.serverService);
      const rollup = server.slice(server.indexOf("ENGAGEMENT_ROLLUP_EVENT_TYPES = new Set(["));
      const rollupBlock = rollup.slice(0, rollup.indexOf("]);"));
      const rollupTypes = matchAll(rollupBlock, /"([a-z_]+)"/g);
      expect(rollupTypes.length).toBe(4);
      expect(wire.filter((t) => !rollupTypes.includes(t))).toEqual(["close"]);
      expect(server).toMatch(/KNOWN_NON_ROLLUP_EVENT_TYPES = new Set\(\[[^\]]*"close"/);
    },
  );
});

describe("parity extractors are not vacuous", () => {
  it("flag a planted retired native event name and a planted extra event type", () => {
    expect(extract.oldNativeNames('eventType = "cta_clicked"')).toEqual(["cta_clicked"]);
    expect(extract.ktConstants('const val X = "engagement_start"\nconst val Y = "impression"')).toEqual([
      "engagement_start",
      "impression",
    ]);
    expect(extract.swUsed("AdEventType.engagementStart AdEventType.surprise")).toEqual([
      "engagementStart",
      "surprise",
    ]);
    expect(extract.webMetaKeys("metadata: { progress: elapsed, totalDuration: config.playDuration }")).toEqual([
      "progress",
      "totalDuration",
    ]);
  });
});
