import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AdWebView } from "../AdWebView.js";

// Served-playable egress restriction coverage. sdk-web's vitest environment is "node" (vitest.config.ts) and the
// package has no jsdom/happy-dom dependency, so AdWebView's tiny DOM surface
// (createElement/setAttribute/getAttribute/appendChild/removeChild) is stubbed by hand here
// rather than pulling in a new dependency mid-task.
interface FakeElement {
  tagName: string;
  src?: string;
  style: Record<string, string>;
  children: FakeElement[];
  parentNode: FakeElement | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
}

function createFakeElement(tag: string): FakeElement {
  const attributes: Record<string, string> = {};
  const element: FakeElement = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    parentNode: null,
    setAttribute(name, value) {
      attributes[name] = value;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = element.children.indexOf(child);
      if (idx !== -1) element.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
  };
  return element;
}

describe("AdWebView (served-playable egress restriction)", () => {
  const originalDocument = (globalThis as { document?: unknown }).document;

  beforeEach(() => {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => createFakeElement(tag),
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  it("sets referrerpolicy=no-referrer on the iframe", () => {
    const container = createFakeElement("div");
    new AdWebView().create(container, "https://pub-bundles.r2.dev/bundle-1/index.html");

    const iframe = container.children[0];
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("sandboxes with exactly allow-scripts — no allow-same-origin, no allow-top-navigation", () => {
    const container = createFakeElement("div");
    new AdWebView().create(container, "https://pub-bundles.r2.dev/bundle-1/index.html");

    const iframe = container.children[0];
    const sandboxTokens = (iframe.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(sandboxTokens).toEqual(["allow-scripts"]);
    expect(sandboxTokens).not.toContain("allow-same-origin");
    expect(sandboxTokens).not.toContain("allow-top-navigation");
  });

  it("points the iframe at the given bundleUrl", () => {
    const container = createFakeElement("div");
    new AdWebView().create(container, "https://pub-bundles.r2.dev/bundle-1/index.html");

    expect(container.children[0].src).toBe("https://pub-bundles.r2.dev/bundle-1/index.html");
  });

  it("destroy() removes the iframe from the container", () => {
    const container = createFakeElement("div");
    const view = new AdWebView().create(container, "https://pub-bundles.r2.dev/bundle-1/index.html");

    expect(container.children).toHaveLength(1);
    view.destroy();
    expect(container.children).toHaveLength(0);
  });
});
