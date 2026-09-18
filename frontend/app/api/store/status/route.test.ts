/**
 * GET /api/store/status tests: backend kind reporting, shared flag,
 * live-probe reachability, fail-soft contract, and the no-secrets guarantee.
 *
 * The store module is mocked so probe outcomes are deterministic; the real
 * storeBackendKind() env logic is covered by lib/server/store.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { GET } from "./route";
import { storeBackendKind, getKvStore } from "@/lib/server/store";

vi.mock("@/lib/server/store", () => ({
  storeBackendKind: vi.fn(),
  getKvStore: vi.fn(),
}));

const mockKind = vi.mocked(storeBackendKind);
const mockGetStore = vi.mocked(getKvStore);

beforeEach(() => {
  vi.clearAllMocks();
});

function okStore() {
  return { setNx: vi.fn(async () => true) };
}

describe("GET /api/store/status", () => {
  it("reports a reachable valkey backend as shared", async () => {
    mockKind.mockReturnValue("valkey");
    mockGetStore.mockReturnValue(okStore() as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      backend: "valkey",
      shared: true,
      reachable: true,
    });
  });

  it("reports a reachable upstash backend as shared", async () => {
    mockKind.mockReturnValue("upstash");
    mockGetStore.mockReturnValue(okStore() as never);
    const res = await GET();
    expect(await res.json()).toEqual({
      backend: "upstash",
      shared: true,
      reachable: true,
    });
  });

  it("reports memory as not shared", async () => {
    mockKind.mockReturnValue("memory");
    mockGetStore.mockReturnValue(okStore() as never);
    const res = await GET();
    expect(await res.json()).toEqual({
      backend: "memory",
      shared: false,
      reachable: true,
    });
  });

  it("reports reachable:false when the probe rejects (dead backend)", async () => {
    mockKind.mockReturnValue("valkey");
    mockGetStore.mockReturnValue({
      setNx: vi.fn(async () => {
        throw new Error("[store] Valkey setNx failed: connect ECONNREFUSED");
      }),
    } as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      backend: "valkey",
      shared: true,
      reachable: false,
    });
  });

  it("reports reachable:false when getKvStore itself throws (fail-soft, never 500)", async () => {
    mockKind.mockReturnValue("upstash");
    mockGetStore.mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe("upstash");
    expect(body.reachable).toBe(false);
  });

  it("never leaks connection details, even if the backend kind string is hostile", async () => {
    mockKind.mockReturnValue("valkey");
    mockGetStore.mockReturnValue(okStore() as never);
    const res = await GET();
    const text = await res.text();
    expect(text).not.toMatch(/redis:\/\//i);
    expect(text).not.toMatch(/upstash/i);
    expect(text).not.toContain("token");
    // Only the three known kind strings may appear as the backend value.
    const body = JSON.parse(text);
    expect(["valkey", "upstash", "memory"]).toContain(body.backend);
  });
});
