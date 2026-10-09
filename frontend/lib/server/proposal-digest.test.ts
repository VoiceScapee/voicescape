
/**
 * Tests for proposal digest binding + manifest class
 * (lib/server/pending-actions.ts — receipts thread).
 *
 * The digest is keccak256 of the raw UTF-8 canonical proposal message
 * (static content + immutable refs) — same construction as
 * release_reservation's digest. The manifest class splits refs into
 * immutable (hash-addressed) vs mutable (plain URLs, declared set only).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import type { ClaimPageSpec } from "./page-customize";
import {
  stashPageUpdateProposal,
  proposalDigest,
  buildProposalManifest,
  classifyRef,
} from "./pending-actions";

function fakeStore(): KvStore {
  const map = new Map<string, string>();
  return {
    async get(k: string) { return map.get(k) ?? null; },
    async set(k: string, v: string) { map.set(k, v); },
    async del(k: string) { map.delete(k); },
    async incr() { return 1; },
    async setNx(k: string, v: string) { if (map.has(k)) return false; map.set(k, v); return true; },
    async clearPrefix(prefix: string) { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); },
  };
}

const BASE_SPEC: ClaimPageSpec = {
  username: "thechomps",
  ownerType: "agent" as const,
  displayName: "The Chomps",
  purpose: "Demo agent page",
  capabilities: ["demo", "tips"],
  operator: "0x0000000000000000000000000000000000000000",
  templateId: "dino",
  theme: null,
  socials: [
    { platform: "x", url: "https://x.com/thechomps" },
    { platform: "ipfs", url: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" },
  ],
  links: [
    { label: "docs", url: "https://example.com/docs" },
    { label: "avatar", url: "data:image/png;base64,iVBORw0KGgo=" },
  ],
};

const INPUT = {
  owner_account_id: "0.0.10425049",
  spec: BASE_SPEC,
  change_summary: "Updated the bio text",
  token_id: "a".repeat(16),
};

describe("proposal manifest class", () => {
  it("splits refs into immutable vs mutable", () => {
    const m = buildProposalManifest(BASE_SPEC);
    expect(m.static.displayName).toBe("The Chomps");
    expect(m.static.capabilities).toEqual(["demo", "tips"]);
    expect(m.immutableRefs).toHaveLength(2);
    expect(m.immutableRefs.some((u) => u.startsWith("ipfs://"))).toBe(true);
    expect(m.immutableRefs.some((u) => u.startsWith("data:"))).toBe(true);
    expect(m.mutableRefs).toHaveLength(2);
    expect(m.mutableRefs.some((u) => u.includes("x.com"))).toBe(true);
    expect(m.mutableRefs.some((u) => u.includes("example.com"))).toBe(true);
  });

  it("classifies bare CIDs as immutable", () => {
    expect(classifyRef("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe("immutable");
    expect(classifyRef("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe("immutable");
    expect(classifyRef("https://x.com/foo")).toBe("mutable");
    expect(classifyRef("")).toBe("mutable");
  });

  it("dedupes and sorts ref lists", () => {
    const m = buildProposalManifest({
      ...BASE_SPEC,
      links: [
        { label: "b", url: "https://example.com/b" },
        { label: "a", url: "https://example.com/a" },
        { label: "b2", url: "https://example.com/b" },
      ],
      socials: null,
    });
    expect(m.mutableRefs).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});

describe("proposal digest binding", () => {
  let store: KvStore;
  beforeEach(() => { store = fakeStore(); });

  it("is deterministic — same proposal → same digest", () => {
    const d1 = proposalDigest(BASE_SPEC);
    const d2 = proposalDigest(BASE_SPEC);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("binds static content — tampered content → different digest", () => {
    const base = proposalDigest(BASE_SPEC);
    expect(proposalDigest({ ...BASE_SPEC, displayName: "Evil Chomps" })).not.toBe(base);
    expect(proposalDigest({ ...BASE_SPEC, purpose: "changed" })).not.toBe(base);
    expect(proposalDigest({ ...BASE_SPEC, capabilities: ["demo"] })).not.toBe(base);
  });

  it("binds immutable refs — tampered CID → different digest", () => {
    const base = proposalDigest(BASE_SPEC);
    const tampered: ClaimPageSpec = {
      ...BASE_SPEC,
      socials: [{ platform: "ipfs", url: "ipfs://bafyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    };
    expect(proposalDigest(tampered)).not.toBe(base);
  });

  it("is order-insensitive to key order in the input object", () => {
    const reordered = {
      links: BASE_SPEC.links,
      socials: BASE_SPEC.socials,
      theme: null,
      templateId: "dino",
      operator: BASE_SPEC.operator,
      capabilities: ["demo", "tips"],
      purpose: "Demo agent page",
      displayName: "The Chomps",
      ownerType: "agent" as const,
      username: "thechomps",
    };
    expect(proposalDigest(reordered)).toBe(proposalDigest(BASE_SPEC));
  });

  it("stashPageUpdateProposal stores digest + manifest on the proposal", async () => {
    const action = await stashPageUpdateProposal(INPUT, store);
    expect(action.pageUpdate?.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(action.pageUpdate?.digest).toBe(proposalDigest(BASE_SPEC));
    expect(action.pageUpdate?.manifest.static.displayName).toBe("The Chomps");
    expect(action.pageUpdate?.manifest.immutableRefs).toHaveLength(2);
    expect(action.pageUpdate?.manifest.mutableRefs).toHaveLength(2);
  });
});
