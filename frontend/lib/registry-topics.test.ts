import { describe, it, expect } from "vitest";
import { id } from "ethers";
import { PAGEREGISTERED_TOPIC, PAGEUPDATED_TOPIC } from "@/app/api/explore/pages/route";

/**
 * Regression test for the 2026-09-12 Explore bug: PAGEREGISTERED_TOPIC held
 * the PageUpdated event hash, so the log filter silently dropped every
 * PageRegistered event and newly registered blockpages never appeared in
 * Explore. These assertions recompute the hashes from the canonical event
 * signatures — a fat-fingered constant fails loudly here instead of
 * silently hiding pages in production.
 */
describe("explore registry event topics", () => {
  it("PAGEREGISTERED_TOPIC matches PageRegistered(string,address,string,uint8,address,string)", () => {
    expect(PAGEREGISTERED_TOPIC).toBe(
      id("PageRegistered(string,address,string,uint8,address,string)"),
    );
  });

  it("PAGEUPDATED_TOPIC matches PageUpdated(string,address,string,uint8,address,string)", () => {
    expect(PAGEUPDATED_TOPIC).toBe(
      id("PageUpdated(string,address,string,uint8,address,string)"),
    );
  });

  it("the two topics are distinct", () => {
    expect(PAGEREGISTERED_TOPIC).not.toBe(PAGEUPDATED_TOPIC);
  });
});
