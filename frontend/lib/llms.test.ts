import { describe, expect, it } from "vitest";
import { buildLlmsText, storeBackedCount } from "./llms";

const POSITIONING =
  "Voicescape is where agents and humans go to get on-chain identity for their one hub of social and agentic commerce.";

describe("buildLlmsText", () => {
  it("leads with the identity + one-hub positioning", () => {
    const text = buildLlmsText({});
    expect(text.startsWith(`# Voicescape\n\n${POSITIONING}`)).toBe(true);
  });

  it("never claims to be the only hub", () => {
    const text = buildLlmsText({ toolCount: 70 });
    expect(text).not.toMatch(/only hub/i);
    expect(text).not.toMatch(/the only/i);
  });

  it("renders live numbers when their sources succeed", () => {
    const text = buildLlmsText({
      toolCount: 70,
      toolCalls30d: 1534,
      registeredPages: 11,
      directoryAgents: 5,
      introductions: 7,
    });
    expect(text).toContain("MCP tools live: 70");
    expect(text).toContain("MCP tool calls, rolling 30 days: 1,534");
    expect(text).toContain("Registered blockpages (on-chain): 11");
    expect(text).toContain("Agents in the public directory: 5");
    expect(text).toContain("Agent introductions posted: 7");
  });

  it("omits numbers whose sources failed — never estimates", () => {
    const text = buildLlmsText({ toolCount: 70 });
    expect(text).toContain("MCP tools live: 70");
    expect(text).not.toContain("rolling 30 days");
    expect(text).not.toContain("Registered blockpages");
    expect(text).not.toContain("public directory");
    expect(text).not.toContain("introductions posted");
  });

  it("serves the static positioning copy with no live section at all when every source fails", () => {
    const text = buildLlmsText({});
    expect(text).toContain(POSITIONING);
    expect(text).not.toContain("## Live numbers");
    expect(text).toContain("98% to the page owner, 2% to the treasury");
    expect(text).toContain("Registry 0.0.10854058, Tips 0.0.10854060");
    expect(text).toContain("chain ID 295");
    expect(text).toContain("No escrow, no custody");
  });

  it("storeBackedCount omits a bare zero with no supporting detail", () => {
    // An unreachable store reads back as total 0, no detail — that must
    // not print as a false zero.
    expect(storeBackedCount(0, 0)).toBeUndefined();
    expect(storeBackedCount(1534, 10)).toBe(1534);
    expect(storeBackedCount(0, 3)).toBe(0);
  });

  it("never uses the stale hardcoded tool count as a fallback", () => {
    // A render with no toolCount must not contain any tool-count line,
    // even though older copy said 67.
    const text = buildLlmsText({});
    expect(text).not.toMatch(/MCP tools live:/);
    expect(text).not.toContain("67 tools");
  });
});
