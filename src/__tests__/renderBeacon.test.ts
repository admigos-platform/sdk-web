import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { confirmRender, __resetRenderBeaconForTests } from "../renderBeacon.js";
import { AdPlayableView } from "../AdPlayableView.js";
import { AdWebView } from "../AdWebView.js";

// 18g B4 (render-beacon plan §6.1 / §12.12). The vitest environment is "node" with no DOM
// library, so the tiny DOM surface used here is stubbed by hand (same approach as adwebview.test.ts).

const URL_A = "https://tracking.example.test/i/" + "A".repeat(67);
const URL_B = "https://tracking.example.test/i/" + "B".repeat(67);

const EXPECTED_INIT = {
  method: "GET",
  mode: "no-cors",
  credentials: "omit",
  cache: "no-store",
  referrerPolicy: "no-referrer",
  keepalive: true,
};

type Listener = () => void;

interface FakeEl {
  tagName: string;
  style: Record<string, string>;
  children: FakeEl[];
  parentNode: FakeEl | null;
  isConnected?: boolean;
  textContent?: string;
  src?: string;
  listeners: Record<string, Listener[]>;
  attrs: Record<string, string>;
  setAttribute(n: string, v: string): void;
  getAttribute(n: string): string | null;
  addEventListener(t: string, l: Listener): void;
  removeEventListener(t: string, l: Listener): void;
  dispatch(t: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
}

function el(tag: string): FakeEl {
  const e: FakeEl = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    parentNode: null,
    listeners: {},
    attrs: {},
    setAttribute(n, v) {
      e.attrs[n] = v;
    },
    getAttribute(n) {
      return n in e.attrs ? e.attrs[n] : null;
    },
    addEventListener(t, l) {
      (e.listeners[t] ||= []).push(l);
    },
    removeEventListener(t, l) {
      e.listeners[t] = (e.listeners[t] || []).filter((x) => x !== l);
    },
    dispatch(t) {
      [...(e.listeners[t] || [])].forEach((l) => l());
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
  };
  return e;
}

const g = globalThis as Record<string, unknown>;

describe("confirmRender (18g B4)", () => {
  const origFetch = g.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetRenderBeaconForTests();
    fetchMock = vi.fn(() => Promise.resolve({ type: "opaque" }));
    g.fetch = fetchMock;
  });
  afterEach(() => {
    g.fetch = origFetch;
    delete g.Image;
    delete g.localStorage;
    delete g.sessionStorage;
    vi.useRealTimers();
  });

  it("fires one no-cors GET with the exact init and the unmodified URL", () => {
    confirmRender(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_A, EXPECTED_INIT);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it("fires once per URL across repeated calls and again for a different URL", () => {
    confirmRender(URL_A);
    confirmRender(URL_A);
    confirmRender(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    confirmRender(URL_B);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adds the URL before dispatch, so a re-entrant call is a no-op", () => {
    fetchMock.mockImplementationOnce(() => {
      confirmRender(URL_A);
      return Promise.resolve({});
    });
    confirmRender(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op, without throwing, for an empty or non-string URL", () => {
    expect(() => confirmRender("")).not.toThrow();
    expect(() => confirmRender(undefined as unknown as string)).not.toThrow();
    expect(() => confirmRender(null as unknown as string)).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a synchronous fetch throw", () => {
    fetchMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => confirmRender(URL_A)).not.toThrow();
  });

  it("does not retry after a resolved response", async () => {
    confirmRender(URL_A);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once after a network rejection, swallowing both", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("network")));
    expect(() => confirmRender(URL_A)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    confirmRender(URL_A);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to Image with referrerPolicy no-referrer when fetch is missing", () => {
    g.fetch = undefined;
    const imgs: { src?: string; referrerPolicy?: string }[] = [];
    g.Image = function () {
      const i = {};
      imgs.push(i);
      return i;
    };
    confirmRender(URL_A);
    confirmRender(URL_A);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].src).toBe(URL_A);
    expect(imgs[0].referrerPolicy).toBe("no-referrer");
  });

  it("is a silent no-op when neither fetch nor Image exists", () => {
    g.fetch = undefined;
    delete g.Image;
    expect(() => confirmRender(URL_A)).not.toThrow();
  });

  it("never touches storage, sendBeacon or navigator fields", () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy({}, { get: (_t, p) => (touched.push(`${name}.${String(p)}`), undefined) });
    g.localStorage = trap("localStorage");
    g.sessionStorage = trap("sessionStorage");
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: trap("navigator"), configurable: true });
    try {
      confirmRender(URL_A);
    } finally {
      if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
      else delete g.navigator;
    }
    expect(touched).toEqual([]);
  });
});

describe("AdPlayableView render wiring (18g B4)", () => {
  const origDoc = g.document;
  const origFetch = g.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let docListeners: Record<string, Listener[]>;
  let doc: Record<string, unknown>;
  const tracker = { track: vi.fn() };

  function build(extra: Record<string, unknown> = {}) {
    const container = el("div");
    container.isConnected = true;
    const view = new AdPlayableView().create({
      container: container as unknown as HTMLElement,
      bundleUrl: "https://bundles.example.test/b1/index.html",
      dimensions: "300x250",
      playDuration: 30,
      closeDelay: 5,
      eventTracker: tracker as never,
      ...extra,
    });
    const wrapper = container.children[0];
    const iframe = wrapper.children.find((c) => c.tagName === "IFRAME")!;
    return { view, iframe, wrapper };
  }

  beforeEach(() => {
    __resetRenderBeaconForTests();
    vi.useFakeTimers();
    tracker.track.mockClear();
    docListeners = {};
    doc = {
      visibilityState: "visible",
      createElement: (t: string) => el(t),
      addEventListener: (t: string, l: Listener) => (docListeners[t] ||= []).push(l),
      removeEventListener: (t: string, l: Listener) => {
        docListeners[t] = (docListeners[t] || []).filter((x) => x !== l);
      },
    };
    g.document = doc;
    fetchMock = vi.fn(() => Promise.resolve({}));
    g.fetch = fetchMock;
  });
  afterEach(() => {
    vi.useRealTimers();
    g.document = origDoc;
    g.fetch = origFetch;
  });

  it("does not fire on construction or on engagement_start, only on iframe load, exactly once", () => {
    const { iframe } = build({ trackingUrl: URL_A });
    expect(tracker.track).toHaveBeenCalledWith(expect.objectContaining({ type: "engagement_start" }));
    expect(fetchMock).not.toHaveBeenCalled();
    iframe.dispatch("load");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_A, EXPECTED_INIT);
    iframe.dispatch("load");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never fires without a trackingUrl", () => {
    const { iframe } = build();
    iframe.dispatch("load");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("autoConfirmRender: false leaves the moment to the integrator", () => {
    const { iframe } = build({ trackingUrl: URL_A, autoConfirmRender: false });
    iframe.dispatch("load");
    expect(fetchMock).not.toHaveBeenCalled();
    confirmRender(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for the document to become visible, then fires once", () => {
    doc.visibilityState = "hidden";
    const { iframe } = build({ trackingUrl: URL_A });
    iframe.dispatch("load");
    expect(fetchMock).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    (docListeners.visibilitychange || []).forEach((l) => l());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    (docListeners.visibilitychange || []).forEach((l) => l());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire while prerendering", () => {
    doc.prerendering = true;
    const { iframe } = build({ trackingUrl: URL_A });
    iframe.dispatch("load");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire after destroy()", () => {
    const { view, iframe } = build({ trackingUrl: URL_A });
    view.destroy();
    iframe.dispatch("load");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(docListeners.visibilitychange ?? []).toHaveLength(0);
  });

  it("keeps referrerpolicy=no-referrer and the sandbox on the iframe", () => {
    const { iframe } = build({ trackingUrl: URL_A });
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("AdWebView.create without onLoad registers no load listener", () => {
    const c = el("div");
    new AdWebView().create(c as unknown as HTMLElement, "https://bundles.example.test/x/index.html");
    expect(c.children[0].listeners.load ?? []).toHaveLength(0);
  });
});
