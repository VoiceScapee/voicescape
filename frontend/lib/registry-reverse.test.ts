/**
 * Reverse page lookup tests: decode registerPage calldata and pick the
 * latest successful registration from an account's registry calls.
 * No network — calldata is fabricated with ethers, fetch is stubbed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  decodeUsernameFromCalldata,
  findLatestRegisteredUsername,
  resolveUsernameForOwner,
  type ContractResultShape,
} from "./registry-reverse";

const CODER = ethers.AbiCoder.defaultAbiCoder();

function registerCalldata(username: string): string {
  return (
    "0xc02fdb27" +
    CODER.encode(
      ["string", "string", "uint8", "address", "string"],
      [username, "QmTest", 0, "0x0000000000000000000000000000000000000000", ""],
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
