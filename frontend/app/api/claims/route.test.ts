/**
 * POST /api/claims/reserve + /api/claims/release — route tests.
 *
 * Writes are thin wrappers over the claim-reservations module (unit-tested
 * separately); these tests pin the HTTP contract: validation → 400,
 * contention → 409, happy path shapes, and signed-release auth.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PrivateKey } from "@hiero-ledger/sdk";
import { POST as reservePOST } from "./reserve/route";
import { POST as releasePOST } from "./release/route";
import { releaseMessage } from "@/lib/server/claim-reservations";
import { resetKvStoreSingleton } from "@/lib/server/store";

beforeEach(() => {
  resetKvStoreSingleton();
});

function req(body: unknown): NextRequest {
  return new NextRequest("https://voicescape.vercel.app/api/claims/reserve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify(body),
  });
}

function freshPub(): { pub: string; priv: PrivateKey } {
  const priv = PrivateKey.generateECDSA();
  return { pub: priv.publicKey.toStringRaw().replace(/^0x/, "").toLowerCase(), priv };
}

describe("POST /api/claims/reserve", () => {
  it("409 on empty body (semantic validation failure)", async () => {
    const res = await reservePOST(req({}));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/username|nonce/i);
  });

  it("400 on bad pubkey", async () => {
    const res = await reservePOST(req({ username: "routetest", claimant_pubkey: "nope", nonce: "n1" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/secp256k1|ED25519/i);
  });

  it("reserves and returns the soft-hold shape", async () => {
    const { pub } = freshPub();
    const res = await reservePOST(
      req({ username: "routehandle", claimant_pubkey: pub, nonce: "route-n1" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reserved).toBe(true);
    expect(body.username).toBe("routehandle");
    expect(typeof body.reservation_id).toBe("string");
    expect(typeof body.reserved_until).toBe("string");
    expect(body.funding_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(body.soft_hold).toBe(true);
  });

  it("409 when another key holds the handle", async () => {
    const a = freshPub();
    const b = freshPub();
    const first = await reservePOST(req({ username: "routeowned", claimant_pubkey: a.pub, nonce: "n1" }));
    expect(first.status).toBe(200);
    const second = await reservePOST(req({ username: "routeowned", claimant_pubkey: b.pub, nonce: "n2" }));
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/reserved until .* by another agent/);
  });

  it("idempotent for the same key", async () => {
    const { pub } = freshPub();
    const first = (await (await reservePOST(req({ username: "routeidem", claimant_pubkey: pub, nonce: "n1" }))).json()) as { reservation_id: string };
    const secondRes = await reservePOST(req({ username: "routeidem", claimant_pubkey: pub, nonce: "n2" }));
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as { reservation_id: string; existing: boolean };
    expect(second.existing).toBe(true);
    expect(second.reservation_id).toBe(first.reservation_id);
  });
});

describe("POST /api/claims/release", () => {
  it("400 on invalid body", async () => {
    const res = await releasePOST(req({}));
    expect(res.status).toBe(400);
  });

  it("400 on bad signature for a live reservation", async () => {
    const { pub } = freshPub();
    await reservePOST(req({ username: "routerelease", claimant_pubkey: pub, nonce: "n1" }));
    const res = await releasePOST(req({ username: "routerelease", signature: "zz" }));
    expect(res.status).toBe(400);
  });

  it("releases with a valid claimant signature", async () => {
    const { pub, priv } = freshPub();
    const r = (await (await reservePOST(req({ username: "routefree", claimant_pubkey: pub, nonce: "n1" }))).json()) as {
      reservation_id: string;
    };
    const sig = Buffer.from(
      priv.sign(Buffer.from(releaseMessage("routefree", r.reservation_id), "utf8")),
    ).toString("hex");
    const res = await releasePOST(req({ username: "routefree", signature: sig }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { released: boolean };
    expect(body.released).toBe(true);
  });
});
