/**
 * Tests for Buddy's generate_page_image tool.
 *
 * The image service (fetch) and IPFS pinning (publishImageFile) are mocked;
 * the quota path uses the real in-memory fallback store (no Upstash env in
 * tests), with a unique IP per test so quota state never leaks between them.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TOOL_TYPE } from "@hashgraph/hedera-agent-kit";
import { GENERATE_IMAGE_TOOL, makeImageTool } from "./image-tool";

const pinImageFile = vi.fn();

vi.mock("@/lib/server/publish.js", () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  publishImageFile: (...args: unknown[]) => pinImageFile(...args),
}));

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function mockFetchImage(bytes: Uint8Array, contentType: string) {
  return vi.fn(async () => ({
    ok: true,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer.slice(0),
  }));
}

const params = (over: Record<string, unknown> = {}) => ({
  kind: "avatar",
  prompt: "a cozy neon-lit fox avatar, digital painting, purple and teal",
  ...over,
});

let ipSeq = 0;
const nextIp = () => `10.9.9.${++ipSeq}`;

describe("generate_page_image tool", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BUDDY_IMAGE_DAILY_QUOTA;
    pinImageFile.mockResolvedValue({ cid: "QmTestCid123", provider: "pinata" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is a read-only QUERY tool named generate_page_image", () => {
    const tool = makeImageTool("1.2.3.4");
    expect(GENERATE_IMAGE_TOOL).toBe("generate_page_image");
    expect(tool.method).toBe("generate_page_image");
    expect(tool.toolType).toBe(TOOL_TYPE.QUERY);
    expect(tool.description).toMatch(/wholesome/i);
  });

  it("generates, pins, and returns a permanent IPFS url", async () => {
    globalThis.fetch = mockFetchImage(PNG, "image/png") as any;
    const tool = makeImageTool(nextIp());
    const raw = await tool.execute(undefined as any, {} as any, params());
    const out = JSON.parse(raw as string);
    expect(out.kind).toBe("avatar");
    expect(out.cid).toBe("QmTestCid123");
    expect(out.url).toBe("https://ipfs.io/ipfs/QmTestCid123");
    expect(pinImageFile).toHaveBeenCalledTimes(1);
    const [bytes, filename, mime] = pinImageFile.mock.calls[0];
    expect(mime).toBe("image/png");
    expect(String(filename)).toMatch(/^buddy-avatar-.*\.png$/);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("falls back to ipfs.io when IPFS_GATEWAY is set but empty", async () => {
    process.env.IPFS_GATEWAY = "";
    globalThis.fetch = mockFetchImage(PNG, "image/png") as any;
    const tool = makeImageTool(nextIp());
    const raw = await tool.execute(undefined as any, {} as any, params());
    const out = JSON.parse(raw as string);
    expect(out.url).toBe("https://ipfs.io/ipfs/QmTestCid123");
    delete process.env.IPFS_GATEWAY;
  });

  it("enforces the per-IP daily quota and fails gracefully", async () => {
    process.env.BUDDY_IMAGE_DAILY_QUOTA = "1";
    globalThis.fetch = mockFetchImage(PNG, "image/png") as any;
    const ip = nextIp();
    const tool = makeImageTool(ip);
    const first = JSON.parse((await tool.execute(undefined as any, {} as any, params())) as string);
    expect(first.error).toBeUndefined();
    const second = JSON.parse((await tool.execute(undefined as any, {} as any, params())) as string);
    expect(second.error).toMatch(/daily image limit reached/);
    // The failed call consumed no generation.
    expect(pinImageFile).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-image response without pinning", async () => {
    globalThis.fetch = mockFetchImage(
      new Uint8Array([104, 105]),
      "text/html"
    ) as any;
    const tool = makeImageTool(nextIp());
    const out = JSON.parse((await tool.execute(undefined as any, {} as any, params())) as string);
    expect(out.error).toMatch(/did not return a valid image/);
    expect(pinImageFile).not.toHaveBeenCalled();
  });

  it("fails gracefully when the image service is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as any;
    const tool = makeImageTool(nextIp());
    const out = JSON.parse((await tool.execute(undefined as any, {} as any, params())) as string);
    expect(out.error).toMatch(/unreachable/);
    expect(pinImageFile).not.toHaveBeenCalled();
  });

  it("fails gracefully when pinning is unavailable", async () => {
    globalThis.fetch = mockFetchImage(PNG, "image/png") as any;
    pinImageFile.mockRejectedValue(new Error("PINATA_UNAVAILABLE"));
    const tool = makeImageTool(nextIp());
    const out = JSON.parse((await tool.execute(undefined as any, {} as any, params())) as string);
    expect(out.error).toMatch(/pinning temporarily unavailable/);
  });

  it("validates params (bad kind rejected)", async () => {
    const tool = makeImageTool(nextIp());
    await expect(
      tool.execute(undefined as any, {} as any, params({ kind: "video" }))
    ).rejects.toThrow();
  });
});
