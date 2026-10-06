/**
 * Finalize route mode guard tests.
 *
 * Self-mode packages are claimed by the agent's own key — the human
 * wallet finalize flow must refuse them before building anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/claim-packages", () => ({
  getClaimPackage: async (id: string) =>
    id === "c".repeat(32)
      ? { username: "selfbot", mode: "self", ownerAccountId: "0.0.1234" }
      : id === "a".repeat(32)
        ? { username: "sovbot", mode: "sovereign" }
        : null,
  saveClaimPackage: async () => {},
}));

import { POST } from "./route";

const SELF_ID = "c".repeat(32);

function postReq(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/claim-packages/${id}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/claim-packages/[id]/finalize mode guard", () => {
  it("rejects self-mode packages before any wallet flow", async () => {
    const res = await POST(postReq(SELF_ID, { account_id: "0.0.9999" }), {
      params: Promise.resolve({ id: SELF_ID }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.error)).toMatch(/agent's own key/);
  });

  it("still 404s unknown ids", async () => {
    const res = await POST(postReq("b".repeat(32), { account_id: "0.0.9999" }), {
      params: Promise.resolve({ id: "b".repeat(32) }),
    });
    expect(res.status).toBe(404);
  });
});
