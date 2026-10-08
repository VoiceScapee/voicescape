/**
 * Unit tests for the /console helper functions: price formatting, query
 * building, username validation, timestamp formatting, HashScan links.
 */
import { describe, expect, it } from "vitest";
import {
  buildConsoleAgentsQuery,
  buildInboxQuery,
  formatConsensusTimestamp,
  formatUsdCents,
  hashscanAccountUrl,
  hashscanContractUrl,
  hashscanTopicUrl,
  parseMaxPriceUsdToCents,
  truncateAddress,
  hashscanTxUrl,
} from "./helpers";

describe("formatUsdCents", () => {
  it("formats integer cents as dollars", () => {
    expect(formatUsdCents(25)).toBe("$0.25");
    expect(formatUsdCents(100)).toBe("$1.00");
    expect(formatUsdCents(0)).toBe("$0.00");
  });
  it("degrades bad input to $0.00", () => {
    expect(formatUsdCents(NaN)).toBe("$0.00");
    expect(formatUsdCents(-50)).toBe("$0.00");
    expect(formatUsdCents(Infinity)).toBe("$0.00");
  });
});

describe("parseMaxPriceUsdToCents", () => {
  it("parses dollars to cents", () => {
    expect(parseMaxPriceUsdToCents("0.10")).toBe(10);
    expect(parseMaxPriceUsdToCents("1")).toBe(100);
  });
  it("returns undefined for blank/invalid/negative", () => {
    expect(parseMaxPriceUsdToCents("")).toBeUndefined();
    expect(parseMaxPriceUsdToCents("abc")).toBeUndefined();
    expect(parseMaxPriceUsdToCents("-1")).toBeUndefined();
  });
});

describe("truncateAddress", () => {
  it("truncates long addresses", () => {
    expect(truncateAddress("0x1234567890abcdef1234")).toBe("0x1234…1234");
  });
  it("passes short values through", () => {
    expect(truncateAddress("0.0.123")).toBe("0.0.123");
  });
});

describe("buildConsoleAgentsQuery", () => {
  it("builds a filtered /api/agents URL", () => {
    const url = buildConsoleAgentsQuery({
      capability: "research",
      maxPriceUsdCents: 50,
      limit: 100,
      availableOnly: true,
    });
    expect(url).toContain("/api/agents?");
    expect(url).toContain("capability=research");
    expect(url).toContain("maxPriceUsdCents=50");
    expect(url).toContain("limit=100");
    expect(url).toContain("available=true");
  });
  it("omits blank filters", () => {
    expect(buildConsoleAgentsQuery({})).toBe("/api/agents");
    expect(buildConsoleAgentsQuery({ capability: "  " })).toBe("/api/agents");
  });
});

describe("buildInboxQuery", () => {
  it("builds the inbox URL for a valid username", () => {
    expect(buildInboxQuery("danny_devito", 10)).toBe(
      "/api/console/inbox?username=danny_devito&limit=10",
    );
  });
  it("normalizes case and clamps the limit", () => {
    expect(buildInboxQuery("DANNY", 99)).toBe(
      "/api/console/inbox?username=danny&limit=25",
    );
  });
  it("returns null for invalid usernames", () => {
    expect(buildInboxQuery("ab", 10)).toBeNull();
    expect(buildInboxQuery("not a name!", 10)).toBeNull();
    expect(buildInboxQuery("", 10)).toBeNull();
  });
});

describe("formatConsensusTimestamp", () => {
  it("converts a consensus timestamp to a date string", () => {
    const out = formatConsensusTimestamp("1700000000.000000000");
    expect(out).not.toBe("1700000000.000000000");
    expect(out).toContain("2023");
  });
  it("passes unparseable input through", () => {
    expect(formatConsensusTimestamp("garbage")).toBe("garbage");
  });
});

describe("hashscan links", () => {
  it("builds topic/account/contract URLs", () => {
    expect(hashscanTopicUrl("0.0.123")).toBe(
      "https://hashscan.io/mainnet/topic/0.0.123",
    );
    expect(hashscanAccountUrl("0.0.456")).toBe(
      "https://hashscan.io/mainnet/account/0.0.456",
    );
    expect(hashscanContractUrl("0.0.10854058")).toBe(
      "https://hashscan.io/mainnet/contract/0.0.10854058",
    );
  });
  it("returns null for malformed input", () => {
    expect(hashscanTopicUrl("nope")).toBeNull();
    expect(hashscanAccountUrl("xyz")).toBeNull();
    expect(hashscanContractUrl("")).toBeNull();
    expect(hashscanTxUrl("0.0.123")).toBeNull();
  });
  it("builds a transaction URL", () => {
    expect(hashscanTxUrl("0.0.123@1700000000.000000000")).toBe(
      "https://hashscan.io/mainnet/transaction/0.0.123@1700000000.000000000",
    );
  });
});
