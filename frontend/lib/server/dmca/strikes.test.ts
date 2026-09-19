import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStrikes,
  getCopyrightStatus,
  getMaxStrikes,
  isCopyrightSuspended,
  recordStrike,
} from "./strikes";
import { resetKvStoreSingleton } from "../store";

const W = "0xABCDEF0000000000000000000000000000000001";

describe("dmca strikes (repeat-infringer policy)", () => {
  beforeEach(() => {
    resetKvStoreSingleton();
    vi.stubEnv("DMCA_MAX_STRIKES", "");
  });

  it("defaults to a 3-strike threshold", () => {
    expect(getMaxStrikes()).toBe(3);
  });

  it("honors DMCA_MAX_STRIKES and clamps invalid values", () => {
    vi.stubEnv("DMCA_MAX_STRIKES", "5");
    expect(getMaxStrikes()).toBe(5);
    for (const bad of ["0", "-2", "abc", "2.5"]) {
      vi.stubEnv("DMCA_MAX_STRIKES", bad);
      expect(getMaxStrikes()).toBe(3);
    }
  });

  it("records strikes and suspends at the threshold", async () => {
    expect(await isCopyrightSuspended(W)).toBe(false);
    const r1 = await recordStrike(W, "n1");
    expect(r1).toMatchObject({ strikes: 1, maxStrikes: 3, suspended: false });
    const r2 = await recordStrike(W, "n2");
    expect(r2.suspended).toBe(false);
    const r3 = await recordStrike(W, "n3");
    expect(r3).toMatchObject({ strikes: 3, suspended: true });
    expect(await isCopyrightSuspended(W)).toBe(true);
    const status = await getCopyrightStatus(W);
    expect(status).toEqual({ strikes: 3, maxStrikes: 3, suspended: true });
  });

  it("keys strikes on the canonical address, not usernames or address case", async () => {
    await recordStrike("0.0.12345", "n1");
    // canonical 0.0.12345 and its long-zero 0x form must agree
    const upper = "0xABCDEF0000000000000000000000000000000001";
    await recordStrike(upper, "n9");
    const status = await getCopyrightStatus(upper.toLowerCase());
    expect(status.strikes).toBe(1);
  });

  it("clearStrikes resets the count (successful appeal)", async () => {
    vi.stubEnv("DMCA_MAX_STRIKES", "1");
    await recordStrike(W, "n1");
    expect(await isCopyrightSuspended(W)).toBe(true);
    await clearStrikes(W);
    expect(await isCopyrightSuspended(W)).toBe(false);
    expect((await getCopyrightStatus(W)).strikes).toBe(0);
  });

  it("rejects invalid wallet addresses", async () => {
    await expect(recordStrike("not-a-wallet", "n1")).rejects.toThrow(/invalid wallet/);
    expect(await isCopyrightSuspended("")).toBe(false);
  });

  it("works against the real memory backend through getKvStore", async () => {
    // resetKvStoreSingleton() in beforeEach gives a fresh in-memory store
    await recordStrike(W, "n1");
    await recordStrike(W, "n2");
    expect((await getCopyrightStatus(W)).strikes).toBe(2);
  });
});
