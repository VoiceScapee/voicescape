/**
 * BuddyDashboard tests (source assertions, repo convention): mission
 * control is status + activity + approvals, nothing else. Live on-chain
 * data only, honest quiet states, no decorative widgets.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dashSrc = readFileSync(join(here, "BuddyDashboard.tsx"), "utf8");
const chatSrc = readFileSync(join(here, "AgentChat.tsx"), "utf8");

describe("BuddyDashboard", () => {
  it("is a client component with exactly the three sections", () => {
    expect(dashSrc).toContain('"use client"');
    expect(dashSrc).toContain(">Status<");
    expect(dashSrc).toContain(">Activity<");
    expect(dashSrc).toContain(">Proposals<");
  });

  it("shows honest quiet states instead of decorative widgets", () => {
    expect(dashSrc).toContain("No tips yet");
    expect(dashSrc).toContain("Nothing waiting on you");
    expect(dashSrc).not.toMatch(/[Cc]hart/);
    expect(dashSrc).not.toContain(">Analytics<");
  });

  it("renders proposals with the same inline one-tap card as the thread", () => {
    expect(dashSrc).toContain("BuddyActionCard");
    expect(dashSrc).toContain("onApprove={onApprove}");
  });

  it("links each tip to its on-chain transaction", () => {
    expect(dashSrc).toContain("hashscan.io/mainnet/transaction");
  });

  it("only appears for owners of an agent blockpage", () => {
    expect(chatSrc).toContain("overview?.ownsAgentPage === true && (");
    expect(chatSrc).toContain("<BuddyDashboard");
  });

  it("polls the cheap inbox often and the heavier overview rarely", () => {
    expect(chatSrc).toContain('"/api/agents/proposals"');
    expect(chatSrc).toContain('"/api/agents/overview"');
    expect(chatSrc).toContain("setInterval(pollProposals, 15_000)");
    expect(chatSrc).toContain("setInterval(pollOverview, 60_000)");
  });
});
