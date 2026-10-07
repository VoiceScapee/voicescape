import { describe, it, expect, vi } from "vitest";
import {
  getLastCheckpointRoot,
  publishCheckpoint,
  publishReviewCheckpoint,
  REVIEWS_LOG_ID,
} from "./publisher";
import { buildCheckpoint, VOICESCAPE_HCS27_TOPIC } from "./checkpoint";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

describe("hcs27 publisher", () => {
  describe("getLastCheckpointRoot", () => {
    it("returns null when the topic has no messages", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      const root = await getLastCheckpointRoot({ fetchFn });
      expect(root).toBeNull();
    });

    it("parses the last checkpoint root for prev-linkage", async () => {
      const cp = buildCheckpoint("agent-reviews", [{ a: 1 }]);
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ message: b64(cp) }] }),
      });
      const root = await getLastCheckpointRoot({ fetchFn });
      expect(root).not.toBeNull();
      expect(root!.treeSize).toBe("1");
      expect(root!.rootHashB64u).toBe(cp.metadata.root.rootHashB64u);
    });

    it("returns null on mirror node failure (fail-open)", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ ok: false });
      expect(await getLastCheckpointRoot({ fetchFn })).toBeNull();
    });

    it("returns null on non-checkpoint messages", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          messages: [{ message: b64({ hello: "world" }) }],
        }),
      });
      expect(await getLastCheckpointRoot({ fetchFn })).toBeNull();
    });
  });

  describe("publishCheckpoint", () => {
    it("is fail-open when HCS27_PUBLISHER_KEY is not configured", async () => {
      const cp = buildCheckpoint("agent-reviews", [{ a: 1 }]);
      const result = await publishCheckpoint(cp, { env: {} });
      expect(result.published).toBe(false);
      expect(result.reason).toContain("HCS27_PUBLISHER_KEY");
      expect(result.checkpoint).toBe(cp);
    });

    it("submits via the injected executor and returns the tx id", async () => {
      const cp = buildCheckpoint("agent-reviews", [{ a: 1 }]);
      const executeTx = vi.fn().mockResolvedValue("0.0.10857765@1234567890.123456789");
      const result = await publishCheckpoint(cp, {
        env: { HCS27_PUBLISHER_KEY: "dummy" },
        executeTx,
      });
      expect(result.published).toBe(true);
      expect(result.txId).toBe("0.0.10857765@1234567890.123456789");
      expect(executeTx).toHaveBeenCalledOnce();
    });

    it("is fail-open when submission throws", async () => {
      const cp = buildCheckpoint("agent-reviews", [{ a: 1 }]);
      const executeTx = vi.fn().mockRejectedValue(new Error("network down"));
      const result = await publishCheckpoint(cp, {
        env: { HCS27_PUBLISHER_KEY: "dummy" },
        executeTx,
      });
      expect(result.published).toBe(false);
      expect(result.reason).toContain("network down");
    });
  });

  describe("publishReviewCheckpoint", () => {
    it("chains prev from the last published checkpoint", async () => {
      const prev1 = buildCheckpoint(REVIEWS_LOG_ID, [{ a: 1 }]);
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [{ message: b64(prev1) }] }),
      });
      let submitted: unknown = null;
      const executeTx = vi.fn().mockImplementation(async (tx) => {
        // Capture the message from the tx for inspection
        submitted = tx;
        return "0.0.10857765@1.1";
      });
      const result = await publishReviewCheckpoint(
        REVIEWS_LOG_ID,
        [{ b: 2 }],
        { fetchFn, env: { HCS27_PUBLISHER_KEY: "dummy" }, executeTx },
      );
      expect(result.published).toBe(true);
      // The checkpoint built should have prev pointing at prev1's root
      expect(result.checkpoint!.metadata.prev?.rootHashB64u).toBe(
        prev1.metadata.root.rootHashB64u,
      );
      expect(result.checkpoint!.metadata.prev?.treeSize).toBe("1");
      void submitted;
    });

    it("uses null prev on first checkpoint", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [] }),
      });
      const executeTx = vi.fn().mockResolvedValue("0.0.10857765@1.1");
      const result = await publishReviewCheckpoint(
        REVIEWS_LOG_ID,
        [{ a: 1 }],
        { fetchFn, env: { HCS27_PUBLISHER_KEY: "dummy" }, executeTx },
      );
      expect(result.published).toBe(true);
      expect(result.checkpoint!.metadata.prev).toBeNull();
    });
  });

  describe("spec compliance", () => {
    it("uses the normative ans-checkpoint-v1 type", () => {
      const cp = buildCheckpoint(REVIEWS_LOG_ID, [{ a: 1 }]);
      expect(cp.metadata.type).toBe("ans-checkpoint-v1");
    });

    it("targets the live HCS-27 topic", () => {
      expect(VOICESCAPE_HCS27_TOPIC).toBe("0.0.10908357");
    });
  });
});
