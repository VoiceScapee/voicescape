/**
 * Voicescape MCP self-fund tool — unit tests.
 *
 * The tool is guidance-only: zero network calls, zero signing, zero spend.
 * Tests assert validation rejects bad input and valid input yields a
 * complete, executable plan with the safety warnings intact.
 */
import { describe, expect, it } from "vitest";
import { selfFundHederaTool } from "./mcp-tools-self-fund";

const BASE_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const SOL_ADDR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HEDERA_DEST = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("selfFundHederaTool", () => {
  it("builds a complete Base funding plan", async () => {
    const r = await selfFundHederaTool({
      source_chain: "base",
      source_address: BASE_ADDR,
      hedera_destination: HEDERA_DEST,
      amount_usd: 5,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.route.from_chain_id).toBe("8453");
    expect(r.route.to_chain_id).toBe("295");
    expect(r.route.from_token).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(r.route.via).toContain("Axelar");
    expect(r.steps).toHaveLength(6);
    expect(r.steps[0].step).toBe(1);
    expect(r.steps[5].step).toBe(6);
    // Step 2 body embeds the exact route params the agent posts.
    expect(r.steps[1].detail).toContain("v2.api.squidrouter.com/v2/route");
    expect(r.steps[1].detail).toContain(BASE_ADDR);
    expect(r.steps[1].detail).toContain(HEDERA_DEST);
    expect(r.steps[1].detail).toContain('"fromAmount": "5000000"');
    expect(r.next).toContain("finalize_agent_self_claim");
  });

  it("builds a Solana funding plan with Solana signing guidance", async () => {
    const r = await selfFundHederaTool({
      source_chain: "solana",
      source_address: SOL_ADDR,
      hedera_destination: HEDERA_DEST,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.route.from_chain_id).toBe("solana");
    expect(r.route.from_token).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(r.steps[2].detail).toContain("Solana");
    // Default amount applies.
    expect(r.summary).toContain("$5 USDC");
  });

  it("carries the safety warnings on every plan", async () => {
    const r = await selfFundHederaTool({
      source_chain: "base",
      source_address: BASE_ADDR,
      hedera_destination: HEDERA_DEST,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const warnings = r.warnings.join("\n");
    expect(warnings).toContain("Hashport");
    expect(warnings).toContain("AUTHORIZATION");
    expect(warnings).toContain("never sees your keys");
  });

  it("rejects an unsupported source chain", async () => {
    const r = await selfFundHederaTool({
      source_chain: "ethereum" as never,
      source_address: BASE_ADDR,
      hedera_destination: HEDERA_DEST,
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("base");
    expect(r.error).toContain("solana");
  });

  it("rejects a malformed Base source address", async () => {
    const r = await selfFundHederaTool({
      source_chain: "base",
      source_address: "not-an-address",
      hedera_destination: HEDERA_DEST,
    });
    expect("error" in r).toBe(true);
  });

  it("rejects a malformed Solana source address", async () => {
    const r = await selfFundHederaTool({
      source_chain: "solana",
      source_address: "0x1234",
      hedera_destination: HEDERA_DEST,
    });
    expect("error" in r).toBe(true);
  });

  it("rejects a malformed Hedera destination", async () => {
    const r = await selfFundHederaTool({
      source_chain: "base",
      source_address: BASE_ADDR,
      hedera_destination: "0.0.12345",
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("prepare_agent_self_claim");
  });

  it("rejects amounts below the $5 fee-efficiency floor", async () => {
    const r = await selfFundHederaTool({
      source_chain: "base",
      source_address: BASE_ADDR,
      hedera_destination: HEDERA_DEST,
      amount_usd: 1,
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("$5");
  });

  it("never hardcodes a Hedera destination token address", async () => {
    const r = await selfFundHederaTool({
      source_chain: "base",
      source_address: BASE_ADDR,
      hedera_destination: HEDERA_DEST,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    // The plan must tell the agent to resolve toToken live — a hardcoded
    // Hedera token address here would rot silently.
    expect(r.route.to_token_guidance).toContain("/v2/tokens?chainId=295");
    expect(r.steps[0].detail).toContain("Never guess a token address");
  });
});
