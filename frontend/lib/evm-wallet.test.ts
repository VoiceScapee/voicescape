/**
 * Tests for the EVM wallet write client.
 * The wallet provider is fully mocked — no real wallet, relay, or chain.
 */
import { Interface } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvmWalletError,
  buildBuyCalldata,
  buildTipCalldata,
  ensureHederaMainnet,
  getEvmProvider,
  requestEvmAccount,
  submitEvmTip,
  type Eip1193Provider,
} from "./evm-wallet";

const ALICE = "0x1111111111111111111111111111111111111111";
const TIPS = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";
const TX_HASH = "0x" + "ab".repeat(32);

interface MockBehavior {
  chainId?: string;
  switchError?: { code: number } | null;
  addError?: { code: number } | null;
}

class MockProvider implements Eip1193Provider {
  requests: { method: string; params?: unknown[] }[] = [];
  chainId: string;
  private switchError: { code: number } | null;
  private addError: { code: number } | null;

  constructor(behavior: MockBehavior = {}) {
    this.chainId = behavior.chainId ?? "0x127";
    this.switchError = behavior.switchError ?? null;
    this.addError = behavior.addError ?? null;
  }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    this.requests.push(args);
    switch (args.method) {
      case "eth_requestAccounts":
        return [ALICE];
      case "eth_chainId":
        return this.chainId;
      case "wallet_switchEthereumChain":
        if (this.switchError) throw this.switchError;
        this.chainId = "0x127";
        return null;
      case "wallet_addEthereumChain":
        if (this.addError) throw this.addError;
        this.chainId = "0x127";
        return null;
      case "eth_sendTransaction":
        return TX_HASH;
      default:
        throw new Error(`unexpected method ${args.method}`);
    }
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { ethereum?: unknown }).ethereum;
});

describe("requestEvmAccount", () => {
  it("returns the connected account lowercased", async () => {
    const provider = new MockProvider();
    await expect(requestEvmAccount(provider)).resolves.toBe(ALICE.toLowerCase());
  });

  it("throws when no account is available", async () => {
    const empty = new MockProvider();
    empty.request = async (args: { method: string }) =>
      args.method === "eth_requestAccounts" ? [] : null;
    await expect(requestEvmAccount(empty)).rejects.toBeInstanceOf(EvmWalletError);
  });
});

describe("ensureHederaMainnet", () => {
  it("does nothing when already on chain 295", async () => {
    const provider = new MockProvider({ chainId: "0x127" });
    await ensureHederaMainnet(provider);
    expect(provider.requests.map((r) => r.method)).toEqual(["eth_chainId"]);
  });

  it("switches chains when on another chain", async () => {
    const provider = new MockProvider({ chainId: "0x1" });
    await ensureHederaMainnet(provider);
    expect(provider.requests.map((r) => r.method)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
    ]);
    expect(provider.chainId).toBe("0x127");
  });

  it("adds the network with the relay RPC when the wallet reports it missing", async () => {
    const provider = new MockProvider({ chainId: "0x1", switchError: { code: 4902 } });
    await ensureHederaMainnet(provider, "https://relay.example.test/api");
    const add = provider.requests.find((r) => r.method === "wallet_addEthereumChain");
    expect(add).toBeDefined();
    const params = (add?.params as unknown[] | undefined)?.[0] as Record<string, unknown>;
    expect(params.chainId).toBe("0x127");
    expect(params.rpcUrls).toEqual(["https://relay.example.test/api"]);
    expect(params.nativeCurrency).toEqual({ name: "HBAR", symbol: "HBAR", decimals: 18 });
  });

  it("throws a clear error when the network is missing and no relay is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_HEDERA_RELAY_URL", "");
    const provider = new MockProvider({ chainId: "0x1", switchError: { code: 4902 } });
    await expect(ensureHederaMainnet(provider)).rejects.toThrow(/no relay URL/i);
  });

  it("lets a user rejection through unwrapped so the UI can tell declined from broken", async () => {
    const provider = new MockProvider({ chainId: "0x1", switchError: { code: 4001 } });
    const error = await ensureHederaMainnet(provider).catch((e: unknown) => e);
    expect((error as { code?: unknown }).code).toBe(4001);
    expect(error).not.toBeInstanceOf(EvmWalletError);
  });
});

describe("calldata builders", () => {
  const iface = new Interface([
    "function tipPage(string username) payable",
    "function buyListing(address seller, string listingRef) payable",
  ]);

  it("encodes tipPage and round-trips through decode", () => {
    const data = buildTipCalldata("alice");
    expect(data.startsWith("0x")).toBe(true);
    const decoded = iface.decodeFunctionData("tipPage", data);
    expect(decoded[0]).toBe("alice");
  });

  it("encodes buyListing and round-trips through decode", () => {
    const data = buildBuyCalldata(ALICE, "listing-1");
    const decoded = iface.decodeFunctionData("buyListing", data);
    expect(decoded[0].toLowerCase()).toBe(ALICE.toLowerCase());
    expect(decoded[1]).toBe("listing-1");
  });

  it("rejects invalid inputs", () => {
    expect(() => buildTipCalldata("  ")).toThrow(EvmWalletError);
    expect(() => buildBuyCalldata("not-an-address", "listing-1")).toThrow(EvmWalletError);
    expect(() => buildBuyCalldata(ALICE, "")).toThrow(EvmWalletError);
  });
});

describe("submitEvmTip", () => {
  it("connects, sends tipPage, and returns the hash plus sender (unconfirmed)", async () => {
    const provider = new MockProvider();
    const result = await submitEvmTip(provider, {
      tipsAddress: TIPS,
      username: "alice",
      valueWei: 1000000000000000000n,
    });
    expect(result).toEqual({ txHash: TX_HASH, from: ALICE.toLowerCase() });
    const send = provider.requests.find((r) => r.method === "eth_sendTransaction");
    expect(send).toBeDefined();
    const tx = (send?.params as unknown[] | undefined)?.[0] as Record<string, string>;
    expect(tx.to.toLowerCase()).toBe(TIPS.toLowerCase());
    expect(tx.value).toBe("0x" + (1000000000000000000n).toString(16));
    const iface = new Interface(["function tipPage(string username) payable"]);
    expect(iface.decodeFunctionData("tipPage", tx.data)[0]).toBe("alice");
  });
});

describe("getEvmProvider", () => {
  it("returns the injected provider and null when absent", () => {
    expect(getEvmProvider()).toBeNull();
    const mock = new MockProvider();
    (globalThis as { ethereum?: unknown }).ethereum = mock;
    expect(getEvmProvider()).toBe(mock);
  });
});

describe("tinybarToWei", () => {
  it("converts 1 HBAR of tinybar to 10^18 wei exactly", async () => {
    const { tinybarToWei } = await import("./evm-wallet");
    expect(tinybarToWei(100_000_000n)).toBe(1_000_000_000_000_000_000n);
    expect(tinybarToWei(0n)).toBe(0n);
    expect(() => tinybarToWei(-1n)).toThrow(EvmWalletError);
  });
});
