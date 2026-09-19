import { beforeEach, describe, expect, it } from "vitest";
import {
  getDataRightsRequest,
  isDataRightsKind,
  listDataRightsRequests,
  markDataRightsAnswered,
  submitDataRightsRequest,
} from "./data-rights";
import { resetKvStoreSingleton } from "../store";

const W = "0.0.777";

describe("data-rights requests", () => {
  beforeEach(() => resetKvStoreSingleton());

  it("records a request keyed to the canonical wallet, with a timestamp", async () => {
    const r = await submitDataRightsRequest(W, "access", "what do you hold about me?");
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.wallet).not.toBe(W); // canonicalized
    expect(r.status).toBe("pending");
    expect(new Date(r.receivedAt).getTime()).toBeLessThanOrEqual(Date.now());
    const back = await getDataRightsRequest(r.id);
    expect(back?.kind).toBe("access");
  });

  it("rejects bad kinds, wallets, and malformed ids", async () => {
    await expect(submitDataRightsRequest("nope", "access", "")).rejects.toThrow(/invalid wallet/);
    // @ts-expect-error testing runtime rejection
    await expect(submitDataRightsRequest(W, "export", "")).rejects.toThrow(/invalid request kind/);
    expect(await getDataRightsRequest("../evil")).toBeNull();
    expect(await markDataRightsAnswered("0".repeat(36))).toBeNull();
  });

  it("lists newest-first and marks answered", async () => {
    const a = await submitDataRightsRequest(W, "deletion", "");
    const b = await submitDataRightsRequest(W, "restriction", "");
    expect((await listDataRightsRequests()).map((r) => r.id)).toEqual([b.id, a.id]);
    const marked = await markDataRightsAnswered(a.id);
    expect(marked?.status).toBe("answered");
    expect(marked?.answeredAt).toBeDefined();
  });

  it("validates kinds", () => {
    expect(isDataRightsKind("access")).toBe(true);
    expect(isDataRightsKind("export")).toBe(false);
    expect(isDataRightsKind(null)).toBe(false);
  });
});
