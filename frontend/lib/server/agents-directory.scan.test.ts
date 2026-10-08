import { describe, expect, it, vi, afterEach } from "vitest";
import {
  decodeRegisterCalldata,
  scanRegisteredUsernames,
  applyFilters,
  type DirectoryAgent,
} from "./agents-directory";

// Real registerPage("thechomps",...) calldata captured from Hedera mainnet
// mirror node (contract 0.0.10854058, ts 1791394487.884407081).
const CHOMPS_CALLDATA = "0xc02fdb2700000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000fc1177680ecf347f06cf3c086fa58ca2713fb4620000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000974686563686f6d70730000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002e516d5779776b3470534331517971376276354e755a4c46744a7973636867484841483839723132616158624b5572000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011d4920616d205468652043686f6d707320e280942074686520414920626568696e64204261636f6e207468652044696e6f20f09fa6962e2054686973207061676520697320616c6c207468696e6773204261636f6e3a206f75722046616365626f6f6b20706167652c20686f6d6520746f20686973206461696c7920766964656f732c20616476656e74757265732c20616e642073696c6c696e6573732c20616e642068697320776562736974652c207061636b656420776974682073746f726965732c2067616d65732c20616e642066756e2e2045766572797468696e6720686572652069732066756e20616e642066616d696c7920667269656e646c792c20616c776179732e204f70657261746564206279206d792068756d616e2e000000";

function mirrorPage(results: unknown[]) {
  return { results, links: { next: null } };
}

function regResult(calldata: string, timestamp: string, error_message: string | null = null) {
  return { timestamp, error_message, function_parameters: calldata, result: undefined };
}

describe("decodeRegisterCalldata", () => {
  it("decodes a real mainnet registerPage call", () => {
    const d = decodeRegisterCalldata(CHOMPS_CALLDATA);
    expect(d).not.toBeNull();
    expect(d!.username).toBe("thechomps");
    expect(d!.ownerType).toBe(1);
    expect(d!.operator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d!.operator.toLowerCase()).not.toBe("0x0000000000000000000000000000000000000000");
  });

  it("rejects non-registerPage calldata", () => {
    expect(decodeRegisterCalldata("0x608060405234801561001057")).toBeNull();
    expect(decodeRegisterCalldata("")).toBeNull();
  });
});

describe("scanRegisteredUsernames (mirror success filter)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps error_message:null results and skips reverted ones", async () => {
    const reverted = { ...regResult(CHOMPS_CALLDATA, "1791394487.884407081"), error_message: "0x2b4e2567" };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(mirrorPage([
        regResult(CHOMPS_CALLDATA, "1791394487.884407081", null),
        reverted,
      ])), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
    const out = await scanRegisteredUsernames("0.0.10854058");
    // REGRESSION: the old `r.result !== "SUCCESS"` check dropped every row
    // because the mirror node has no `result` field — only error_message.
    expect(out.map((u) => u.username)).toEqual(["thechomps"]);
    expect(out[0].registeredAt).toBe("1791394487.884407081");
  });

  it("dedupes repeat registrations, first-seen wins", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(mirrorPage([
        regResult(CHOMPS_CALLDATA, "1791394487.884407081", null),
        regResult(CHOMPS_CALLDATA, "1791394500.000000000", null),
      ])), { status: 200, headers: { "Content-Type": "application/json" } })
    ));
    const out = await scanRegisteredUsernames("0.0.10854058");
    expect(out).toHaveLength(1);
    expect(out[0].registeredAt).toBe("1791394487.884407081");
  });
});

describe("applyFilters (unchanged behavior)", () => {
  const agent = (over: Partial<DirectoryAgent>): DirectoryAgent => ({
    username: "thechomps",
    owner: "0xabc",
    operator: "0xdef",
    purpose: "",
    ipfsHash: "",
    pageUrl: "",
    capabilities: ["video"],
    services: [{ name: "edit", description: "video edit", priceUsdCents: 500, endpoint: "https://x" }],
    reputation: null,
    verifiedReviews: null,
    trust: null,
    availability: null,
    registeredAt: null,
    ...over,
  });

  it("no filters returns everything; limit still applies", () => {
    const agents = [agent({}), agent({ username: "forge" })];
    expect(applyFilters(agents, {})).toHaveLength(2);
    expect(applyFilters(agents, { limit: 1 })).toHaveLength(1);
  });

  it("capability filter is case-insensitive substring over capabilities + services", () => {
    const agents = [
      agent({}),
      agent({ username: "b", capabilities: ["audio"], services: [{ name: "mix", description: "audio mix", priceUsdCents: 100, endpoint: "https://y" }] }),
    ];
    expect(applyFilters(agents, { capability: "VID" }).map((a) => a.username)).toEqual(["thechomps"]);
  });
});
