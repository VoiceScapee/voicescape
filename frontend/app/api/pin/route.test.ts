/**
 * POST /api/pin auth tests: pinning is a write — it must 401 before touching
 * the body when no verifiable wallet session is presented.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { globalQuotaStore } from "@/lib/server/quota";

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    // The route sends the session TOKEN string now (not message/signature).
    verifySession: async (cred: unknown) => {
      if (cred === GOOD_TOKEN) {
        return {
          ok: true,
          session: {
            address: "0xabc",
            chainId: 296,
            username: "tester",
            nonce: "n1",
            issuedAtMs: 1_000_000,
            expiresAtMs: 999,
          },
        };
      }
      return { ok: false, error: "missing session: sign in with your wallet" };
    },
  }),
}));

// Never hit Pinata in tests — auth is checked before any publish call.
vi.mock("../../../lib/server/publish.js", () => ({
  publishAudioFile: async () => ({ cid: "bafytest", provider: "pinata" }),
  publishImageFile: async () => ({ cid: "bafyimagetest", provider: "pinata" }),
  publishPageJson: async () => ({ cid: "bafytest", provider: "pinata" }),
}));

const GOOD_TOKEN = "tokgood.siggood";

import { POST } from "./route";

function pinReq(opts: { token?: string; json?: unknown }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.token) headers[SESSION_HEADER] = opts.token;
  return new NextRequest("http://localhost/api/pin", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.json ?? { title: "x" }),
  });
}

describe("POST /api/pin auth", () => {
  it("returns 401 with no session header", async () => {
    const res = await POST(pinReq({}));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/sign in/i);
  });

  it("returns 401 for an unverifiable credential", async () => {
    const res = await POST(pinReq({ token: "bad-token" }));
    expect(res.status).toBe(401);
  });

  it("passes auth with a verifiable session and pins", async () => {
    const res = await POST(
      pinReq({ token: GOOD_TOKEN, json: { title: "hello" } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cid: string };
    expect(json.cid).toBe("bafytest");
  });
});

describe("POST /api/pin quota", () => {
  it("returns 429 after the JSON pin daily quota is spent", async () => {
    const old = process.env.PIN_DAILY_QUOTA;
    process.env.PIN_DAILY_QUOTA = "2";
    await globalQuotaStore().clearAll();
    try {
      const tok = GOOD_TOKEN;
      expect((await POST(pinReq({ token: tok, json: { title: "a" } }))).status).toBe(200);
      expect((await POST(pinReq({ token: tok, json: { title: "b" } }))).status).toBe(200);
      const res = await POST(pinReq({ token: tok, json: { title: "c" } }));
      expect(res.status).toBe(429);
      const json = (await res.json()) as { error: string; limit: number; resetsAt: string };
      expect(json.error).toBe("daily page pin limit reached (2/day)");
      expect(json.limit).toBe(2);
      expect(json.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.PIN_DAILY_QUOTA;
      else process.env.PIN_DAILY_QUOTA = old;
    }
  });

  it("returns 429 after the audio pin daily quota is spent", async () => {
    const old = process.env.AUDIO_DAILY_QUOTA;
    process.env.AUDIO_DAILY_QUOTA = "1";
    await globalQuotaStore().clearAll();
    try {
      const mkAudioReq = () => {
        const form = new FormData();
        // Realistic MP3 bytes: ID3 header so the magic-byte screen passes.
        const mp3 = new Uint8Array(1024);
        mp3.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        form.append("file", new File([mp3], "track.mp3", { type: "audio/mpeg" }));
        const headers: Record<string, string> = {
          [SESSION_HEADER]: GOOD_TOKEN,
        };
        return new NextRequest("http://localhost/api/pin", { method: "POST", headers, body: form });
      };
      expect((await POST(mkAudioReq())).status).toBe(200);
      const res = await POST(mkAudioReq());
      expect(res.status).toBe(429);
      const json = (await res.json()) as { error: string; limit: number };
      expect(json.error).toBe("daily audio pin limit reached (1/day)");
      expect(json.limit).toBe(1);
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.AUDIO_DAILY_QUOTA;
      else process.env.AUDIO_DAILY_QUOTA = old;
    }
  });

  it("does not spend pin quota on a 401", async () => {
    // An anonymous caller is rejected before any quota check; a later
    // authenticated call from the same quota state must still be allowed.
    const old = process.env.PIN_DAILY_QUOTA;
    process.env.PIN_DAILY_QUOTA = "1";
    await globalQuotaStore().clearAll();
    try {
      expect((await POST(pinReq({}))).status).toBe(401);
      const res = await POST(pinReq({ token: GOOD_TOKEN, json: { title: "x" } }));
      expect(res.status).toBe(200);
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.PIN_DAILY_QUOTA;
      else process.env.PIN_DAILY_QUOTA = old;
    }
  });
});

describe("POST /api/pin image upload (kind=image)", () => {
  // Realistic 1x1 PNG bytes so the magic-byte screen passes.
  function pngFile(name = "avatar.png", type = "image/png"): File {
    const png = new Uint8Array(72);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([png], name, { type });
  }
  function imageReq(file: File): NextRequest {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", "image");
    return new NextRequest("http://localhost/api/pin", {
      method: "POST",
      headers: { [SESSION_HEADER]: GOOD_TOKEN },
      body: form,
    });
  }

  it("pins a valid image and returns its CID", async () => {
    const old = process.env.IMAGE_DAILY_QUOTA;
    process.env.IMAGE_DAILY_QUOTA = "10";
    await globalQuotaStore().clearAll();
    try {
      const res = await POST(imageReq(pngFile()));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { cid?: string; provider?: string };
      expect(json.cid).toBe("bafyimagetest");
      expect(json.provider).toBe("pinata");
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.IMAGE_DAILY_QUOTA;
      else process.env.IMAGE_DAILY_QUOTA = old;
    }
  });

  it("rejects non-image bytes even when the client declares image/*", async () => {
    const old = process.env.IMAGE_DAILY_QUOTA;
    process.env.IMAGE_DAILY_QUOTA = "10";
    await globalQuotaStore().clearAll();
    try {
      const exe = new Uint8Array(64);
      exe.set([0x4d, 0x5a, 0x90, 0x00]); // MZ header — a disguised executable
      const res = await POST(
        imageReq(new File([exe], "evil.png", { type: "image/png" })),
      );
      expect(res.status).toBe(400);
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.IMAGE_DAILY_QUOTA;
      else process.env.IMAGE_DAILY_QUOTA = old;
    }
  });

  it("rejects images over the 5 MB cap", async () => {
    const old = process.env.IMAGE_DAILY_QUOTA;
    process.env.IMAGE_DAILY_QUOTA = "10";
    await globalQuotaStore().clearAll();
    try {
      const big = new Uint8Array(6 * 1024 * 1024);
      big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = await POST(imageReq(new File([big], "big.png", { type: "image/png" })));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toMatch(/too large/i);
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.IMAGE_DAILY_QUOTA;
      else process.env.IMAGE_DAILY_QUOTA = old;
    }
  });

  it("returns 429 after the image pin daily quota is spent", async () => {
    const old = process.env.IMAGE_DAILY_QUOTA;
    process.env.IMAGE_DAILY_QUOTA = "1";
    await globalQuotaStore().clearAll();
    try {
      expect((await POST(imageReq(pngFile()))).status).toBe(200);
      const res = await POST(imageReq(pngFile()));
      expect(res.status).toBe(429);
      const json = (await res.json()) as { error: string; limit: number };
      expect(json.error).toBe("daily image pin limit reached (1/day)");
      expect(json.limit).toBe(1);
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.IMAGE_DAILY_QUOTA;
      else process.env.IMAGE_DAILY_QUOTA = old;
    }
  });

  it("keeps the audio path when kind is absent", async () => {
    const old = process.env.AUDIO_DAILY_QUOTA;
    process.env.AUDIO_DAILY_QUOTA = "10";
    await globalQuotaStore().clearAll();
    try {
      const form = new FormData();
      const mp3 = new Uint8Array(1024);
      mp3.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      form.append("file", new File([mp3], "track.mp3", { type: "audio/mpeg" }));
      const res = await POST(
        new NextRequest("http://localhost/api/pin", {
          method: "POST",
          headers: { [SESSION_HEADER]: GOOD_TOKEN },
          body: form,
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { cid?: string };
      expect(json.cid).toBe("bafytest");
    } finally {
      await globalQuotaStore().clearAll();
      if (old === undefined) delete process.env.AUDIO_DAILY_QUOTA;
      else process.env.AUDIO_DAILY_QUOTA = old;
    }
  });
});
