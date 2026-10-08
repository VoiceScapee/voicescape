/**
 * Reservable claims — mcp-tools integration tests.
 *
 * lookup_blockpage soft-hold surface (H3), the hollow prepare path's
 * automatic reservation, and the second-agent rejection. Mirror-node
 * calls are fixture-driven; the reservation store is the in-memory
 * backend (singleton reset per test).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  lookupBlockpage,
  prepareAgentSelfClaim,
  releaseReservation,
} from "./mcp-tools";
import { reserveHandle, getReservation, releaseMessage } from "./claim-reservations";
import { resetKvStoreSingleton, getKvStore } from "./store";

beforeEach(() => {
  resetKvStoreSingleton();
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** contracts/call fixture: "0x" = name free on-chain. */
const freeNameFetch = (async (url: string) => {
  if (url.includes("/contracts/call")) return ok({ result: "0x" });
  return { ok: false, status: 404, json: async () => null } as unknown as Response;
}) as unknown as typeof fetch;

/** Transport failure: fetchJson catches → status 0 → "availability unknown". */
const deadChainFetch = (async () => {
  throw new Error("socket hangup");
}) as unknown as typeof fetch;

function freshKey(): { pub: string; priv: PrivateKey } {
  const priv = PrivateKey.generateECDSA();
  return { pub: priv.publicKey.toStringRaw().replace(/^0x/, "").toLowerCase(), priv };
}

describe("lookup_blockpage soft-hold surface (H3)", () => {
  it("unreserved + unregistered → plain not-found (unchanged behavior)", async () => {
    const r = await lookupBlockpage("freehandle", freeNameFetch);
    expect(r).toEqual({ found: false, username: "freehandle" });
  });

  it("reserved + unregistered → reserved (soft, unverified) + expiry", async () => {
    const { pub } = freshKey();
    const resv = await reserveHandle(
      { username: "heldhandle", claimant_pubkey: pub, nonce: "n1" },
      getKvStore(),
    );
    expect(resv.ok).toBe(true);
    const r = await lookupBlockpage("heldhandle", freeNameFetch);
    expect(r.found).toBe(false);
    expect(r.reserved).toBe(true);
    expect(r.reservation_label).toBe("reserved (soft, unverified)");
    expect(typeof r.reserved_until).toBe("string");
    expect(r.reservation_funding_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(r.availability).toBeUndefined();
  });

  it("chain unreachable + reservation → availability unknown (never silently open/taken)", async () => {
    const { pub } = freshKey();
    await reserveHandle(
      { username: "darkhandle", claimant_pubkey: pub, nonce: "n1" },
      getKvStore(),
    );
    const r = await lookupBlockpage("darkhandle", deadChainFetch);
    expect(r.found).toBe(false);
    expect(r.reserved).toBe(true);
    expect(r.availability).toBe("unknown");
    expect(r.reservation_label).toBe("availability unknown");
  });

  it("chain unreachable + no reservation → plain not-found (status quo)", async () => {
    const r = await lookupBlockpage("ghosthandle", deadChainFetch);
    expect(r).toEqual({ found: false, username: "ghosthandle" });
  });
});

describe("prepare_agent_self_claim hollow path reserves the handle", () => {
  it("creates a soft reservation and returns it", async () => {
    const { pub } = freshKey();
    const r = await prepareAgentSelfClaim(
      { username: "newagent", purpose: "test agent", ecdsa_public_key: pub },
      freeNameFetch,
    );
    expect(r).not.toHaveProperty("error");
    if ("error" in (r as object)) return;
    const h = r as Extract<typeof r, { hollow: true }>;
    expect(h.hollow).toBe(true);
    expect(h.fund_address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(h.reservation).not.toBeNull();
    expect(h.reservation?.funding_address).toBe(h.fund_address);
    expect(h.reservation?.existing).toBe(false);
    // The reservation is really in the store.
    const live = await getReservation("newagent", getKvStore());
    expect(live?.funding_address).toBe(h.fund_address);
  });

  it("second agent with a different key is rejected with 'reserved until'", async () => {
    const a = freshKey();
    const b = freshKey();
    const first = await prepareAgentSelfClaim(
      { username: "contested", purpose: "first", ecdsa_public_key: a.pub },
      freeNameFetch,
    );
    expect(first).not.toHaveProperty("error");
    const second = await prepareAgentSelfClaim(
      { username: "contested", purpose: "second", ecdsa_public_key: b.pub },
      freeNameFetch,
    );
    expect(second).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/reserved until .* by another agent/) }),
    );
  });

  it("same key re-preparing gets its existing reservation back", async () => {
    const { pub } = freshKey();
    const first = await prepareAgentSelfClaim(
      { username: "patient", purpose: "wait", ecdsa_public_key: pub },
      freeNameFetch,
    );
    const second = await prepareAgentSelfClaim(
      { username: "patient", purpose: "wait", ecdsa_public_key: pub },
      freeNameFetch,
    );
    if ("error" in (first as object) || "error" in (second as object)) {
      throw new Error("unexpected error");
    }
    const f = first as Extract<typeof first, { hollow: true }>;
    const s = second as Extract<typeof second, { hollow: true }>;
    expect(s.reservation?.existing).toBe(true);
    expect(s.reservation?.reservation_id).toBe(f.reservation?.reservation_id);
  });

  it("release_reservation frees the handle (claimant-signed)", async () => {
    const { pub, priv } = freshKey();
    const prep = await prepareAgentSelfClaim(
      { username: "walkaway", purpose: "declined", ecdsa_public_key: pub },
      freeNameFetch,
    );
    if ("error" in (prep as object)) throw new Error("unexpected error");
    const h = prep as Extract<typeof prep, { hollow: true }>;
    const rid = h.reservation?.reservation_id;
    expect(rid).toBeTruthy();
    const sig = Buffer.from(
      priv.sign(Buffer.from(`voicescape:release-reservation:v1:walkaway:${rid}`, "utf8")),
    ).toString("hex");
    // Wrong: also verify the canonical-message helper agrees.
    expect(`voicescape:release-reservation:v1:walkaway:${rid}`).toBe(
      releaseMessage("walkaway", rid!),
    );
    const rel = await releaseReservation({ username: "walkaway", signature: sig });
    expect(rel).toEqual({ released: true, username: "walkaway" });
    // Another agent can now take it.
    const other = freshKey();
    const next = await prepareAgentSelfClaim(
      { username: "walkaway", purpose: "second", ecdsa_public_key: other.pub },
      freeNameFetch,
    );
    expect(next).not.toHaveProperty("error");
  });
});
