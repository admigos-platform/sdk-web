export class AdWebView {
  /**
   * `onLoad` (optional) fires on the host-side `load` event of the bundle iframe. It is the
   * begin-to-render proof for interactive_html5; the host listens, the
   * creative never signals (and never receives the tracking URL). Cross-origin, so the parent
   * cannot see an HTTP status: an error document would also fire `load`.
   */
  create(container: HTMLElement, bundleUrl: string, onLoad?: () => void): { destroy: () => void } {
    const iframe = document.createElement("iframe");
    iframe.src = bundleUrl;
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "none";
    // Sandbox hardening: `allow-scripts` only — never add `allow-same-origin` (that pairing lets
    // the sandboxed document remove its own sandbox via a self-navigation) or
    // `allow-top-navigation`. `no-referrer` stops the playable's own document/asset requests
    // from leaking the publisher page's URL to whatever host they hit.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    if (onLoad) iframe.addEventListener("load", () => onLoad());

    container.appendChild(iframe);

    return {
      destroy: () => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      },
    };
  }
}
