/**
 * Tests for the Hedera JSON-RPC relay read client.
 * All network access is mocked; no live relay is called.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayRpcError,
  RelayUnreachable,
  getRelayUrl,
  relayEthCall,
  relayGetLogs,
  relayGetTransactionReceipt,
} from "./evm-relay";

const RELAY_URL = "https://relay.example.test/api";

function rpcResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRelayUrl", () => {
  it("returns null when no relay is configured (no silent public default)", () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", "");
    vi.stubEnv("NEXT_PUBLIC_HEDERA_MAINNET_RPC", "");
    expect(getRelayUrl()).toBeNull();
  });

  it("returns the configured URL trimmed", () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", `  ${RELAY_URL}  `);
    expect(getRelayUrl()).toBe(RELAY_URL);
  });

  it("falls back to the chain-config RPC var when the relay var is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", "");
    vi.stubEnv("NEXT_PUBLIC_HEDERA_MAINNET_RPC", "https://chain-rpc.example.test/api");
    expect(getRelayUrl()).toBe("https://chain-rpc.example.test/api");
  });

  it("prefers the relay var over the chain-config var", () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", RELAY_URL);
    vi.stubEnv("NEXT_PUBLIC_HEDERA_MAINNET_RPC", "https://chain-rpc.example.test/api");
    expect(getRelayUrl()).toBe(RELAY_URL);
  });
});

describe("relayEthCall", () => {
  it("posts eth_call and returns the raw hex result", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", RELAY_URL);
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) =>
      rpcResponse({ jsonrpc: "2.0", id: 1, result: "0x0000000000000000000000000000000000000000000000000000000000000001" }),
    );
    const result = await relayEthCall({
      to: "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0",
      data: "0x12345678",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBe("0x0000000000000000000000000000000000000000000000000000000000000001");
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    const url = firstCall?.[0];
    const init = firstCall?.[1] as RequestInit | undefined;
    expect(url).toBe(RELAY_URL);
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe("0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0");
    expect(body.params[1]).toBe("latest");
  });

  it("throws RelayUnreachable when no relay is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", "");
    await expect(
      relayEthCall({ to: "0x0000000000000000000000000000000000000000", data: "0x", fetchImpl: (async () => rpcResponse({})) as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(RelayUnreachable);
  });

  it("surfaces relay error payloads as RelayRpcError", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", RELAY_URL);
    const fetchImpl = vi.fn(async () =>
      rpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }),
    );
    await expect(
      relayEthCall({ to: "0x0000000000000000000000000000000000000000", data: "0x", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "RelayRpcError", code: -32000 });
    expect.assertions(1);
  });

  it("throws RelayUnreachable on transport failure", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", RELAY_URL);
    const fetchImpl = vi.fn(async () => { throw new Error("down"); });
    await expect(
      relayEthCall({ to: "0x0000000000000000000000000000000000000000", data: "0x", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(RelayUnreachable);
  });
});

describe("relayGetTransactionReceipt", () => {
  it("returns null for a pending transaction and the receipt object otherwise", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", RELAY_URL);
    const pending = vi.fn(async () => rpcResponse({ jsonrpc: "2.0", id: 1, result: null }));
    expect(
      await relayGetTransactionReceipt("0xabc", pending as unknown as typeof fetch),
    ).toBeNull();
    const found = vi.fn(async () =>
      rpcResponse({ jsonrpc: "2.0", id: 1, result: { transactionHash: "0xabc", status: "0x1" } }),
    );
    const receipt = await relayGetTransactionReceipt("0xabc", found as unknown as typeof fetch);
    expect(receipt?.status).toBe("0x1");
  });
});

describe("relayGetLogs", () => {
  it("returns the array and rejects a non-array result", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", RELAY_URL);
    const okFetch = vi.fn(async () => rpcResponse({ jsonrpc: "2.0", id: 1, result: [{ topics: [] }] }));
    expect(await relayGetLogs({ fetchImpl: okFetch as unknown as typeof fetch })).toHaveLength(1);
    const badFetch = vi.fn(async () => rpcResponse({ jsonrpc: "2.0", id: 1, result: "nope" }));
    await expect(relayGetLogs({ fetchImpl: badFetch as unknown as typeof fetch })).rejects.toBeInstanceOf(
      RelayUnreachable,
    );
  });
});

describe("RelayRpcError", () => {
  it("carries the relay error code", () => {
    const error = new RelayRpcError("boom", -32000);
    expect(error.code).toBe(-32000);
    expect(error.name).toBe("RelayRpcError");
  });
});
