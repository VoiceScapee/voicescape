import { describe, it, expect } from "vitest";
import {
  canonicalizeHCS27Json,
  hashHCS27Leaf,
  hashHCS27Node,
  merkleRootFromEntries,
  emptyHCS27Root,
  leafHashHexFromEntry,
  toBase64Url,
  buildCheckpoint,
  serializeCheckpoint,
  VOICESCAPE_AUDIT_TYPE,
} from "./index";

describe("hcs27 merkle", () => {
  it("canonicalizes JSON with sorted keys and no whitespace", () => {
    const buf = canonicalizeHCS27Json({ b: 2, a: 1 });
    expect(buf.toString("utf8")).toBe('{"a":1,"b":2}');
  });

  it("produces deterministic leaf hashes", () => {
    const h1 = leafHashHexFromEntry({ subject: "0.0.123", verdict: "clean" });
    const h2 = leafHashHexFromEntry({ verdict: "clean", subject: "0.0.123" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("empty root is sha256 of empty string", () => {
    expect(emptyHCS27Root().toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("single-entry root equals leaf hash", () => {
    const entry = { x: 1 };
    const root = merkleRootFromEntries([entry]);
    const leaf = hashHCS27Leaf(canonicalizeHCS27Json(entry));
    expect(root.equals(leaf)).toBe(true);
  });

  it("two-entry root is hash of concatenated leaf hashes", () => {
    const root = merkleRootFromEntries([{ a: 1 }, { b: 2 }]);
    const l1 = hashHCS27Leaf(canonicalizeHCS27Json({ a: 1 }));
    const l2 = hashHCS27Leaf(canonicalizeHCS27Json({ b: 2 }));
    const expected = hashHCS27Node(l1, l2);
    expect(root.equals(expected)).toBe(true);
  });

  it("root changes when any entry changes", () => {
    const r1 = merkleRootFromEntries([{ a: 1 }, { b: 2 }]);
    const r2 = merkleRootFromEntries([{ a: 1 }, { b: 3 }]);
    expect(r1.equals(r2)).toBe(false);
  });

  it("toBase64Url produces unpadded base64url", () => {
    const out = toBase64Url(Buffer.from([0xfb, 0xff, 0xfe]));
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
    expect(out).not.toContain("=");
  });
});

describe("hcs27 checkpoint", () => {
  it("builds a valid checkpoint message", () => {
    const entries = [
      { subject: "0.0.123", verdict: "clean", report_hash: "abc" },
      { subject: "0.0.456", verdict: "flagged", report_hash: "def" },
    ];
    const cp = buildCheckpoint("agent-reviews", entries);

    expect(cp.p).toBe("hcs-27");
    expect(cp.op).toBe("register");
    expect(cp.metadata.type).toBe(VOICESCAPE_AUDIT_TYPE);
    expect(cp.metadata.stream.registry).toBe("voicescape");
    expect(cp.metadata.stream.log_id).toBe("agent-reviews");
    expect(cp.metadata.log.alg).toBe("sha-256");
    expect(cp.metadata.log.merkle).toBe("rfc9162");
    expect(cp.metadata.root.treeSize).toBe("2");
    expect(cp.metadata.root.rootHashB64u).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cp.metadata.prev).toBeNull();
    expect(cp.metadata.sig).toBeNull();
  });

  it("chains checkpoints via prev", () => {
    const cp1 = buildCheckpoint("agent-reviews", [{ a: 1 }]);
    const cp2 = buildCheckpoint(
      "agent-reviews",
      [{ a: 1 }, { b: 2 }],
      {
        treeSize: cp1.metadata.root.treeSize,
        rootHashB64u: cp1.metadata.root.rootHashB64u,
      },
    );
    expect(cp2.metadata.prev?.rootHashB64u).toBe(
      cp1.metadata.root.rootHashB64u,
    );
  });

  it("serializes to JSON", () => {
    const cp = buildCheckpoint("agent-reviews", [{ a: 1 }], null, "test memo");
    const s = serializeCheckpoint(cp);
    const parsed = JSON.parse(s);
    expect(parsed.p).toBe("hcs-27");
    expect(parsed.m).toBe("test memo");
  });

  it("memo is capped at 299 chars", () => {
    const cp = buildCheckpoint("x", [], null, "y".repeat(500));
    expect(cp.m!.length).toBe(299);
  });
});
