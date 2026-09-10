/**
 * Unit tests for the /agents/hire helper functions: price formatting,
 * max-price parsing, address truncation, and directory query building.
 */
import { describe, expect, it } from "vitest";
import {
  buildAgentsQuery,
  formatUsdCents,
  isFeaturedAgent,
  parseMaxPriceUsdToCents,
  sortFeaturedFirst,
  truncateAddress,
} from "./helpers";
import type { DirectoryAgent } from "@/lib/server/agents-directory";

function fakeAgent(username: string): DirectoryAgent {
  return {
    username,
    owner: "0xowner",
    operator: "0xoperator",
    purpose: "test",
    ipfsHash: "",
    pageUrl: "https://x",
    capabilities: [],
    services: [],
    reputation: null,
    registeredAt: null,
  };
}

describe("isFeaturedAgent", () => {
  it("matches case-insensitively", () => {
    expect(isFeaturedAgent("summarizer", ["Summarizer", "OTHER"])).toBe(true);
    expect(isFeaturedAgent("Summarizer", ["summarizer"])).toBe(true);
    expect(isFeaturedAgent("other", ["summarizer"])).toBe(false);
  });

  it("ignores non-string entries and whitespace", () => {
    expect(isFeaturedAgent("a", [" a "])).toBe(true);
    expect(isFeaturedAgent("a", [123 as unknown as string])).toBe(false);
    expect(isFeaturedAgent("", ["a"])).toBe(false);
  });
});

describe("sortFeaturedFirst", () => {
  it("returns a copy with featured agents first, order otherwise preserved", () => {
    const agents = [fakeAgent("b"), fakeAgent("a"), fakeAgent("c")];
    const out = sortFeaturedFirst(agents, ["C"]);
    expect(out.map((a) => a.username)).toEqual(["c", "b", "a"]);
  });

  it("is a no-op for empty or invalid featured lists", () => {
    const agents = [fakeAgent("b"), fakeAgent("a")];
    expect(sortFeaturedFirst(agents, []).map((a) => a.username)).toEqual(["b", "a"]);
    expect(
      sortFeaturedFirst(agents, null as unknown as string[]).map((a) => a.username),
    ).toEqual(["b", "a"]);
    expect(sortFeaturedFirst(agents, ["zzz"]).map((a) => a.username)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const agents = [fakeAgent("b"), fakeAgent("a")];
    sortFeaturedFirst(agents, ["a"]);
    expect(agents.map((a) => a.username)).toEqual(["b", "a"]);
  });
});

describe("formatUsdCents", () => {
  it("formats integer cents as $x.xx", () => {
    expect(formatUsdCents(5)).toBe("$0.05");
    expect(formatUsdCents(250)).toBe("$2.50");
    expect(formatUsdCents(1999)).toBe("$19.99");
    expect(formatUsdCents(100000)).toBe("$1000.00");
  });

  it("formats zero cents as $0.00", () => {
    expect(formatUsdCents(0)).toBe("$0.00");
  });

  it("floors fractional cents and clamps negatives", () => {
    expect(formatUsdCents(5.9)).toBe("$0.05");
    expect(formatUsdCents(-3)).toBe("$0.00");
  });

  it("degrades non-finite input to $0.00", () => {
    expect(formatUsdCents(NaN)).toBe("$0.00");
    expect(formatUsdCents(Infinity)).toBe("$0.00");
  });
});

describe("parseMaxPriceUsdToCents", () => {
  it("converts dollar strings to integer cents", () => {
    expect(parseMaxPriceUsdToCents("0.10")).toBe(10);
    expect(parseMaxPriceUsdToCents("2.50")).toBe(250);
    expect(parseMaxPriceUsdToCents("1")).toBe(100);
  });

  it("floors sub-cent amounts", () => {
    expect(parseMaxPriceUsdToCents("0.099")).toBe(9);
  });

  it("returns undefined for blank, non-numeric, or negative input", () => {
    expect(parseMaxPriceUsdToCents("")).toBeUndefined();
    expect(parseMaxPriceUsdToCents("   ")).toBeUndefined();
    expect(parseMaxPriceUsdToCents("abc")).toBeUndefined();
    expect(parseMaxPriceUsdToCents("-1")).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(parseMaxPriceUsdToCents("  0.10  ")).toBe(10);
  });
});

describe("truncateAddress", () => {
  it("passes short values through", () => {
    expect(truncateAddress("0x123")).toBe("0x123");
    expect(truncateAddress("")).toBe("");
  });

  it("truncates long addresses with an ellipsis", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    expect(truncateAddress(addr)).toBe("0x1234\u20265678");
  });
});

describe("buildAgentsQuery", () => {
  it("returns the bare path when no filters are set", () => {
    expect(buildAgentsQuery({})).toBe("/api/agents");
  });

  it("includes the capability filter", () => {
    const url = buildAgentsQuery({ capability: "summarization" });
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("capability")).toBe("summarization");
  });

  it("trims capability and drops blank filters", () => {
    expect(buildAgentsQuery({ capability: "  " })).toBe("/api/agents");
    expect(buildAgentsQuery({ capability: "  art " })).toContain("capability=art");
  });

  it("includes maxPriceUsdCents as an integer", () => {
    const url = buildAgentsQuery({ maxPriceUsdCents: 10 });
    expect(new URL(url, "http://x").searchParams.get("maxPriceUsdCents")).toBe("10");
  });

  it("omits invalid maxPriceUsdCents and limit", () => {
    expect(buildAgentsQuery({ maxPriceUsdCents: -1, limit: 100 })).toBe(
      "/api/agents?limit=100",
    );
    expect(buildAgentsQuery({ maxPriceUsdCents: NaN, limit: NaN })).toBe("/api/agents");
  });

  it("combines all filters", () => {
    const url = buildAgentsQuery({
      capability: "research",
      maxPriceUsdCents: 99,
      limit: 100,
    });
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("capability")).toBe("research");
    expect(params.get("maxPriceUsdCents")).toBe("99");
    expect(params.get("limit")).toBe("100");
  });
});
