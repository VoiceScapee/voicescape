/** POST /api/townhall/market/upload — digital-good file pinning. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authed: true,
  quotaAllowed: true,
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
}));

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/townhall/route-auth", () => ({
  sessionCredentialFrom: () => "cred",
}));

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async () =>
      mocks.authed
        ? { ok: true as const, session: { address: "0xabc" } }
        : { ok: false as const, error: "no session" },
  }),
}));

vi.mock("@/lib/server/quota", () => ({
  globalQuotaStore: () => ({
    consume: async () => ({ allowed: mocks.quotaAllowed }),
  }),
  quotaExceededBody: () => ({ error: "quota" }),
  quotaLimitFromEnv: (_k: string, d: number) => d,
}));

vi.mock("@/lib/server/publish.js", () => ({
  publishDigitalGood: async () => ({ cid: mocks.cid, provider: "pinata" }),
  MAX_DIGITAL_GOOD_BYTES: 10 * 1024 * 1024,
}));

import { POST } from "./route";

function postReq(file: File | null): NextRequest {
  const form = new FormData();
  if (file) form.set("file", file);
  return new NextRequest("http://localhost/api/townhall/market/upload", {
    method: "POST",
    body: form,
  });
}

/** Minimal valid 1x1 PNG. */
function pngFile(name = "badge.png"): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  return new File([bytes], name, { type: "image/png" });
}

describe("POST /api/townhall/market/upload", () => {
  beforeEach(() => {
    mocks.authed = true;
    mocks.quotaAllowed = true;
  });

  it("returns 401 without a session", async () => {
    mocks.authed = false;
    const res = await POST(postReq(pngFile()));
    expect(res.status).toBe(401);
  });

  it("returns 400 without a file", async () => {
    const res = await POST(postReq(null));
    expect(res.status).toBe(400);
  });

  it("rejects non-image/pdf/zip bytes", async () => {
    const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], "evil.exe", {
      type: "application/octet-stream",
    });
    const res = await POST(postReq(exe));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unsupported file type/i);
  });

  it("pins a valid image and returns its CID", async () => {
    const res = await POST(postReq(pngFile()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cid: string; kind: string };
    expect(json.cid).toBe(mocks.cid);
    expect(json.kind).toBe("image");
  });

  it("returns 429 when the wallet quota is exhausted", async () => {
    mocks.quotaAllowed = false;
    const res = await POST(postReq(pngFile()));
    expect(res.status).toBe(429);
  });
});
