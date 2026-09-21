/**
 * godseye tests: the dead-man's switch. Staleness is computed from
 * generatedAt alone; a missing or unparseable timestamp is ALWAYS stale
 * (fail closed — the LIVE badge must never claim freshness it can't prove).
 */
import { describe, expect, it } from "vitest";
import {
  annotateFeed,
  isGodseyeAgent,
  isGodseyePage,
  GODSEYE_DISPLAY,
  GODSEYE_STALE_AFTER_SEC,
  type GodseyeFeed,
} from "./godseye";

function feed(generatedAt: string): GodseyeFeed {
  return {
    v: 1,
    agent: "danny",
    generatedAt,
    systems: [{ id: "engine", wired: true }],
    now: null,
    events: [],
    queue: [],
  };
}

describe("godseye feed staleness", () => {
  it("fresh feed is not stale", () => {
    const gen = new Date(Date.now() - 60_000).toISOString();
    const a = annotateFeed(feed(gen));
    expect(a.stale).toBe(false);
    expect(a.updatedAgoSec).toBeGreaterThanOrEqual(60);
    expect(a.updatedAgoSec).toBeLessThan(120);
  });

  it("old feed is stale", () => {
    const gen = new Date(Date.now() - (GODSEYE_STALE_AFTER_SEC + 5) * 1000).toISOString();
    const a = annotateFeed(feed(gen));
    expect(a.stale).toBe(true);
  });

  it("boundary: exactly at the threshold is not stale", () => {
    const now = Date.now();
    const gen = new Date(now - GODSEYE_STALE_AFTER_SEC * 1000).toISOString();
    const a = annotateFeed(feed(gen), now);
    expect(a.stale).toBe(false);
  });

  it("unparseable generatedAt is stale (fail closed)", () => {
    const a = annotateFeed(feed("not-a-date"));
    expect(a.stale).toBe(true);
    expect(a.updatedAgoSec).toBe(Number.POSITIVE_INFINITY);
  });

  it("future generatedAt clamps to zero, never negative", () => {
    const gen = new Date(Date.now() + 60_000).toISOString();
    const a = annotateFeed(feed(gen));
    expect(a.updatedAgoSec).toBe(0);
    expect(a.stale).toBe(false);
  });
});

describe("godseye page gate", () => {
  it("only danny and forge get a godseye page", () => {
    expect(isGodseyePage("danny")).toBe(true);
    expect(isGodseyePage("forge")).toBe(true);
    expect(isGodseyePage("Danny")).toBe(true);
    expect(isGodseyePage("buddy")).toBe(false);
    expect(isGodseyePage("user-10424063")).toBe(false);
    expect(isGodseyePage("")).toBe(false);
  });

  it("display config matches Brandon's naming", () => {
    expect(GODSEYE_DISPLAY.danny.name).toBe("Voicescape Dapp Engine");
    expect(GODSEYE_DISPLAY.forge.subtitle).toBe("Blockpage Buddy / Forge Builder");
    expect(GODSEYE_DISPLAY.danny.accent).not.toBe(GODSEYE_DISPLAY.forge.accent);
  });
});
describe("godseye agent allowlist", () => {
  it("accepts danny and forge only", () => {
    expect(isGodseyeAgent("danny")).toBe(true);
    expect(isGodseyeAgent("forge")).toBe(true);
    expect(isGodseyeAgent("buddy")).toBe(false);
    expect(isGodseyeAgent("")).toBe(false);
    expect(isGodseyeAgent("DANNY")).toBe(false);
  });
});
