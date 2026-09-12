/**
 * Tests for lib/agent-link-message.ts — the shared pure module behind the
 * one-signature agent-link flow.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_KEY_PREFIX,
  buildLinkMessage,
  parseLinkMessage,
} from "./agent-link-message";
import { generateNonce } from "./session-message";

const FIELDS = {
  userAddress: "0xABCDEF0123456789abcdef0123456789ABCDEF01",
  agentAccountId: "0.0.7654321",
  uri: "https://voicescape.vercel.app",
  nonce: generateNonce(),
  issuedAt: new Date().toISOString(),
};

describe("buildLinkMessage / parseLinkMessage", () => {
  it("round-trips through parse", () => {
    const msg = buildLinkMessage(FIELDS);
    expect(parseLinkMessage(msg)).toEqual(FIELDS);
  });

  it("rejects anything that is not the exact format", () => {
    const msg = buildLinkMessage(FIELDS);
    expect(parseLinkMessage("hello")).toBeNull();
    expect(parseLinkMessage(msg + "\n")).toBeNull();
    expect(parseLinkMessage(msg.replace("Voicescape wants to link an AI agent:", "Link my agent:"))).toBeNull();
    expect(parseLinkMessage(msg.replace("App: Voicescape", "App: Evil"))).toBeNull();
    // Wrong line count.
    expect(parseLinkMessage(msg.split("\n").slice(0, 8).join("\n"))).toBeNull();
    // Nonce must be 32 hex chars.
    expect(parseLinkMessage(msg.replace(/Nonce: [0-9a-f]{32}/, "Nonce: abc"))).toBeNull();
    // Agent account must be 0.0.x.
    expect(parseLinkMessage(msg.replace("Agent account: 0.0.7654321", "Agent account: 123"))).toBeNull();
    // Garbage user address.
    expect(parseLinkMessage(msg.replace(FIELDS.userAddress, "not-an-address"))).toBeNull();
    // Over-long input rejected outright.
    expect(parseLinkMessage(msg + "x".repeat(2000))).toBeNull();
  });

  it("normalizes the user address to canonical form", () => {
    const msg = buildLinkMessage(FIELDS);
    const parsed = parseLinkMessage(msg);
    expect(parsed?.userAddress).toBe(FIELDS.userAddress);
  });

  it("AGENT_KEY_PREFIX identifies issued keys", () => {
    expect(AGENT_KEY_PREFIX).toBe("vsak_");
  });
});
