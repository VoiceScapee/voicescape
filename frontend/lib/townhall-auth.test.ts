/**
 * postJson session-header tests: the x-vs-session credential must ride along
 * on the first attempt AND on the dust-fee retry (the pay-then-retry loop in
 * useDustFee calls postJson twice with the same helper).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson, DustFeeRequired } from "./townhall";
import { setAuthHeaderProvider } from "./auth-client";

const HEADER = "x-vs-session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  setAuthHeaderProvider(null);
  vi.unstubAllGlobals();
});

describe("postJson session headers", () => {
  it("sends the session header on the attempt", async () => {
    setAuthHeaderProvider(() => ({ [HEADER]: "cred-abc" }));
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return jsonResponse(200, { ok: true });
    });
    await postJson("/api/townhall/posts", { body: "hi" });
    expect(seen).toHaveLength(1);
    expect(seen[0][HEADER]).toBe("cred-abc");
  });

  it("keeps the session header on the dust-fee retry", async () => {
    setAuthHeaderProvider(() => ({ [HEADER]: "cred-abc" }));
    const seen: Record<string, string>[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      seen.push({ ...(init?.headers as Record<string, string>) });
      if (calls === 1) return jsonResponse(402, { dustFeeTinybars: 1000, treasury: "0.0.999" });
      return jsonResponse(200, { ok: true });
    });
    // First attempt: 402 -> DustFeeRequired (the retry trigger).
    await expect(postJson("/api/townhall/posts", { body: "hi" })).rejects.toBeInstanceOf(
      DustFeeRequired,
    );
    // Retry after paying the fee: header must still be attached.
    await postJson("/api/townhall/posts", { body: "hi", dustFeeTxId: "0.0.1@1.2" });
    expect(seen).toHaveLength(2);
    expect(seen[0][HEADER]).toBe("cred-abc");
    expect(seen[1][HEADER]).toBe("cred-abc");
  });

  it("sends no session header when signed out", async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return jsonResponse(200, { ok: true });
    });
    await postJson("/api/townhall/posts", { body: "hi" });
    expect(seen[0][HEADER]).toBeUndefined();
  });
});
