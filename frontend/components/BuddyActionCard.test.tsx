/**
 * BuddyActionCard tests (source assertions, repo convention): the card is
 * the stripped-to-the-bone one-tap approval — what it does, the cost, ONE
 * Approve button. No reject button, no multi-step flows, no extra in-app
 * confirmations.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cardSrc = readFileSync(join(here, "BuddyActionCard.tsx"), "utf8");

describe("BuddyActionCard", () => {
  it("is a client component showing what, cost, and ONE Approve button", () => {
    expect(cardSrc).toContain('"use client"');
    expect(cardSrc).toContain("{summary}");
    expect(cardSrc).toContain("{costEstimate}");
    expect(cardSrc).toContain("Approve\n        </button>");
  });

  it("has no reject path and no extra in-app confirmations", () => {
    expect(cardSrc).not.toMatch(/[Rr]eject/);
    expect(cardSrc).not.toContain("Are you sure");
    expect(cardSrc).not.toContain("Confirm purchase");
  });

  it("documents the wallet's own signature prompt as the wallet's security, not our UX", () => {
    expect(cardSrc).toContain("the wallet app");
    expect(cardSrc).toContain("its own signature prompt");
    expect(cardSrc).toContain("no extra in-app confirmation");
  });

  it("posts the receipt with a HashScan link after confirmation", () => {
    expect(cardSrc).toContain("hashscanTxUrl");
    expect(cardSrc).toContain("View on HashScan");
    expect(cardSrc).toContain("Approved &amp; confirmed on Hedera");
  });

  it("handles the unfixable states with a single repair action", () => {
    expect(cardSrc).toContain("Connect wallet");
    expect(cardSrc).toContain("Reconnect wallet");
    expect(cardSrc).toContain("STALE_CONNECTION_COPY");
  });

  it("never signs itself — the host provides onApprove", () => {
    expect(cardSrc).toContain("onApprove: (payload: PreparedTxPayload)");
    expect(cardSrc).not.toContain("signAndExecuteTransaction");
  });
});
