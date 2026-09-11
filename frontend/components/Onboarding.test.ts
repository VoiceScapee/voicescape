import { describe, expect, it, beforeEach } from "vitest";
import {
  ONBOARDED_KEY,
  ONBOARD_DRAFT_KEY,
  isOnboarded,
  markOnboarded,
  saveOnboardDraft,
  consumeOnboardDraft,
  type OnboardDraft,
} from "./Onboarding";

// Minimal localStorage + window mocks for the test env.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
});

describe("isOnboarded / markOnboarded", () => {
  it("is false for a fresh browser", () => {
    expect(isOnboarded()).toBe(false);
  });

  it("is true after markOnboarded", () => {
    markOnboarded();
    expect(isOnboarded()).toBe(true);
    expect(store.get(ONBOARDED_KEY)).toBe("true");
  });
});

describe("saveOnboardDraft / consumeOnboardDraft", () => {
  const draft: OnboardDraft = {
    templateId: "neon-nights",
    displayName: "Brandon",
    bio: "Cable tech by day.",
    heroTitle: "Welcome!",
    ownerType: 0,
  };

  it("round-trips a draft", () => {
    saveOnboardDraft(draft);
    const back = consumeOnboardDraft();
    expect(back).toEqual(draft);
  });

  it("consume clears the draft (one-shot)", () => {
    saveOnboardDraft(draft);
    consumeOnboardDraft();
    expect(consumeOnboardDraft()).toBeNull();
    expect(store.get(ONBOARD_DRAFT_KEY)).toBeUndefined();
  });

  it("returns null when nothing was saved", () => {
    expect(consumeOnboardDraft()).toBeNull();
  });

  it("rejects drafts with an unknown template id", () => {
    saveOnboardDraft({ ...draft, templateId: "nope-not-real" });
    expect(consumeOnboardDraft()).toBeNull();
  });

  it("truncates over-long fields defensively", () => {
    saveOnboardDraft({
      ...draft,
      displayName: "x".repeat(500),
      bio: "y".repeat(5000),
      heroTitle: "z".repeat(500),
    });
    const back = consumeOnboardDraft();
    expect(back!.displayName).toHaveLength(60);
    expect(back!.bio).toHaveLength(500);
    expect(back!.heroTitle).toHaveLength(80);
  });

  it("normalizes ownerType to 0|1", () => {
    saveOnboardDraft({ ...draft, ownerType: 7 as unknown as 0 | 1 });
    expect(consumeOnboardDraft()!.ownerType).toBe(0);
  });

  it("returns null on corrupt JSON", () => {
    store.set(ONBOARD_DRAFT_KEY, "{not json");
    expect(consumeOnboardDraft()).toBeNull();
  });
});
