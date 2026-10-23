import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConsentManager, isGpcAsserted } from "../consent.js";

describe("ConsentManager", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("default (no setConsent call, no GPC)", () => {
    it("sends no consent headers at all — not four explicit falses", () => {
      const manager = new ConsentManager();
      expect(manager.buildHeaders()).toEqual({});
    });
  });

  describe("individual flags via setConsent", () => {
    it("gdprApplies: true → x-gdpr-applies: true, nothing else", () => {
      const manager = new ConsentManager();
      manager.setConsent({ gdprApplies: true });
      expect(manager.buildHeaders()).toEqual({ "x-gdpr-applies": "true" });
    });

    it("childDirected: true → x-coppa-child-directed: true, nothing else", () => {
      const manager = new ConsentManager();
      manager.setConsent({ childDirected: true });
      expect(manager.buildHeaders()).toEqual({ "x-coppa-child-directed": "true" });
    });

    it("personalizationAllowed: true → x-consent-ad-personalization: granted", () => {
      const manager = new ConsentManager();
      manager.setConsent({ personalizationAllowed: true });
      expect(manager.buildHeaders()).toEqual({
        "x-consent-ad-personalization": "granted",
      });
    });

    it("doNotSell: true (no GPC) → x-consent-ad-personalization: denied, no x-gpc header", () => {
      const manager = new ConsentManager();
      manager.setConsent({ doNotSell: true });
      expect(manager.buildHeaders()).toEqual({
        "x-consent-ad-personalization": "denied",
      });
    });

    it("all four true → W3-C8 fix: personalization stays granted, doNotSell rides its OWN dedicated header (no longer collapsed to denied)", () => {
      const manager = new ConsentManager();
      manager.setConsent({
        gdprApplies: true,
        personalizationAllowed: true,
        childDirected: true,
        doNotSell: true,
      });
      expect(manager.buildHeaders()).toEqual({
        "x-gdpr-applies": "true",
        "x-coppa-child-directed": "true",
        "x-consent-ad-personalization": "granted",
        "x-consent-do-not-sell": "true",
      });
    });

    it("doNotSell: true + personalizationAllowed: true (no GPC) → BOTH headers, independently (W3-C8)", () => {
      const manager = new ConsentManager();
      manager.setConsent({ doNotSell: true, personalizationAllowed: true });
      expect(manager.buildHeaders()).toEqual({
        "x-consent-ad-personalization": "granted",
        "x-consent-do-not-sell": "true",
      });
    });

    it("doNotSell: true + personalizationAllowed NOT granted (unset) → UNCHANGED, still collapses to denied, no new header sent", () => {
      const manager = new ConsentManager();
      manager.setConsent({ doNotSell: true });
      expect(manager.buildHeaders()).toEqual({
        "x-consent-ad-personalization": "denied",
      });
      expect(manager.buildHeaders()["x-consent-do-not-sell"]).toBeUndefined();
    });

    it("explicit setConsent({}) (all default false) sends no headers — same wire outcome as never calling it", () => {
      const manager = new ConsentManager();
      manager.setConsent({});
      expect(manager.buildHeaders()).toEqual({});
    });
  });

  describe("setConsent replaces wholesale, never merges", () => {
    it("a later partial call resets previously-set fields to false", () => {
      const manager = new ConsentManager();
      manager.setConsent({ doNotSell: true, gdprApplies: true });
      expect(manager.buildHeaders()).toEqual({
        "x-gdpr-applies": "true",
        "x-consent-ad-personalization": "denied",
      });

      manager.setConsent({ childDirected: true });
      expect(manager.buildHeaders()).toEqual({ "x-coppa-child-directed": "true" });
    });
  });

  describe("GPC precedence", () => {
    it("isGpcAsserted() reads navigator.globalPrivacyControl live", () => {
      expect(isGpcAsserted()).toBe(false);
      vi.stubGlobal("navigator", { globalPrivacyControl: true });
      expect(isGpcAsserted()).toBe(true);
    });

    it("GPC true alone (no setConsent call) → x-gpc + denied, sec-gpc is never sent", () => {
      vi.stubGlobal("navigator", { globalPrivacyControl: true });
      const manager = new ConsentManager();
      expect(manager.buildHeaders()).toEqual({
        "x-gpc": "true",
        "x-consent-ad-personalization": "denied",
      });
    });

    it("GPC true is NEVER overridable downward by setConsent({ doNotSell: false })", () => {
      vi.stubGlobal("navigator", { globalPrivacyControl: true });
      const manager = new ConsentManager();
      manager.setConsent({ doNotSell: false, personalizationAllowed: true });
      const headers = manager.buildHeaders();
      expect(headers["x-gpc"]).toBe("true");
      // doNotSell (from GPC) beats the stored personalizationAllowed grant —
      // matching ad-matching-service's matching.controller.ts precedence.
      expect(headers["x-consent-ad-personalization"]).toBe("denied");
    });

    it("GPC false + setConsent doNotSell true → still denied, no x-gpc header", () => {
      vi.stubGlobal("navigator", { globalPrivacyControl: false });
      const manager = new ConsentManager();
      manager.setConsent({ doNotSell: true });
      const headers = manager.buildHeaders();
      expect(headers["x-gpc"]).toBeUndefined();
      expect(headers["x-consent-ad-personalization"]).toBe("denied");
    });

    it("GPC true STILL beats a real personalizationAllowed:true grant even with doNotSell:false (W3-C8's new split does not apply to GPC)", () => {
      vi.stubGlobal("navigator", { globalPrivacyControl: true });
      const manager = new ConsentManager();
      manager.setConsent({ personalizationAllowed: true, doNotSell: false });
      const headers = manager.buildHeaders();
      expect(headers["x-gpc"]).toBe("true");
      expect(headers["x-consent-ad-personalization"]).toBe("denied");
      expect(headers["x-consent-do-not-sell"]).toBeUndefined();
    });
  });
});
