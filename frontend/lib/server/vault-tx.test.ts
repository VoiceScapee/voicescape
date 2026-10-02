/**
 * Tests for vault-tx: unsigned vault builders return frozen, signable
 * bytes — never signed, never touching private keys. Pure SDK, no network.
 */
import { describe, it, expect } from "vitest";
import {
  PrivateKey,
  PublicKey,
  Transaction,
  AccountCreateTransaction,
  AccountUpdateTransaction,
  TransferTransaction,
  ContractExecuteTransaction,
  ContractId,
  KeyList,
} from "@hiero-ledger/sdk";
import {
  buildVaultCreateTx,
  buildVaultRevokeTx,
  buildVaultSweepTx,
  buildVaultRegisterPageTx,
  buildVaultUpdatePageTx,
  SWEEP_FEE_CUSHION_TINYBAR,
} from "./vault-tx";

const human = PrivateKey.generateED25519();
const agent = PrivateKey.generateED25519();
const humanHex = human.publicKey.toStringRaw().toLowerCase();
const agentHex = agent.publicKey.toStringRaw().toLowerCase();
const OPERATOR = "0.0.1234";

function decode(b64: string): Transaction {
  return Transaction.fromBytes(Buffer.from(b64, "base64"));
}

/**
 * Real signature count. The SDK's getSignatures() returns a SignatureMap
 * shim (per-node entries exist even when empty), so Object.keys is
 * meaningless — walk the flat (node, tx) pair maps and count non-empty
 * signature byte arrays instead.
 */
function sigCount(tx: Transaction): number {
  const flat = tx.getSignatures().getFlatSignatureList() as Array<{
    values(): Iterable<Uint8Array>;
  }>;
  let total = 0;
  for (const pairMap of flat) {
    for (const sig of pairMap.values()) {
      if (sig && sig.length > 0) total++;
    }
  }
  return total;
}

describe("buildVaultCreateTx", () => {
  it("builds frozen unsigned bytes: 1-of-2 human+agent key, budget as initial balance", () => {
    const built = buildVaultCreateTx({
      humanKey: human.publicKey,
      agentKey: agent.publicKey,
      budgetHbar: 5,
      agentUsername: "thechomps",
      payerAccountId: OPERATOR,
    });
    expect(built.txType).toBe("AccountCreateTransaction");
    expect(built.transactionId.startsWith(`${OPERATOR}@`)).toBe(true);
    expect(typeof built.unsignedTxBytes).toBe("string");

    const tx = decode(built.unsignedTxBytes);
    expect(tx).toBeInstanceOf(AccountCreateTransaction);
    const create = tx as AccountCreateTransaction;

    // Initial balance = 5 HBAR exactly.
    expect(create.initialBalance?.toTinybars().toNumber()).toBe(500_000_000);

    // Key is KeyList threshold 1 with BOTH keys.
    const key = create.key as KeyList;
    expect(key).toBeInstanceOf(KeyList);
    expect(key.threshold).toBe(1);
    const subs = key.toArray();
    expect(subs).toHaveLength(2);
    expect(
      subs.map((k) => (k as PublicKey).toStringRaw().toLowerCase()).sort(),
    ).toEqual([agentHex, humanHex].sort());

    // Memo names the agent (identity binding, on-chain).
    expect(create.accountMemo).toContain("thechomps");

    // Frozen and NOT signed by anyone — the wallet signs next.
    expect(create.isFrozen()).toBe(true);
    expect(sigCount(create)).toBe(0);
  });

  it("sets no EVM alias (the key will rotate — revocation, agent rotation)", () => {
    const built = buildVaultCreateTx({
      humanKey: human.publicKey,
      agentKey: agent.publicKey,
      budgetHbar: 5,
      agentUsername: "thechomps",
      payerAccountId: OPERATOR,
    });
    const create = decode(built.unsignedTxBytes) as AccountCreateTransaction;
    expect(create.alias).toBeNull();
  });

  it("rejects bad payer ids and out-of-range budgets", () => {
    const base = {
      humanKey: human.publicKey,
      agentKey: agent.publicKey,
      budgetHbar: 5,
      agentUsername: "thechomps",
      payerAccountId: OPERATOR,
    };
    expect(() => buildVaultCreateTx({ ...base, payerAccountId: "nope" })).toThrow(
      /payer account id/,
    );
    expect(() => buildVaultCreateTx({ ...base, budgetHbar: 99 })).toThrow(/out of range/);
    expect(() => buildVaultCreateTx({ ...base, budgetHbar: 0.05 })).toThrow(/out of range/);
  });
});

describe("buildVaultRevokeTx", () => {
  it("builds an unsigned update restoring the human-only key", () => {
    const built = buildVaultRevokeTx({
      vaultAccountId: "0.0.5555",
      humanKey: human.publicKey,
      payerAccountId: OPERATOR,
    });
    expect(built.txType).toBe("AccountUpdateTransaction");

    const tx = decode(built.unsignedTxBytes);
    expect(tx).toBeInstanceOf(AccountUpdateTransaction);
    const update = tx as AccountUpdateTransaction;
    expect(update.accountId?.toString()).toBe("0.0.5555");
    // New key = the human's key alone — the agent is gone after this lands.
    expect((update.key as PublicKey | null)?.toStringRaw().toLowerCase()).toBe(humanHex);
    expect(update.isFrozen()).toBe(true);
    expect(sigCount(update)).toBe(0);
  });

  it("works with an ECDSA human key", () => {
    const ecdsa = PrivateKey.generateECDSA();
    const built = buildVaultRevokeTx({
      vaultAccountId: "0.0.5555",
      humanKey: ecdsa.publicKey,
      payerAccountId: OPERATOR,
    });
    const update = decode(built.unsignedTxBytes) as AccountUpdateTransaction;
    expect((update.key as PublicKey | null)?.toStringRaw().toLowerCase()).toBe(
      ecdsa.publicKey.toStringRaw().toLowerCase(),
    );
  });

  it("rejects bad ids", () => {
    expect(() =>
      buildVaultRevokeTx({ vaultAccountId: "x", humanKey: human.publicKey, payerAccountId: OPERATOR }),
    ).toThrow(/vault account id/);
  });
});

describe("buildVaultSweepTx", () => {
  it("sweeps vault→human minus the fee cushion, vault pays its own fee", () => {
    expect(SWEEP_FEE_CUSHION_TINYBAR).toBe(60_000_000n);
    const built = buildVaultSweepTx({
      vaultAccountId: "0.0.5555",
      humanAccountId: "0.0.7777",
      vaultBalanceTinybar: 500_000_000n, // 5 HBAR
      payerAccountId: "0.0.5555",
    });
    expect(built.txType).toBe("TransferTransaction");

    const tx = decode(built.unsignedTxBytes);
    expect(tx).toBeInstanceOf(TransferTransaction);
    const xfer = tx as TransferTransaction;
    // 5.0 − 0.6 cushion = 4.4 HBAR moves.
    expect(xfer.hbarTransfers.get("0.0.5555")?.toTinybars().toNumber()).toBe(-440_000_000);
    expect(xfer.hbarTransfers.get("0.0.7777")?.toTinybars().toNumber()).toBe(440_000_000);
    expect(xfer.isFrozen()).toBe(true);
    expect(sigCount(xfer)).toBe(0);
  });

  it("refuses when the balance can't cover the fee cushion", () => {
    expect(() =>
      buildVaultSweepTx({
        vaultAccountId: "0.0.5555",
        humanAccountId: "0.0.7777",
        vaultBalanceTinybar: 50_000_000n,
        payerAccountId: "0.0.5555",
      }),
    ).toThrow(/balance too low/);
  });

  it("refuses a payer that isn't the vault", () => {
    expect(() =>
      buildVaultSweepTx({
        vaultAccountId: "0.0.5555",
        humanAccountId: "0.0.7777",
        vaultBalanceTinybar: 500_000_000n,
        payerAccountId: "0.0.7777",
      }),
    ).toThrow(/vault must pay/);
  });
});

describe("buildVaultRegisterPageTx", () => {
  const CID = "Qm" + "a".repeat(44);
  it("builds an unsigned registerPage call with the vault as payer and owner", () => {
    const built = buildVaultRegisterPageTx({
      vaultAccountId: "0.0.5555",
      username: "myagentpage",
      ipfsCid: CID,
      purpose: "My agent storefront",
    });
    expect(built.txType).toBe("ContractExecuteTransaction");
    // The vault is the payer — it signs for itself.
    expect(built.transactionId.startsWith("0.0.5555@")).toBe(true);

    const tx = decode(built.unsignedTxBytes);
    expect(tx).toBeInstanceOf(ContractExecuteTransaction);
    const call = tx as ContractExecuteTransaction;
    expect(call.contractId?.toString()).toBe("0.0.10854058");
    expect(call.gas?.toNumber()).toBe(600_000);
    expect(call.isFrozen()).toBe(true);
    expect(sigCount(call)).toBe(0);
  });

  it("rejects bad usernames, CIDs, missing purpose, and bad vault ids", () => {
    const base = {
      vaultAccountId: "0.0.5555",
      username: "myagentpage",
      ipfsCid: "Qm" + "a".repeat(44),
      purpose: "My agent storefront",
    };
    expect(() => buildVaultRegisterPageTx({ ...base, username: "AB" })).toThrow(/username/);
    expect(() => buildVaultRegisterPageTx({ ...base, ipfsCid: "not-a-cid" })).toThrow(/CID/);
    expect(() => buildVaultRegisterPageTx({ ...base, purpose: "  " })).toThrow(/purpose/);
    expect(() => buildVaultRegisterPageTx({ ...base, vaultAccountId: "x" })).toThrow(/vault account id/);
  });
});

describe("buildVaultUpdatePageTx", () => {
  const CID = "Qm" + "b".repeat(44);
  it("builds an unsigned updatePage call with the vault as payer", () => {
    const built = buildVaultUpdatePageTx({
      vaultAccountId: "0.0.5555",
      username: "myagentpage",
      ipfsCid: CID,
    });
    expect(built.txType).toBe("ContractExecuteTransaction");
    expect(built.transactionId.startsWith("0.0.5555@")).toBe(true);

    const tx = decode(built.unsignedTxBytes);
    expect(tx).toBeInstanceOf(ContractExecuteTransaction);
    const call = tx as ContractExecuteTransaction;
    expect(call.contractId?.toString()).toBe(ContractId.fromString("0.0.10854058").toString());
    expect(call.isFrozen()).toBe(true);
    expect(sigCount(call)).toBe(0);
  });

  it("rejects bad usernames, CIDs, and bad vault ids", () => {
    const base = { vaultAccountId: "0.0.5555", username: "myagentpage", ipfsCid: "Qm" + "b".repeat(44) };
    expect(() => buildVaultUpdatePageTx({ ...base, username: "!!" })).toThrow(/username/);
    expect(() => buildVaultUpdatePageTx({ ...base, ipfsCid: "bafy" })).toThrow(/CID/);
    expect(() => buildVaultUpdatePageTx({ ...base, vaultAccountId: "nope" })).toThrow(/vault account id/);
  });
});

describe("unsigned-ness (positive control)", () => {
  it("the counter sees real SDK signatures, so 0 on our builders is meaningful", async () => {
    const built = buildVaultCreateTx({
      humanKey: human.publicKey,
      agentKey: agent.publicKey,
      budgetHbar: 5,
      agentUsername: "thechomps",
      payerAccountId: OPERATOR,
    });
    const tx = decode(built.unsignedTxBytes);
    expect(sigCount(tx)).toBe(0);
    await tx.sign(human);
    expect(sigCount(tx)).toBeGreaterThan(0);
  });
});

describe("privacy", () => {
  it("unsigned bytes carry public keys only — no private material anywhere", () => {
    const privHex = agent.toStringRaw().toLowerCase();
    const built = buildVaultCreateTx({
      humanKey: human.publicKey,
      agentKey: agent.publicKey,
      budgetHbar: 5,
      agentUsername: "thechomps",
      payerAccountId: OPERATOR,
    });
    const asHex = Buffer.from(built.unsignedTxBytes, "base64").toString("hex");
    expect(asHex).not.toContain(privHex);
    // Public keys ARE expected in there (that's what the wallet signs over).
    expect(asHex).toContain(agentHex);
  });
});
