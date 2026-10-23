import { ConsentManager, sharedConsentHeaders, type ConsentDecision } from "./consent.js";

export interface AdApiSdkConfig {
  /**
   * The Ad-API gateway base URL: the same host you call `/v1/ad/match` on. The tracker posts to
   * `<baseUrl>/v1/tracking/event`. No API key is needed or accepted here; the ad's `trackingToken` is
   * the only credential this SDK holds.
   */
  baseUrl: string;
  /**
   * The `trackingToken` from this ad's `/v1/ad/match` response. Your server fetches the ad and passes
   * the token (and `trackingUrl`) to the page. One tracker per ad: the token is bound to that ad and
   * expires after an hour. Treat it as opaque. It travels only in the `x-tracking-token` header.
   */
  trackingToken: string;
  onEvent?: (event: AdEvent) => void;
}

/**
 * The wire `eventType` vocabulary, identical in all three Ad-API SDKs (web, Android, iOS), and the
 * only five values the ingest route accepts. The server rolls up `engagement_start`,
 * `engagement_progress`, `engagement_complete` and `cta_click`; `close` is accepted and recorded but
 * is not a rollup type. In shared event-name terms: `started` = `engagement_start`,
 * `completed` = `engagement_complete`, `closed` = `close`, `cta_clicked` = `cta_click`;
 * `engagement_progress` is the 5-second heartbeat. An impression is NOT an SDK event: the display
 * confirmation is `confirmRender(trackingUrl)`.
 */
export type AdEventType =
  | "engagement_start"
  | "engagement_progress"
  | "engagement_complete"
  | "close"
  | "cta_click";

export interface AdEvent {
  type: AdEventType;
  /**
   * Integer-valued measurement fields only, in seconds: `progress`, `totalDuration`, `playDuration`,
   * `elapsed`. The server drops any other key and any non-integer value, so never put an identifier
   * in here.
   */
  metadata?: Record<string, number>;
  /**
   * Optional caller-supplied id for THIS event; it must be a UUID. When omitted, `track()` generates
   * a fresh `crypto.randomUUID()` per call, which is what you want.
   *
   * If you supply one, it must be random and unique to this event. Never use a device, vendor,
   * advertising, install, session or user identifier: those are UUID-shaped and would pass the
   * check, and the server keeps one row per `eventId` per creative.
   *
   * Passing the same `eventId` for two calls marks them as "the same logical event". The server
   * de-duplicates on `eventId` per creative, so a retry that must collapse server-side has to send
   * the SAME `eventId` twice. This SDK performs NO client-side dedup, deliberately: two `track()`
   * calls with the same `eventId` both go out on the wire.
   */
  eventId?: string;
}

const DEFAULT_RETRY_AFTER_MS = 60_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * Parses a `Retry-After` header (delta-seconds or an HTTP-date) into a wait in milliseconds, clamped
 * to [1 s, 1 h]. A missing or unparseable value yields 60 s, so a 429 can never become a tight loop.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number {
  const raw = header?.trim();
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  let waitMs: number;
  if (/^\d+$/.test(raw)) {
    waitMs = Number(raw) * 1000;
  } else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_MS;
    waitMs = at - nowMs;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, waitMs));
}

export class AdEventTracker {
  private readonly endpoint: string;
  private readonly trackingToken: string;
  private readonly onEvent?: (event: AdEvent) => void;
  /** Set only by `tracker.setConsent()`; when null the SDK-wide decision (`AdApiConsent.set`) applies. */
  private ownConsent: ConsentManager | null = null;
  /** True once the server answered 401: this ad's token is expired or invalid, so nothing more is sent. */
  private tokenRejected = false;
  /** Epoch ms before which nothing is sent (set from a 429's `Retry-After`). */
  private pausedUntilMs = 0;

  constructor(config: AdApiSdkConfig) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/tracking/event`;
    this.trackingToken = config.trackingToken;
    this.onEvent = config.onEvent;
  }

  /**
   * Optional per-tracker override of the SDK-wide consent decision. Most integrators should call
   * `AdApiConsent.set()` once instead, which every tracker reads. Each call fully replaces the prior
   * decision for this tracker.
   */
  setConsent(decision: ConsentDecision): void {
    if (!this.ownConsent) this.ownConsent = new ConsentManager();
    this.ownConsent.setConsent(decision);
  }

  async track(event: AdEvent): Promise<void> {
    await this.send(event);

    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // ignore callback errors
      }
    }
  }

  private async send(event: AdEvent): Promise<void> {
    // 401: this ad's token is dead. 429: wait out Retry-After. Either way the event is dropped, not
    // queued or retried; engagement events are best effort.
    if (this.tokenRejected || Date.now() < this.pausedUntilMs) return;
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tracking-token": this.trackingToken,
          ...(this.ownConsent ? this.ownConsent.buildHeaders() : sharedConsentHeaders()),
        },
        // Exactly three fields: the ad, and so the creative, comes from the token. The page's own
        // cookies and URL never ride along.
        body: JSON.stringify({
          eventId: event.eventId ?? crypto.randomUUID(),
          eventType: event.type,
          metadata: event.metadata,
        }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        keepalive: true,
      });
      if (res.status === 401) {
        this.tokenRejected = true;
        console.warn("AdEventTracker: tracking token rejected (expired?); dropping this ad's remaining events");
      } else if (res.status === 429) {
        this.pausedUntilMs = Date.now() + parseRetryAfterMs(res.headers?.get("retry-after"), Date.now());
      }
    } catch (err) {
      console.warn("AdEventTracker: failed to track event", err);
    }
  }
}
