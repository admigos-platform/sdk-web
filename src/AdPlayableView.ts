import { AdWebView } from "./AdWebView.js";
import { AdEventTracker } from "./AdEventTracker.js";
import { confirmRender } from "./renderBeacon.js";

interface PlayableAdConfig {
  container: HTMLElement;
  bundleUrl: string;
  dimensions: string;
  playDuration: number;
  closeDelay: number;
  /** One tracker per ad, built with that ad's `trackingToken`. The creative comes from the token. */
  eventTracker: AdEventTracker;
  /**
   * The `/v1/ad/match` response's `trackingUrl` (the render-beacon URL). When set, the SDK fires it once on the bundle iframe's `load` (begin-to-render)
   * and only while the document is visible. It is never passed into the bundle. `engagement_start` is
   * analytics, not a render proof.
   */
  trackingUrl?: string;
  /** Default true. Set false to call `confirmRender(trackingUrl)` yourself at your own render moment. */
  autoConfirmRender?: boolean;
}

export class AdPlayableView {
  private adWebView: AdWebView;

  constructor() {
    this.adWebView = new AdWebView();
  }

  create(config: PlayableAdConfig): { destroy: () => void } {
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.width = "100%";
    wrapper.style.maxWidth = config.dimensions;
    wrapper.style.overflow = "hidden";

    const aspectRatio = config.dimensions.split("x");
    if (aspectRatio.length === 2) {
      wrapper.style.aspectRatio = `${parseInt(aspectRatio[0], 10)} / ${parseInt(aspectRatio[1], 10)}`;
    }

    const timerOverlay = document.createElement("div");
    timerOverlay.style.position = "absolute";
    timerOverlay.style.top = "8px";
    timerOverlay.style.right = "8px";
    timerOverlay.style.background = "rgba(0,0,0,0.6)";
    timerOverlay.style.color = "#fff";
    timerOverlay.style.padding = "4px 8px";
    timerOverlay.style.borderRadius = "4px";
    timerOverlay.style.fontSize = "14px";
    timerOverlay.style.zIndex = "10";

    const ctaButton = document.createElement("button");
    ctaButton.textContent = "Learn More";
    ctaButton.style.position = "absolute";
    ctaButton.style.bottom = "16px";
    ctaButton.style.left = "50%";
    ctaButton.style.transform = "translateX(-50%)";
    ctaButton.style.zIndex = "10";
    ctaButton.style.display = "none";

    const closeButton = document.createElement("button");
    closeButton.textContent = "X";
    closeButton.style.position = "absolute";
    closeButton.style.top = "8px";
    closeButton.style.left = "8px";
    closeButton.style.zIndex = "10";
    closeButton.style.display = "none";

    let destroyed = false;
    let renderPending = !!config.trackingUrl && config.autoConfirmRender !== false;

    // Render proof for a playable = the bundle iframe's `load` . Fire at the later of
    // "loaded" and "document visible"; never from a prerender/hidden page, never after destroy.
    const fireIfRenderable = () => {
      if (!renderPending || destroyed) return;
      if (wrapper.isConnected === false) return;
      const doc = document as Document & { prerendering?: boolean };
      if (doc.prerendering) return;
      if (doc.visibilityState !== undefined && doc.visibilityState !== "visible") return;
      renderPending = false;
      document.removeEventListener?.("visibilitychange", onVisibility);
      confirmRender(config.trackingUrl as string);
    };
    let loaded = false;
    const onFrameLoad = () => {
      if (loaded) return;
      loaded = true;
      fireIfRenderable();
    };
    const onVisibility = () => {
      if (loaded) fireIfRenderable();
    };
    if (renderPending) document.addEventListener?.("visibilitychange", onVisibility);

    const iframeView = this.adWebView.create(
      wrapper,
      config.bundleUrl,
      renderPending ? onFrameLoad : undefined,
    );

    wrapper.appendChild(timerOverlay);
    wrapper.appendChild(closeButton);
    wrapper.appendChild(ctaButton);
    config.container.appendChild(wrapper);

    let elapsed = 0;

    const interval = setInterval(() => {
      if (destroyed) return;
      elapsed++;
      const remaining = Math.max(0, config.playDuration - elapsed);
      timerOverlay.textContent = `${remaining}s`;

      if (elapsed % 5 === 0) {
        config.eventTracker.track({
          type: "engagement_progress",
          metadata: { progress: elapsed, totalDuration: config.playDuration },
        });
      }
    }, 1000);

    config.eventTracker.track({
      type: "engagement_start",
      metadata: { totalDuration: config.playDuration },
    });

    const closeTimeout = setTimeout(() => {
      if (destroyed) return;
      closeButton.style.display = "block";
      ctaButton.style.display = "block";
    }, config.closeDelay * 1000);

    const completeTimeout = setTimeout(() => {
      if (destroyed) return;
      config.eventTracker.track({
        type: "engagement_complete",
        metadata: { playDuration: config.playDuration },
      });
    }, config.playDuration * 1000);

    const onClose = () => {
      config.eventTracker.track({
        type: "close",
        metadata: { elapsed },
      });
      destroy();
    };

    const onCtaClick = () => {
      config.eventTracker.track({
        type: "cta_click",
      });
    };

    closeButton.addEventListener("click", onClose);
    ctaButton.addEventListener("click", onCtaClick);

    function destroy() {
      destroyed = true;
      document.removeEventListener?.("visibilitychange", onVisibility);
      clearInterval(interval);
      clearTimeout(closeTimeout);
      clearTimeout(completeTimeout);
      closeButton.removeEventListener("click", onClose);
      ctaButton.removeEventListener("click", onCtaClick);
      iframeView.destroy();
      if (wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    }

    return { destroy };
  }
}
