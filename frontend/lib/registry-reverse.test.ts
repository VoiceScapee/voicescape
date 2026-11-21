/**
 * Reverse page lookup tests: decode registerPage calldata and pick the
 * latest successful registration from an account's registry calls.
 * No network — calldata is fabricated with ethers, fetch is stubbed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  decodePageFromCalldata,
  decodeUsernameFromCalldata,
  findLatestRegisteredPage,
  findLatestRegisteredUsername,
  resolvePageForOwner,
  resolvePageForOwnerDetailed,
  resolveUsernameForOwner,
  type ContractResultShape,
} from "./registry-reverse";

const CODER = ethers.AbiCoder.defaultAbiCoder();

function registerCalldata(username: string, ownerType: 0 | 1 = 0): string {
  return (
    "0xc02fdb27" +
    CODER.encode(
      ["string", "string", "uint8", "address", "string"],
      [username, "QmTest", ownerType, "0x0000000000000000000000000000000000000000", ""],
    ).slice(2)
  );
}

const OWNER_EVM = "0xfc1177680ecf347f06cf3c086fa58ca2713fb462"; // 0.0.10425049

describe("decodeUsernameFromCalldata", () => {
  it("decodes the username from a registerPage call", () => {
    expect(decodeUsernameFromCalldata(registerCalldata("user-10425049"))).toBe("user-10425049");
  });

  it("returns null for non-registerPage calldata or garbage", () => {
    expect(decodeUsernameFromCalldata(null)).toBeNull();
    expect(decodeUsernameFromCalldata(undefined)).toBeNull();
    expect(decodeUsernameFromCalldata("0x6080604052348015610010")).toBeNull(); // deployment
    expect(decodeUsernameFromCalldata("0xc02fdb27")).toBeNull(); // selector only
    expect(decodeUsernameFromCalldata(registerCalldata("UPPERCASE!"))).toBeNull(); // invalid charset
  });
});

describe("findLatestRegisteredUsername", () => {
  it("returns the newest successful registerPage username", () => {
    const results: ContractResultShape[] = [
      { function_parameters: "0x6080604052", error_message: null }, // deployment, newest
      { function_parameters: registerCalldata("new-name"), error_message: null },
      { function_parameters: registerCalldata("old-name"), error_message: null },
    ];
    expect(findLatestRegisteredUsername(results)).toBe("new-name");
  });

  it("ignores reverted registerPage calls", () => {
    const results: ContractResultShape[] = [
      { function_parameters: registerCalldata("taken-name"), error_message: "revert" },
      { function_parameters: registerCalldata("real-name"), error_message: null },
    ];
    expect(findLatestRegisteredUsername(results)).toBe("real-name");
  });

  it("returns null when the account never registered", () => {
    expect(findLatestRegisteredUsername([])).toBeNull();
    expect(
      findLatestRegisteredUsername([{ function_parameters: "0x6080604052", error_message: null }]),
    ).toBeNull();
  });
});

describe("resolveUsernameForOwner", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/accounts/")) {
          return { ok: true, json: async () => ({ evm_address: OWNER_EVM }) };
        }
        if (url.includes("/results?from=")) {
          return {
            ok: true,
            json: async () => ({
              results: [{ function_parameters: registerCalldata("user-10425049"), error_message: null }],
            }),
          };
        }
        return { ok: false, json: async () => null };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("resolves 0.0.x to the registered username via mirror node", async () => {
    expect(await resolveUsernameForOwner("0.0.10425049")).toBe("user-10425049");
  });

  it("accepts a 0x address directly (no /accounts/ lookup)", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(await resolveUsernameForOwner(OWNER_EVM)).toBe("user-10425049");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/accounts/"))).toBe(false);
  });

  it("returns null for garbage input and failed lookups", async () => {
    expect(await resolveUsernameForOwner("not-an-account")).toBeNull();
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("down"));
    expect(await resolveUsernameForOwner("0.0.1")).toBeNull();
  });
});

describe("decodePageFromCalldata (human vs agent ownerType)", () => {
  it("decodes ownerType 0 as human", () => {
    expect(decodePageFromCalldata(registerCalldata("user-10425049", 0))).toEqual({
      username: "user-10425049",
      ownerType: "human",
    });
  });

  it("decodes ownerType 1 as agent", () => {
    expect(decodePageFromCalldata(registerCalldata("agent-alpha", 1))).toEqual({
      username: "agent-alpha",
      ownerType: "agent",
    });
  });

  it("returns null for malformed calldata or unknown ownerType values", () => {
    expect(decodePageFromCalldata(null)).toBeNull();
    expect(decodePageFromCalldata("0xc02fdb27")).toBeNull();
    // Unknown ownerType value (not 0 or 1) — never assume human
    const bad = "0xc02fdb27" + CODER.encode(
      ["string", "string", "uint8", "address", "string"],
      ["user-x", "QmTest", 2, "0x0000000000000000000000000000000000000000", ""],
    ).slice(2);
    expect(decodePageFromCalldata(bad)).toBeNull();
  });
});

describe("findLatestRegisteredPage", () => {
  it("returns the newest successful registration with its owner type", () => {
    const results: ContractResultShape[] = [
      { function_parameters: registerCalldata("agent-page", 1), error_message: null },
      { function_parameters: registerCalldata("old-human", 0), error_message: null },
    ];
    expect(findLatestRegisteredPage(results)).toEqual({
      username: "agent-page",
      ownerType: "agent",
    });
  });

  it("skips reverted calls", () => {
    const results: ContractResultShape[] = [
      { function_parameters: registerCalldata("reverted", 1), error_message: "revert" },
      { function_parameters: registerCalldata("kept", 0), error_message: null },
    ];
    expect(findLatestRegisteredPage(results)).toEqual({ username: "kept", ownerType: "human" });
  });

  it("returns null when the account never registered", () => {
    expect(findLatestRegisteredPage([])).toBeNull();
  });
});

describe("resolvePageForOwner", () => {
  const AGENT_EVM = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes(`/results?from=${AGENT_EVM}`)) {
          return {
            ok: true,
            json: async () => ({
              results: [{ function_parameters: registerCalldata("agent-alpha", 1), error_message: null }],
            }),
          };
        }
        if (url.includes("/results?from=")) {
          return {
            ok: true,
            json: async () => ({
              results: [{ function_parameters: registerCalldata("user-10425049", 0), error_message: null }],
            }),
          };
        }
        return { ok: false, json: async () => null };
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a human page with its owner type", async () => {
    expect(await resolvePageForOwner(OWNER_EVM)).toEqual({
      username: "user-10425049",
      ownerType: "human",
    });
  });

  it("resolves an agent page with its owner type", async () => {
    expect(await resolvePageForOwner(AGENT_EVM)).toEqual({
      username: "agent-alpha",
      ownerType: "agent",
    });
  });

  it("returns null when the owner never registered", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);
    expect(await resolvePageForOwner("0x1111111111111111111111111111111111111111")).toBeNull();
  });
});

describe("resolvePageForOwnerDetailed (pagination + availability)", () => {
  it("follows the mirror next cursor past 50 results to find the registration", async () => {
    const filler = Array.from({ length: 50 }, () => ({
      function_parameters: "0x6080604052",
      error_message: null,
    }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("timestamp=lt")) {
        return {
          ok: true,
          json: async () => ({
            results: [{ function_parameters: registerCalldata("old-page", 0), error_message: null }],
            links: {},
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          results: filler,
          links: { next: "/api/v1/contracts/0.0.10854058/results?from=0xabc&timestamp=lt:1.2&limit=50" },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = await resolvePageForOwnerDetailed("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
      expect(r).toEqual({ status: "found", page: { username: "old-page", ownerType: "human" } });
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports unavailable (not none) when the mirror node errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => null })),
    );
    try {
      const r = await resolvePageForOwnerDetailed("0x1111111111111111111111111111111111111111");
      expect(r).toEqual({ status: "unavailable" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
