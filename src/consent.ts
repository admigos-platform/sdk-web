/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSENT RELAY — Ad-API Web SDK.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The SDK RELAYS consent; it never decides. `AdApiConsent.set()` stores exactly the
 * four documented `ConsentDecision` dimensions the integrator's own CMP has
 * already resolved — this mirrors the server's `ConsentDecision` shape
 * field-for-field. There is no compliance-flag evaluation, geo inference, or
 * any other policy logic in this file or anywhere in this SDK — this module's
 * only job is to turn four booleans into the header wire format the Ad-API
 * server's consent resolver defines, and back.
 *
 * ─── THE FIVE HEADERS (must match the server's canonical consent header list
 *     byte-for-byte — do not invent a sixth or rename one. They are repeated
 *     here as literals because this package has no runtime dependencies; it is
 *     a standalone browser package) ──────────────────────────────────────────
 *   - `x-gdpr-applies: true`               → gdprApplies
 *   - `x-coppa-child-directed: true`        → childDirected
 *   - `x-gpc: true`                         → doNotSell (GPC signal; web only)
 *   - `x-consent-ad-personalization: granted|denied` → personalizationAllowed
 *     ("granted") / doNotSell ("denied")
 *   - `x-consent-do-not-sell: true`         → doNotSell (independent channel, see below)
 *
 * `sec-gpc` is deliberately NEVER sent by this SDK even though the server
 * resolver accepts it: `Sec-*` is a forbidden header-name prefix under the
 * Fetch spec (reserved for the user agent itself) — `fetch()` cannot set it
 * from script. `x-gpc` is the server's documented fallback
 * spelling for exactly this case; it is the only spelling a web SDK can use.
 *
 * ─── doNotSell HAS ITS OWN WIRE CHANNEL ─────────────────────────────────────
 * Before `x-consent-do-not-sell` existed, the header protocol only had two
 * ways to assert `doNotSell: true`: the GPC header, or
 * `x-consent-ad-personalization: denied` — collapsing into "denied" also
 * zeroed out `personalizationAllowed` on the wire regardless of what was
 * actually stored for that field. An integrator whose CMP resolves the two
 * independently (e.g. "personalization granted, but the user separately
 * opted out of sale/share") had no way to express both bits without one
 * erasing the other.
 *
 * The SDK now handles this as follows (see `buildHeaders()`'s truth table below):
 *   - `doNotSell: true` AND `personalizationAllowed: true` (an affirmative
 *     grant) → send BOTH `x-consent-ad-personalization: granted` AND the new
 *     `x-consent-do-not-sell: true` header, independently. This is the fix —
 *     the grant is no longer silently dropped.
 *   - `doNotSell: true` and personalization was NOT (also) affirmatively
 *     granted (unset or explicitly refused — this SDK's `ResolvedConsent`
 *     cannot tell those two apart, see `setConsent()`'s own doc comment) →
 *     UNCHANGED, still collapses to `x-consent-ad-personalization: denied`.
 *     This remains correct: it is the only faithful
 *     transcoding available when there is no grant to protect, and the
 *     resulting over-inclusion (denied ⇒ doNotSell on the server too) is the
 *     safe, more-restrictive direction, not a compliance risk.
 * The server's handling of "denied" is unchanged — sending it alone (no new
 * header) still resolves `doNotSell: true` server-side exactly as before
 * (backward compatible).
 *
 * ─── GPC BEATS GRANTED, AND IS NEVER OVERRIDABLE DOWNWARD BY setConsent() ───
 * GPC is read live from `navigator.globalPrivacyControl` at header-build time
 * on every request — it is never written into, or overridable by, the stored
 * `setConsent()` state. A later `setConsent({ doNotSell: false })` call (e.g.
 * a stale/cached CMP grant) can therefore never suppress a live GPC signal;
 * GPC is checked FIRST in `buildHeaders()` and, when asserted, always wins —
 * matching the server's own GPC-beats-granted precedence. A manually-set
 * `doNotSell` (via `setConsent()`) does NOT get the same override power over
 * "granted" that GPC has — see the doNotSell section above for why that
 * asymmetry is intentional.
 *
 * ─── DEFAULT / "NO SIGNAL YET" BEHAVIOUR (documented decision) ──────────────
 * Before any consent has been set (`AdApiConsent.set()` or a tracker's `setConsent()`), and while GPC is not asserted,
 * `buildHeaders()` returns an EMPTY object — no headers at all, not four
 * explicit "false" values. This is a deliberate choice, not an oversight:
 * The server's consent resolver only asserts on the literal strings
 * `"1"`/`"true"` — every other value, including an explicit `"false"`,
 * resolves identically to the header being absent. Sending fabricated
 * "false" headers before the integrator has told this SDK anything would
 * therefore change nothing server-side (no-signal traffic is already
 * recorded as all four dimensions `false` on absence alone) while asserting a
 * negative this SDK hasn't actually observed. Omission is the more honest
 * wire representation of "unknown," and it is equivalent in server outcome.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Mirrors the server's `ConsentDecision` shape exactly, field-for-field. All
 * four optional here (the integrator's CMP may
 * not have resolved every dimension yet); each defaults to `false` on
 * `setConsent()`, matching the server resolver's own fail-closed
 * contract — an omitted key is "not asserted", never "left unchanged from a
 * previous call".
 */
export interface ConsentDecision {
  /** Is GDPR/ePrivacy in scope for this session. Never inferred — the
   *  integrator's CMP must say so explicitly. */
  gdprApplies?: boolean;
  /** Was ad personalization affirmatively consented to. */
  personalizationAllowed?: boolean;
  /** COPPA / child-directed traffic flag. */
  childDirected?: boolean;
  /** CCPA/CPRA "do not sell/share" opt-out. On web, ORed with the live GPC
   *  signal — see class doc. */
  doNotSell?: boolean;
}

/** Same four dimensions, always present, always strictly boolean — this
 *  SDK's internal resolved state once `setConsent()` has been called. */
interface ResolvedConsent {
  gdprApplies: boolean;
  personalizationAllowed: boolean;
  childDirected: boolean;
  doNotSell: boolean;
}

/**
 * Reads the browser's Global Privacy Control signal.
 * `navigator.globalPrivacyControl` is not in the standard TS DOM lib yet, so
 * it is read through an index-safe cast rather than widening the global
 * `Navigator` type. Read live on every call (not cached at construction) —
 * cheap, and makes no assumption that the signal can't change within a page
 * lifetime.
 */
export function isGpcAsserted(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}

export class ConsentManager {
  private stored: ResolvedConsent | null = null;

  /**
   * Stores the integrator's consent decision. Each call REPLACES the prior
   * one wholesale — mirrors the server resolver's own contract: any
   * omitted key resolves to `false`, not "unchanged from the previous call".
   * A partial `setConsent({ gdprApplies: true })` after a prior
   * `setConsent({ doNotSell: true })` does NOT leave `doNotSell` true.
   */
  setConsent(decision: ConsentDecision): void {
    this.stored = {
      gdprApplies: decision.gdprApplies === true,
      personalizationAllowed: decision.personalizationAllowed === true,
      childDirected: decision.childDirected === true,
      doNotSell: decision.doNotSell === true,
    };
  }

  /**
   * Builds the outbound consent headers for one request to `/v1/ad/match` or
   * `POST /v1/tracking/event`. See the module doc for the "no signal yet",
   * GPC-precedence, and doNotSell-channel rules this implements.
   *
   * TRUTH TABLE (gpc is the live `isGpcAsserted()` read; `stored.*` are the
   * last `setConsent()` call's resolved booleans, default false pre-call):
   *
   *   gpc | stored.doNotSell | stored.personalizationAllowed | → x-consent-ad-personalization | → x-consent-do-not-sell
   *   ----|-------------------|--------------------------------|----------------------------------|------------------------
   *   true | (any)            | (any)                          | "denied"                          | (never — rides x-gpc)
   *   false| true              | true                            | "granted"                         | "true"   ← independent doNotSell channel
   *   false| true              | false                           | "denied"                          | (absent — redundant)
   *   false| false             | true                            | "granted"                         | (absent)
   *   false| false             | false                           | (absent)                          | (absent)
   */
  buildHeaders(): Record<string, string> {
    const gpc = isGpcAsserted();

    if (this.stored === null && !gpc) {
      return {};
    }

    const headers: Record<string, string> = {};

    if (this.stored?.gdprApplies) {
      headers["x-gdpr-applies"] = "true";
    }
    if (this.stored?.childDirected) {
      headers["x-coppa-child-directed"] = "true";
    }
    // Live browser read — never stored, so `setConsent()` can never lower it.
    if (gpc) {
      headers["x-gpc"] = "true";
    }

    const explicitDoNotSell = this.stored?.doNotSell ?? false;
    const personalizationGranted = this.stored?.personalizationAllowed === true;

    if (gpc) {
      // GPC is a live browser-level override — always wins, never split
      // alongside a "granted" the way a manual doNotSell now can be. Its
      // doNotSell bit rides x-gpc alone; the new header would be redundant.
      headers["x-consent-ad-personalization"] = "denied";
    } else if (explicitDoNotSell && personalizationGranted) {
      // Both are independently true — send BOTH instead of
      // collapsing to "denied" and silently erasing the affirmative grant.
      headers["x-consent-ad-personalization"] = "granted";
      headers["x-consent-do-not-sell"] = "true";
    } else if (explicitDoNotSell) {
      // No affirmative grant to protect — collapsing into "denied" remains
      // the correct, safe transcoding (the only faithful one available).
      headers["x-consent-ad-personalization"] = "denied";
    } else if (personalizationGranted) {
      headers["x-consent-ad-personalization"] = "granted";
    }

    return headers;
  }
}

/**
 * The SDK-wide consent decision. Every `AdEventTracker` reads it, so ONE `AdApiConsent.set()` call
 * covers every ad shown afterwards. Without it, a tracker created for a new ad would start with no
 * decision and silently send no consent headers, which the server records as four `false` values.
 * A tracker only departs from it if the integrator calls that tracker's own `setConsent()`.
 */
let sharedConsent = new ConsentManager();

export const AdApiConsent = Object.freeze({
  /** Relays your CMP's decision for the whole page. Each call fully replaces the prior one. */
  set(decision: ConsentDecision): void {
    sharedConsent.setConsent(decision);
  },
});

/** Consent headers from the SDK-wide decision (plus the live GPC signal on web). */
export function sharedConsentHeaders(): Record<string, string> {
  return sharedConsent.buildHeaders();
}

/** Test seam, not exported from the package entry point: forget the SDK-wide decision. */
export function resetSharedConsentForTests(): void {
  sharedConsent = new ConsentManager();
}
