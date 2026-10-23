# @admigos/sdk-web

TypeScript SDK for embedding interactive playable HTML5 ads (self-contained ad bundles loaded into
a sandboxed `<iframe>`) in web pages, and for reporting the engagement events the Ad-API
platform uses for billing and analytics.

- Source, issues and releases: https://github.com/admigos-platform/sdk-web
- License: MIT

## Install

```bash
npm install @admigos/sdk-web
```

The package is ESM-only (`"type": "module"`) and ships its own TypeScript declarations. It is
written for browsers: it works with bundlers (Vite, webpack, esbuild, Rollup) and its relative
imports carry explicit `.js` extensions, so it also loads under Node's native ESM loader (for
example for server-side rendering imports). Calling it requires a DOM (`document`, `fetch`).

## Quickstart

Your **server** calls the Ad-API ad-match endpoint with your API key and hands the page the
ad. The response includes two fields the SDK needs: `trackingToken` (authenticates this ad's
engagement events; opaque, bound to this ad, expires after an hour) and `trackingUrl` (the render
beacon). Your API key never reaches the browser.

```typescript
import { AdApiConsent, AdEventTracker, AdPlayableView } from "@admigos/sdk-web";

// Once per page, with the decision your consent platform made (and again whenever it changes).
AdApiConsent.set({ gdprApplies: false, personalizationAllowed: true });

// One tracker per ad. `ad` is what your server passed to the page.
const tracker = new AdEventTracker({
  baseUrl: "<your Ad-API gateway URL>", // the same host you call ad-match on
  trackingToken: ad.trackingToken,
  onEvent: (event) => console.log("event", event),
});

const view = new AdPlayableView().create({
  container: document.getElementById("ad-container")!,
  bundleUrl: ad.bundleUrl,
  dimensions: "300x250", // WIDTHxHEIGHT
  playDuration: 30, // seconds
  closeDelay: 5, // seconds
  eventTracker: tracker,
  trackingUrl: ad.trackingUrl, // optional, see confirmRender
});

// later
view.destroy();
```

## API

Everything exported from the package entry point:

| Export | Kind | What it is |
|---|---|---|
| `AdEventTracker` | class | One per ad. `track(event)` reports an engagement event to `<baseUrl>/v1/tracking/event`, authenticated by that ad's `trackingToken`; `setConsent(decision)` is an optional per-tracker override of the SDK-wide consent. A 401 (expired token) drops that ad's remaining events; a 429 pauses sending until `Retry-After` has passed. Network failures are logged and swallowed; nothing throws into your page. |
| `AdApiConsent` | object | `AdApiConsent.set(decision)` relays your consent platform's decision for the whole page; every tracker, existing or created later, sends it. |
| `AdPlayableView` | class | `create(config)` builds the ad (sandboxed iframe, timer, close button, CTA button), drives the event lifecycle and returns `{ destroy }`. |
| `AdWebView` | class | The sandboxed iframe on its own (`sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`), for building your own overlay. |
| `AdClickHandler` | class | `openUrl(url)` opens a click-through destination (App Store / Play Store / web by user agent). It is not called automatically by the CTA button. |
| `confirmRender` | function | Fires the render beacon for a tracking URL once, when the ad actually begins to render. `AdPlayableView` does this for you when you pass `trackingUrl`; pass `autoConfirmRender: false` to call it yourself. |
| `isGpcAsserted` | function | Reads the browser's Global Privacy Control signal. |
| `AdApiSdkConfig`, `AdEvent`, `AdEventType`, `ConsentDecision` | types | Configuration, event (and its `type` union) and consent-decision shapes. |

The exact event `type` values and every field are in the bundled `.d.ts` files; they are the
contract, not this table.

## Consent

`AdApiConsent.set(decision)` relays a decision your own consent platform already made. The SDK
relays; it never decides. It is held SDK-wide, so one call covers every ad shown afterwards (each ad
has its own tracker).

```typescript
AdApiConsent.set({
  gdprApplies: true,
  personalizationAllowed: false,
  childDirected: false,
  doNotSell: true,
});
```

- All four fields are optional and each defaults to `false`; every call replaces the previous
  decision (it does not merge).
- The decision rides on `POST /v1/tracking/event` as request headers (`x-gdpr-applies`,
  `x-coppa-child-directed`, `x-consent-ad-personalization`, `x-consent-do-not-sell`). Send the same
  headers on your server's ad-match request.
- `tracker.setConsent(decision)` overrides the SDK-wide decision for that one tracker.
- The SDK reads `navigator.globalPrivacyControl` itself, on every request, and sends `x-gpc: true`
  whenever it is set. A later `set()` cannot override a live GPC signal.
- Before any consent has been set, and with no GPC signal, no consent headers are sent.
  **Not calling `AdApiConsent.set()` is not a protective default**: assert the restrictive signal
  (`gdprApplies: true`, `doNotSell: true`) before your consent platform answers whenever the session
  may be in scope, then replace it with the real decision.

## Privacy

The SDK stores nothing on the device (no cookies, no local storage). Each event request carries the
ad's tracking token, an event id (a random UUID), the event type and the integer `metadata` the SDK
measures; it sends no API key, no creative id and no client timestamp, and the request is made
without cookies and without a referrer. Leave `eventId` at its default: never set it, or `metadata`,
to an email, device id or any other identifier. Firing the render beacon and tracking events
makes the end user's device contact Ad-API; as the integrator you disclose that in your
own privacy notice.

## Issues

File issues in https://github.com/admigos-platform/sdk-web/issues.
