/**
 * Tests for the MetaMask migration (2026-09-13): the injected-EVM sender
 * talks to the chain ONLY through the wallet's EIP-1193 provider
 * (eth_call / eth_sendTransaction / eth_getTransactionReceipt). ethers is
 * used purely to encode/decode calldata — no BrowserProvider, Signer,
 * Contract, or JsonRpcProvider. The read-only sender reads through the
 * official Hedera mirror node instead of a JSON-RPC provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  createInjectedEvmTxSender,
  createReadOnlySender,
  mirrorContractCall,
  REGISTRY_ABI,
  TIPS_ABI,
  WalletTimeoutError,
  type Eip1193Provider,
} from "./tx";
import { CHAINS } from "./chains";

const ACCOUNT = "0x30C63DC43608B6764A6b8b53960553AEbF306817";
const REGISTRY = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const TIPS = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";
const TX_HASH = "0x" + "ab".repeat(32);

const registryIface = new ethers.Interface(REGISTRY_ABI);
const tipsIface = new ethers.Interface(TIPS_ABI);

/** Mock EIP-1193 provider: map method -> handler. Records every call. */
function mockEth(handlers: Record<string, (params?: unknown) => unknown>) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const eth: Eip1193Provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(params) as unknown;
    },
  };
  return { eth, calls };
}

describe("createInjectedEvmTxSender", () => {
  it("rejects a malformed account address", () => {
    const { eth } = mockEth({});
    expect(() => createInjectedEvmTxSender(eth, "not-an-address")).toThrow(/invalid account/i);
  });

  it("viewResolve decodes resolvePage via eth_call", async () => {
    const expected = {
      owner: ACCOUNT,
      ipfsHash: "QmTest",
      ownerType: 1 as const,
      operator: "0x1111111111111111111111111111111111111111",
      purpose: "test agent",
    };
    const encoded = registryIface.encodeFunctionResult("resolvePage", [
      expected.owner,
      expected.ipfsHash,
      1,
      expected.operator,
      expected.purpose,
    ]);
    const { eth, calls } = mockEth({
      eth_call: () => encoded,
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    const result = await sender.viewResolve(REGISTRY, "some-name");
    expect(result).toEqual(expected);
    // The call went to the registry with ABI-encoded calldata…
    const call = calls.find((c) => c.method === "eth_call");
    expect(call).toBeDefined();
    const [txParams] = call!.params as Array<{ to: string; data: string }>;
    expect(txParams.to).toBe(REGISTRY);
    // …and the calldata round-trips as a resolvePage call.
    const parsed = registryIface.parseTransaction({ data: txParams.data });
    expect(parsed?.name).toBe("resolvePage");
    expect(parsed?.args[0]).toBe("some-name");
  });

  it("viewResolve returns null when the call reverts (unknown name)", async () => {
    const { eth } = mockEth({
      eth_call: () => {
        throw new Error("execution reverted: UsernameInvalid");
      },
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    expect(await sender.viewResolve(REGISTRY, "no-such-name")).toBeNull();
  });

  it("sendTip sends value + encoded tipPage calldata and waits for the receipt", async () => {
    const { eth, calls } = mockEth({
      eth_sendTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => ({ status: "0x1", transactionHash: TX_HASH }),
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    const hash = await sender.sendTip(TIPS, "some-name", 1_000_000_000_000_000_000n);
    expect(hash).toBe(TX_HASH);

    const send = calls.find((c) => c.method === "eth_sendTransaction");
    expect(send).toBeDefined();
    const [txParams] = send!.params as Array<{
      from: string;
      to: string;
      data: string;
      value: string;
    }>;
    expect(txParams.from).toBe(ACCOUNT);
    expect(txParams.to).toBe(TIPS);
    expect(txParams.value).toBe("0xde0b6b3a7640000"); // 1 HBAR in wei
    const parsed = tipsIface.parseTransaction({ data: txParams.data });
    expect(parsed?.name).toBe("tipPage");
    expect(parsed?.args[0]).toBe("some-name");

    expect(calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(true);
  });

  it("sendTip rejects a zero value before touching the wallet", async () => {
    const { eth, calls } = mockEth({ eth_sendTransaction: () => TX_HASH });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    await expect(sender.sendTip(TIPS, "some-name", 0n)).rejects.toThrow(/greater than zero/i);
    expect(calls).toHaveLength(0);
  });

  it("sendBuy rejects an invalid seller address before touching the wallet", async () => {
    const { eth, calls } = mockEth({ eth_sendTransaction: () => TX_HASH });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    await expect(sender.sendBuy(TIPS, "0x1234", "ref", 100n)).rejects.toThrow(/seller address is invalid/i);
    expect(calls).toHaveLength(0);
  });

  it("sendRegister encodes registerPage with ownerType/operator/purpose", async () => {
    const { eth, calls } = mockEth({
      eth_sendTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => ({ status: "0x1", transactionHash: TX_HASH }),
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    const operator = "0x2222222222222222222222222222222222222222";
    await sender.sendRegister(REGISTRY, "agent-page", "QmHash", 1, operator, "does things");
    const send = calls.find((c) => c.method === "eth_sendTransaction");
    const [txParams] = send!.params as Array<{ data: string; value?: string }>;
    // No value field on a non-payable registration.
    expect(txParams.value).toBeUndefined();
    const parsed = registryIface.parseTransaction({ data: txParams.data });
    expect(parsed?.name).toBe("registerPage");
    expect(parsed?.args[0]).toBe("agent-page");
    expect(parsed?.args[2]).toBe(1n);
    expect(parsed?.args[3].toLowerCase()).toBe(operator.toLowerCase());
  });

  it("sendUpdate encodes updatePage", async () => {
    const { eth, calls } = mockEth({
      eth_sendTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => ({ status: "0x1", transactionHash: TX_HASH }),
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    await sender.sendUpdate(REGISTRY, "my-page", "QmNew");
    const send = calls.find((c) => c.method === "eth_sendTransaction");
    const [txParams] = send!.params as Array<{ data: string }>;
    const parsed = registryIface.parseTransaction({ data: txParams.data });
    expect(parsed?.name).toBe("updatePage");
    expect(parsed?.args[1]).toBe("QmNew");
  });

  it("throws when the receipt reports a revert", async () => {
    const { eth } = mockEth({
      eth_sendTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => ({ status: "0x0", transactionHash: TX_HASH }),
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT);
    await expect(sender.sendTip(TIPS, "some-name", 100n)).rejects.toThrow(/reverted/i);
  });

  it("throws WalletTimeoutError carrying the hash when no receipt appears", async () => {
    const { eth } = mockEth({
      eth_sendTransaction: () => TX_HASH,
      eth_getTransactionReceipt: () => null, // never mines
    });
    const sender = createInjectedEvmTxSender(eth, ACCOUNT, { receiptTimeoutMs: 50 });
    const err = await sender.sendTip(TIPS, "some-name", 100n).catch((e) => e);
    expect(err).toBeInstanceOf(WalletTimeoutError);
    expect((err as WalletTimeoutError).txId).toBe(TX_HASH);
  }, 10000);
});

describe("mirrorContractCall", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: "0x1234" }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("POSTs to the official mirror node contracts/call endpoint", async () => {
    const result = await mirrorContractCall(CHAINS["hedera-mainnet"], REGISTRY, "0xabcdef");
    expect(result).toBe("0x1234");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mainnet.mirrornode.hedera.com/api/v1/contracts/call");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe(REGISTRY);
    expect(body.data).toBe("0xabcdef");
  });

  it("uses the testnet mirror node for the testnet chain", async () => {
    await mirrorContractCall(CHAINS["hedera-testnet"], REGISTRY, "0xabcdef");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://testnet.mirrornode.hedera.com/api/v1/contracts/call");
  });

  it("throws on a mirror-node _status error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          _status: { messages: [{ message: "Bad Request", detail: "to field invalid" }] },
        }),
      })),
    );
    await expect(mirrorContractCall(CHAINS["hedera-mainnet"], "bad", "0x")).rejects.toThrow(
      /mirror-node contract call failed/i,
    );
  });
});

describe("createReadOnlySender", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    const encoded = registryIface.encodeFunctionResult("resolvePage", [
      ACCOUNT,
      "QmReadOnly",
      0,
      "0x0000000000000000000000000000000000000000",
      "",
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: encoded }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("resolves a username through the mirror node (no wallet, no JSON-RPC)", async () => {
    const sender = createReadOnlySender(CHAINS["hedera-mainnet"]);
    const result = await sender.viewResolve(REGISTRY, "user-10424063");
    expect(result?.owner).toBe(ACCOUNT);
    expect(result?.ipfsHash).toBe("QmReadOnly");
    expect(result?.ownerType).toBe(0);
  });

  it("returns null when the mirror node reports unknown name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ _status: { messages: [{ message: "contract revert" }] } }),
      })),
    );
    const sender = createReadOnlySender(CHAINS["hedera-mainnet"]);
    expect(await sender.viewResolve(REGISTRY, "nope")).toBeNull();
  });

  it("write methods throw a connect-a-wallet error", async () => {
    const sender = createReadOnlySender(CHAINS["hedera-mainnet"]);
    await expect(sender.sendTip(TIPS, "x", 1n)).rejects.toThrow(/connect a wallet/i);
  });
});
