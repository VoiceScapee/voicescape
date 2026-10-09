/**
 * Voicescape MCP HIP-904 airdrop tools — unit tests.
 *
 * Mirror-node reads are fully mocked (no network). The transaction is
 * never submitted — "signing" in tests uses a throwaway SDK key whose
 * signatures never leave the VM.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PrivateKey,
  TokenAirdropTransaction,
  Transaction,
} from "@hiero-ledger/sdk";
import {
  prepareAirdropTool,
  checkPendingAirdropsTool,
} from "./mcp-tools-airdrop";

const SENDER = "0.0.555001";
const TOKEN = "0.0.555002";
const R1 = "0.0.555101";
const R2 = "0.0.555102";

type Route = [RegExp, (url: string) => unknown];
function mockFetch(routes: Route[]): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const body = handler(url);
        return { ok: true, status: 200, json: async () => body } as any;
      }
    }
    return { ok: false, status: 404, json: async () => null } as any;
  }) as typeof fetch;
}

/** Mirror-node read fixtures: sender owns NFT serials 1..3 and 1_000_000 fungible units. */
function holderFetch() {
  return mockFetch([
    [/\/nfts\?/, () => ({ nfts: [{ serial_number: 1 }, { serial_number: 2 }, { serial_number: 3 }] })],
    [/\/tokens\?/, () => ({ tokens: [{ token_id: TOKEN, balance: "1000000" }] })],
  ]);
}

describe("prepareAirdropTool (NFT)", () => {
  it("builds unsigned TokenAirdrop bytes for NFT serials", async () => {
    const res = (await prepareAirdropTool(
      {
        sender_account_id: SENDER,
        token_id: TOKEN,
        recipients: [
          { account_id: R1, serial_numbers: [1, 2] },
          { account_id: R2, serial_numbers: [3] },
        ],
      },
      holderFetch(),
    )) as any;
    expect(res.error).toBeUndefined();
    expect(res.kind).toBe("nft");
    expect(res.sender_account_id).toBe(SENDER);

    const tx = Transaction.fromBytes(Buffer.from(res.unsigned_tx_base64, "base64"));
    expect(tx).toBeInstanceOf(TokenAirdropTransaction);
    expect(tx.isFrozen()).toBe(true);
    expect(tx.transactionId?.accountId?.toString()).toBe(SENDER);

    // Signable with a throwaway key — proves the bytes are a valid
    // frozen structure the sender's real key can sign.
    const signed = await tx.sign(PrivateKey.generateED25519());
    expect(signed.toBytes().length).toBeGreaterThan(0);

    expect(res.instructions).toMatch(/UNSIGNED/);
    expect(res.instructions).toMatch(/never signed it/);
    expect(res.instructions).toMatch(/PENDING airdrop/);
  });

  it("errors when the sender lacks a serial (mirror node)", async () => {
    const res = await prepareAirdropTool(
      {
        sender_account_id: SENDER,
        token_id: TOKEN,
        recipients: [{ account_id: R1, serial_numbers: [1, 99] }],
      },
      holderFetch(),
    );
    expect((res as any).error).toMatch(/does not own serial\(s\) 99/);
  });

  it("proceeds with a warning when the mirror node is unreachable (fail-open)", async () => {
    const res = (await prepareAirdropTool(
      {
        sender_account_id: SENDER,
        token_id: TOKEN,
        recipients: [{ account_id: R1, serial_numbers: [1] }],
      },
      mockFetch([]),
    )) as any;
    expect(res.error).toBeUndefined();
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.unsigned_tx_base64).toBeTruthy();
  });
});

describe("prepareAirdropTool (fungible)", () => {
  it("builds unsigned bytes with debit/credit for fungible amounts", async () => {
    const res = (await prepareAirdropTool(
      {
        sender_account_id: SENDER,
        token_id: TOKEN,
        recipients: [
          { account_id: R1, amount: "100" },
          { account_id: R2, amount: "250" },
        ],
      },
      holderFetch(),
    )) as any;
    expect(res.error).toBeUndefined();
    expect(res.kind).toBe("fungible");
    const tx = Transaction.fromBytes(Buffer.from(res.unsigned_tx_base64, "base64"));
    expect(tx).toBeInstanceOf(TokenAirdropTransaction);
    expect(tx.isFrozen()).toBe(true);
  });

  it("errors on insufficient balance (mirror node)", async () => {
    const res = await prepareAirdropTool(
      {
        sender_account_id: SENDER,
        token_id: TOKEN,
        recipients: [{ account_id: R1, amount: "99999999" }],
      },
      holderFetch(),
    );
    expect((res as any).error).toMatch(/holds 1000000.*needs 99999999/);
  });
});

describe("prepareAirdropTool (validation)", () => {
  it("rejects empty and oversized recipient lists", async () => {
    const empty = await prepareAirdropTool({ sender_account_id: SENDER, token_id: TOKEN, recipients: [] }, holderFetch());
    expect((empty as any).error).toMatch(/at least one recipient/);
    const many = Array.from({ length: 51 }, (_, i) => ({ account_id: `0.0.${900000 + i}`, amount: "1" }));
    const big = await prepareAirdropTool({ sender_account_id: SENDER, token_id: TOKEN, recipients: many }, holderFetch());
    expect((big as any).error).toMatch(/max 50/);
  });

  it("rejects mixed kinds and both/neither amount+serials", async () => {
    const mixed = await prepareAirdropTool(
      {
        sender_account_id: SENDER,
        token_id: TOKEN,
        recipients: [
          { account_id: R1, amount: "10" },
          { account_id: R2, serial_numbers: [1] },
        ],
      },
      holderFetch(),
    );
    expect((mixed as any).error).toMatch(/one airdrop call handles fungible OR nfts/);

    const neither = await prepareAirdropTool(
      { sender_account_id: SENDER, token_id: TOKEN, recipients: [{ account_id: R1 }] },
      holderFetch(),
    );
    expect((neither as any).error).toMatch(/amount \(fungible\) or serial_numbers \(nft\)/);
  });

  it("rejects malformed account and token ids", async () => {
    const badSender = await prepareAirdropTool(
      { sender_account_id: "bob", token_id: TOKEN, recipients: [{ account_id: R1, amount: "1" }] },
      holderFetch(),
    );
    expect((badSender as any).error).toMatch(/not a 0\.0\.x account/);
    const badToken = await prepareAirdropTool(
      { sender_account_id: SENDER, token_id: "nope", recipients: [{ account_id: R1, amount: "1" }] },
      holderFetch(),
    );
    expect((badToken as any).error).toMatch(/not a 0\.0\.x token/);
  });
});

describe("checkPendingAirdropsTool", () => {
  it("lists pending airdrops from the mirror node", async () => {
    const fetchFn = mockFetch([
      [
        /\/airdrops\/pending/,
        () => ({
          airdrops: [
            { token_id: TOKEN, serial_number: 7, amount: null, sender_id: SENDER, receiver_id: R1 },
            { token_id: "0.0.555003", serial_number: null, amount: 500, sender_id: SENDER, receiver_id: R1 },
          ],
        }),
      ],
    ]);
    const res = (await checkPendingAirdropsTool({ account_id: R1 }, fetchFn)) as any;
    expect(res.error).toBeUndefined();
    expect(res.pending).toHaveLength(2);
    expect(res.pending[0]).toMatchObject({ token_id: TOKEN, serial_number: 7, sender_id: SENDER });
    expect(res.pending[1]).toMatchObject({ token_id: "0.0.555003", amount: "500" });
  });

  it("returns an honest empty list when nothing is pending", async () => {
    const fetchFn = mockFetch([[/\/airdrops\/pending/, () => ({ airdrops: [] })]]);
    const res = (await checkPendingAirdropsTool({ account_id: R1 }, fetchFn)) as any;
    expect(res.pending).toEqual([]);
  });

  it("rejects malformed account ids and mirror failures", async () => {
    const bad = await checkPendingAirdropsTool({ account_id: "bob" }, mockFetch([]));
    expect((bad as any).error).toMatch(/not a 0\.0\.x account/);
    const down = await checkPendingAirdropsTool({ account_id: R1 }, mockFetch([]));
    expect((down as any).error).toMatch(/could not read pending airdrops/);
  });
});
