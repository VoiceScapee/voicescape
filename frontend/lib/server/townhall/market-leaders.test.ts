import { describe, expect, test } from "vitest";
import { ethers } from "ethers";
import {
  aggregateByAddress,
  EMPTY_BOARDS,
  MARKET_LEADER_LIMIT,
  rankLeaders,
  topicToAddress,
} from "./market-leaders";

const TIP_ABI = [
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
];
const BUY_ABI = [
  "event PurchaseCompleted(address indexed buyer, address indexed seller, string listingRef, uint256 amount, uint256 fee)",
];
const tipIface = new ethers.Interface(TIP_ABI);
const buyIface = new ethers.Interface(BUY_ABI);

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tipLog(from: string, amountTinybar: bigint, username = "alice") {
  const ev = tipIface.getEvent("TipSent")!;
  const encoded = tipIface.encodeEventLog(ev, [username, from, OWNER, amountTinybar, 0n]);
  return { topics: encoded.topics, data: encoded.data };
}

function buyLog(buyer: string, seller: string, amountTinybar: bigint, ref = "listing-1") {
  const ev = buyIface.getEvent("PurchaseCompleted")!;
  const encoded = buyIface.encodeEventLog(ev, [buyer, seller, ref, amountTinybar, 0n]);
  return { topics: encoded.topics, data: encoded.data };
}

const tipAmount = (log: { topics?: string[]; data?: string }) => {
  try {
    const p = tipIface.decodeEventLog("TipSent", log.data ?? "0x", log.topics ?? []);
    return BigInt(p.amount.toString());
  } catch {
    return null;
  }
};

describe("topicToAddress", () => {
  test("extracts the last 20 bytes of a 32-byte topic", () => {
    const padded = "0x000000000000000000000000" + A.slice(2);
    expect(topicToAddress(padded)).toBe(A.toLowerCase());
  });
  test("rejects malformed topics", () => {
    expect(topicToAddress("0x1234")).toBeNull();
    expect(topicToAddress(null)).toBeNull();
    expect(topicToAddress(42)).toBeNull();
  });
});

describe("aggregateByAddress", () => {
  test("groups TipSent logs by sender (topic2) and sums amounts", () => {
    const logs = [
      tipLog(A, 100_000_000n),
      tipLog(A, 200_000_000n),
      tipLog(B, 50_000_000n),
    ];
    const by = aggregateByAddress(logs, 2, tipAmount);
    expect(by.get(A.toLowerCase())).toEqual({ total: 300_000_000n, count: 2 });
    expect(by.get(B.toLowerCase())).toEqual({ total: 50_000_000n, count: 1 });
  });

  test("skips undecodable logs and malformed addresses", () => {
    const logs = [
      { topics: ["0xbad"], data: "0x" },
      tipLog(A, 100_000_000n),
    ];
    const by = aggregateByAddress(logs, 2, tipAmount);
    expect(by.size).toBe(1);
    expect(by.get(A.toLowerCase())?.count).toBe(1);
  });
});

describe("rankLeaders", () => {
  test("ranks by total HBAR desc, honors the limit", () => {
    const by = new Map([
      ["0xaa", { total: 100n, count: 1 }],
      ["0xbb", { total: 300n, count: 2 }],
      ["0xcc", { total: 200n, count: 1 }],
    ]);
    const ranked = rankLeaders(by, 2);
    expect(ranked.map((r) => r.address)).toEqual(["0xbb", "0xcc"]);
    expect(ranked[0].count).toBe(2);
  });

  test("default limit is 10", () => {
    expect(MARKET_LEADER_LIMIT).toBe(10);
  });
});

describe("purchase log aggregation", () => {
  const buyAmount = (log: { topics?: string[]; data?: string }) => {
    try {
      const p = buyIface.decodeEventLog("PurchaseCompleted", log.data ?? "0x", log.topics ?? []);
      return BigInt(p.amount.toString());
    } catch {
      return null;
    }
  };

  test("buyers group by topic1, sellers by topic2", () => {
    const logs = [buyLog(A, B, 500_000_000n), buyLog(A, B, 500_000_000n)];
    const buyers = aggregateByAddress(logs, 1, buyAmount);
    const sellers = aggregateByAddress(logs, 2, buyAmount);
    expect(buyers.get(A.toLowerCase())).toEqual({ total: 1_000_000_000n, count: 2 });
    expect(sellers.get(B.toLowerCase())).toEqual({ total: 1_000_000_000n, count: 2 });
    expect(buyers.has(B.toLowerCase())).toBe(false);
  });
});

describe("EMPTY_BOARDS", () => {
  test("honest empty state — no invented numbers", () => {
    expect(EMPTY_BOARDS.tippers).toEqual([]);
    expect(EMPTY_BOARDS.buyers).toEqual([]);
    expect(EMPTY_BOARDS.sellers).toEqual([]);
  });
});
