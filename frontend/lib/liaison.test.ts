/**
 * Tests for the liaison shared logic (lib/liaison.ts): tx-ref
 * normalization, entitlement parsing, and the pure mirror-node
 * verification predicates. No network — fixtures only.
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  LIAISON_OWNER_EVM,
  assertLiaisonPriceFloors,
  computeForwardable,
  entitlementAlive,
  isLiaisonTipLog,
  isOwnPageRegisteredLog,
  isSuccessfulContractCall,
  decodeRegisterUsername,
  liaisonBuildPriceHbar,
  liaisonChatPriceHbar,
  liaisonForwardReserveHbar,
  liaisonForwardThresholdHbar,
  liaisonPriceFloorHbar,
  liaisonUsernameTopic,
  normalizeTxRef,
  parseEntitlement,
} from "./liaison";
import { TIPSENT_TOPIC } from "./leaderboard";
import { PAGEREGISTERED_TOPIC } from "./registry-topics";

const SESSION = "0x1111111111111111111111111111111111111111";
const PRICE = 5;

function word(addr: string): string {
  return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
}

function tipLog(overrides: Record<string, unknown> = {}) {
  const amountTinybar = BigInt(5) * BigInt(100_000_000);
  return {
    topics: [
      TIPSENT_TOPIC,
      liaisonUsernameTopic(),
      word(SESSION),
      word(LIAISON_OWNER_EVM),
    ],
    data: "0x" + amountTinybar.toString(16).padStart(64, "0"),
    timestamp: "1789350068.813732104",
    ...overrides,
  };
}

describe("normalizeTxRef", () => {
  it("accepts the wallet/SDK id form", () => {
    expect(normalizeTxRef("0.0.123@1789350068.813732104")).toBe(
      "0.0.123-1789350068-813732104",
    );
  });
  it("accepts the mirror-node id form", () => {
    expect(normalizeTxRef("0.0.123-1789350068-813732104")).toBe(
      "0.0.123-1789350068-813732104",
    );
  });
  it("accepts 0x hashes (lowercased)", () => {
    const h = `0x${"AB".repeat(32)}`;
    expect(normalizeTxRef(h)).toBe(h.toLowerCase());
  });
  it("rejects garbage", () => {
    expect(normalizeTxRef("hello")).toBeNull();
    expect(normalizeTxRef("0.0.1")).toBeNull();
    expect(normalizeTxRef(null)).toBeNull();
    expect(normalizeTxRef(42)).toBeNull();
  });
});

describe("liaisonChatPriceHbar / liaisonBuildPriceHbar", () => {
  it("default to 5 HBAR each", () => {
    expect(liaisonChatPriceHbar({})).toBe(5);
    expect(liaisonBuildPriceHbar({})).toBe(5);
  });
  it("honor their env vars independently", () => {
    expect(liaisonChatPriceHbar({ LIAISON_CHAT_PRICE_HBAR: "10" })).toBe(10);
    expect(liaisonBuildPriceHbar({ LIAISON_CHAT_PRICE_HBAR: "10" })).toBe(5);
    expect(liaisonBuildPriceHbar({ LIAISON_BUILD_PRICE_HBAR: "3" })).toBe(3);
    expect(liaisonChatPriceHbar({ LIAISON_BUILD_PRICE_HBAR: "3" })).toBe(5);
  });
  it("ignore invalid values", () => {
    expect(liaisonChatPriceHbar({ LIAISON_CHAT_PRICE_HBAR: "free" })).toBe(5);
    expect(liaisonBuildPriceHbar({ LIAISON_BUILD_PRICE_HBAR: "-3" })).toBe(5);
  });
});

describe("liaisonPriceFloorHbar + assertLiaisonPriceFloors", () => {
  it("defaults the floor to 1 HBAR", () => {
    expect(liaisonPriceFloorHbar({})).toBe(1);
  });
  it("honors LIAISON_PRICE_FLOOR_HBAR", () => {
    expect(liaisonPriceFloorHbar({ LIAISON_PRICE_FLOOR_HBAR: "2.5" })).toBe(2.5);
  });
  it("passes when both prices are at or above the floor", () => {
    expect(() => assertLiaisonPriceFloors(5, 5, 1)).not.toThrow();
    expect(() => assertLiaisonPriceFloors(1, 1, 1)).not.toThrow();
  });
  it("throws when either price is below the floor (fail closed)", () => {
    expect(() => assertLiaisonPriceFloors(0.5, 5, 1)).toThrow(/LIAISON_CHAT_PRICE_HBAR/);
    expect(() => assertLiaisonPriceFloors(5, 0.5, 1)).toThrow(/LIAISON_BUILD_PRICE_HBAR/);
  });
});

describe("revenue sweep config", () => {
  it("defaults reserve to 1 HBAR and threshold to 0", () => {
    expect(liaisonForwardReserveHbar({})).toBe(1);
    expect(liaisonForwardThresholdHbar({})).toBe(0);
  });
  it("honors env overrides", () => {
    expect(
      liaisonForwardReserveHbar({ LIAISON_FORWARD_RESERVE_HBAR: "2" }),
    ).toBe(2);
    expect(
      liaisonForwardThresholdHbar({ LIAISON_FORWARD_THRESHOLD_HBAR: "0.25" }),
    ).toBe(0.25);
  });
  it("computeForwardable sweeps everything above reserve by default", () => {
    // 2.5 HBAR balance, 1 HBAR reserve, 0 threshold → 1.5 HBAR forwardable.
    expect(computeForwardable(250_000_000n, 100_000_000n, 0n)).toBe(150_000_000n);
  });
  it("computeForwardable returns 0n at or below reserve + threshold", () => {
    expect(computeForwardable(100_000_000n, 100_000_000n, 0n)).toBe(0n);
    expect(computeForwardable(50_000_000n, 100_000_000n, 0n)).toBe(0n);
    // exactly at threshold does not trigger (must EXCEED it)
    expect(computeForwardable(120_000_000n, 100_000_000n, 20_000_000n)).toBe(0n);
    expect(computeForwardable(120_000_001n, 100_000_000n, 20_000_000n)).toBe(20_000_001n);
  });
});

describe("parseEntitlement / entitlementAlive", () => {
  it("parses a valid entitlement", () => {
    expect(
      parseEntitlement({ chatLeft: 50, buildsLeft: 1, expMs: 999 }),
    ).toEqual({ chatLeft: 50, buildsLeft: 1, expMs: 999 });
  });
  it("rejects malformed values", () => {
    expect(parseEntitlement(null)).toBeNull();
    expect(parseEntitlement({ chatLeft: "50", buildsLeft: 1, expMs: 1 })).toBeNull();
    expect(parseEntitlement({})).toBeNull();
  });
  it("alive requires future expiry and remaining credit", () => {
    expect(entitlementAlive({ chatLeft: 1, buildsLeft: 0, expMs: 2000 }, 1000)).toBe(true);
    expect(entitlementAlive({ chatLeft: 0, buildsLeft: 0, expMs: 2000 }, 1000)).toBe(false);
    expect(entitlementAlive({ chatLeft: 5, buildsLeft: 1, expMs: 500 }, 1000)).toBe(false);
  });
});

describe("isSuccessfulContractCall", () => {
  it("accepts SUCCESS contract calls", () => {
    expect(isSuccessfulContractCall({ result: "SUCCESS", name: "CONTRACT_CALL" })).toBe(true);
  });
  it("rejects failures and non-calls", () => {
    expect(isSuccessfulContractCall({ result: "SUCCESS", name: "CRYPTOTRANSFER" })).toBe(false);
    expect(isSuccessfulContractCall({ result: "CONTRACT_REVERT_EXECUTED", name: "CONTRACT_CALL" })).toBe(false);
    expect(isSuccessfulContractCall(null)).toBe(false);
  });
});

describe("isLiaisonTipLog", () => {
  it("accepts a proper tip to danny from the session wallet", () => {
    expect(isLiaisonTipLog(tipLog(), SESSION, PRICE)).toBe(true);
  });
  it("rejects a tip from a different wallet", () => {
    expect(isLiaisonTipLog(tipLog(), "0x2222222222222222222222222222222222222222", PRICE)).toBe(false);
  });
  it("rejects a tip to a different page owner", () => {
    const log = tipLog({ topics: [TIPSENT_TOPIC, liaisonUsernameTopic(), word(SESSION), word(SESSION)] });
    expect(isLiaisonTipLog(log, SESSION, PRICE)).toBe(false);
  });
  it("rejects a tip for a different username (wrong topic)", () => {
    const other = ethers.keccak256(ethers.toUtf8Bytes("someone-else"));
    const log = tipLog({ topics: [TIPSENT_TOPIC, other, word(SESSION), word(LIAISON_OWNER_EVM)] });
    expect(isLiaisonTipLog(log, SESSION, PRICE)).toBe(false);
  });
  it("rejects an underpriced tip", () => {
    const small = BigInt(1) * BigInt(100_000_000);
    const log = tipLog({ data: "0x" + small.toString(16).padStart(64, "0") });
    expect(isLiaisonTipLog(log, SESSION, PRICE)).toBe(false);
  });
  it("rejects non-TipSent logs", () => {
    expect(isLiaisonTipLog({ topics: [], data: "0x", timestamp: "1.1" }, SESSION, PRICE)).toBe(false);
  });
});

describe("decodeRegisterUsername", () => {
  it("decodes the username from registerPage calldata", () => {
    const iface = new ethers.Interface([
      "function registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)",
    ]);
    const data = iface.encodeFunctionData("registerPage", [
      "my-page",
      "bafycid",
      0,
      "0x0000000000000000000000000000000000000000",
      "",
    ]);
    expect(decodeRegisterUsername(data)).toBe("my-page");
  });
  it("rejects garbage", () => {
    expect(decodeRegisterUsername("0x1234")).toBeNull();
    expect(decodeRegisterUsername(null)).toBeNull();
  });
});

describe("isOwnPageRegisteredLog", () => {
  const usernameTopic = ethers.keccak256(ethers.toUtf8Bytes("my-page"));
  const log = {
    topics: [PAGEREGISTERED_TOPIC, usernameTopic, word(SESSION)],
    data: "0x",
    timestamp: "1789350068.1",
  };
  it("matches the wallet's own registration", () => {
    expect(isOwnPageRegisteredLog(log, "my-page", SESSION)).toBe(true);
  });
  it("rejects another wallet's registration", () => {
    expect(
      isOwnPageRegisteredLog(log, "my-page", "0x2222222222222222222222222222222222222222"),
    ).toBe(false);
  });
  it("rejects a different username", () => {
    expect(isOwnPageRegisteredLog(log, "other-page", SESSION)).toBe(false);
  });
});
