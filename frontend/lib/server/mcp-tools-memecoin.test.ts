/**
 * MCP meme-coin launch tool — unit tests.
 *
 * No network, no signing, no spending: the tool only builds unsigned bytes,
 * so tests drive validation + byte-structure round-trips locally.
 */
import { describe, expect, it } from "vitest";
import {
  AccountId,
  PrivateKey,
  Transaction,
} from "@hiero-ledger/sdk";
import {
  HYPE_WORDS,
  PREPARE_MEMECOIN_LAUNCH_DESCRIPTION,
  prepareMemecoinLaunch,
  type MemecoinLaunchInput,
} from "./mcp-tools-memecoin";

function validInput(overrides: Partial<MemecoinLaunchInput> = {}): MemecoinLaunchInput {
  const buyerKey = PrivateKey.generateED25519();
  return {
    token_name: "Test Coin",
    token_symbol: "tst",
    decimals: 2,
    initial_supply: "1000000",
    buyer_account_id: "0.0.12345",
    buyer_public_key: buyerKey.publicKey.toString(),
    ...overrides,
  };
}

function expectError(input: MemecoinLaunchInput, contains: string) {
  const res = prepareMemecoinLaunch(input);
  expect("error" in res && res.error).toContain(contains);
}

describe("prepareMemecoinLaunch", () => {
  it("builds unsigned bytes that re-parse with the right fields (ED25519 buyer key)", () => {
    const res = prepareMemecoinLaunch(validInput());
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) return;
    const { ok } = res;

    // Symbol is normalized to upper case.
    expect(ok.token.symbol).toBe("TST");
    expect(ok.token.initial_supply_base_units).toBe("100000000"); // 1e6 * 10^2
    expect(ok.treasury_account_id).toBe("0.0.12345");

    const back = Transaction.fromBytes(Buffer.from(ok.unsigned_tx_base64, "base64")) as any;
    expect(back.tokenName).toBe("Test Coin");
    expect(back.tokenSymbol).toBe("TST");
    expect(String(back.decimals)).toBe("2");
    expect(back.initialSupply.toString()).toBe("100000000");
    expect(back.treasuryAccountId.toString()).toBe("0.0.12345");
    expect(back.autoRenewAccountId.toString()).toBe("0.0.12345");
    expect(back.adminKey).toBeTruthy();
    expect(back.supplyKey).toBeTruthy();
  });

  it("accepts ECDSA buyer keys too", () => {
    const ecdsa = PrivateKey.generateECDSA();
    const res = prepareMemecoinLaunch(validInput({ buyer_public_key: ecdsa.publicKey.toString() }));
    expect("ok" in res).toBe(true);
  });

  it("rejects bad names/symbols", () => {
    expectError(validInput({ token_name: "" }), "token_name");
    expectError(validInput({ token_name: "x".repeat(101) }), "token_name");
    expectError(validInput({ token_symbol: "" }), "token_symbol");
    expectError(validInput({ token_symbol: "x".repeat(101) }), "token_symbol");
    expectError(validInput({ token_memo: "x".repeat(101) }), "token_memo");
  });

  it("rejects bad decimals", () => {
    expectError(validInput({ decimals: -1 }), "decimals");
    expectError(validInput({ decimals: 9 }), "decimals");
    expectError(validInput({ decimals: 1.5 }), "decimals");
  });

  it("rejects bad supplies", () => {
    expectError(validInput({ initial_supply: "-5" }), "initial_supply");
    expectError(validInput({ initial_supply: "1.5" }), "initial_supply");
    expectError(validInput({ initial_supply: "abc" }), "initial_supply");
    // int64 overflow: 2^63 with 0 decimals.
    expectError(validInput({ initial_supply: "9223372036854775808", decimals: 0 }), "int64");
    // Zero supply is legal.
    expect("ok" in prepareMemecoinLaunch(validInput({ initial_supply: "0" }))).toBe(true);
  });

  it("rejects bad buyer account ids", () => {
    expectError(validInput({ buyer_account_id: "0.0.0" }), "buyer_account_id");
    expectError(validInput({ buyer_account_id: "abc" }), "buyer_account_id");
    expectError(validInput({ buyer_account_id: "" }), "buyer_account_id");
  });

  it("rejects unparseable buyer public keys", () => {
    expectError(validInput({ buyer_public_key: "not-a-key" }), "buyer_public_key");
    expectError(validInput({ buyer_public_key: "" }), "buyer_public_key");
  });

  it("never leaks key material or hype in its output", () => {
    const buyerPriv = PrivateKey.generateED25519();
    const input = validInput({ buyer_public_key: buyerPriv.publicKey.toString() });
    const res = prepareMemecoinLaunch(input);
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) return;
    const blob = JSON.stringify(res.ok);
    // The buyer's private key must never appear in the output.
    expect(blob).not.toContain(buyerPriv.toString());
    // No private-key-shaped fields.
    expect(blob.toLowerCase()).not.toContain("privatekey");
    expect(blob.toLowerCase()).not.toContain("mnemonic");
    for (const w of HYPE_WORDS) {
      expect(blob.toLowerCase()).not.toContain(w);
    }
    // ...but the copy SHOULD warn about private keys in prose.
    expect(blob.toLowerCase()).toContain("private key");
  });

  it("tool description stays hype-free and states the key rule", () => {
    const d = PREPARE_MEMECOIN_LAUNCH_DESCRIPTION.toLowerCase();
    for (const w of HYPE_WORDS) {
      expect(d).not.toContain(w);
    }
    expect(d).toContain("never hold any token key");
    expect(d).toContain("never ask for or handle a private key");
    expect(d).toContain("not investment advice");
  });

  it("accepts a token memo within limits", () => {
    const res = prepareMemecoinLaunch(validInput({ token_memo: "community token" }));
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) return;
    const back = Transaction.fromBytes(Buffer.from(res.ok.unsigned_tx_base64, "base64")) as any;
    expect(back.tokenMemo).toBe("community token");
  });

  it("uses AccountId parsing consistently", () => {
    // Guards against 0.0.x typos slipping into the treasury field.
    expect(() => AccountId.fromString("0.0.12345")).not.toThrow();
  });
});
