/**
 * Tests for prepareVaultPage (vault-mcp): identity binding + the
 * revoked-vault refusal, with stubbed intro/KV deps and a stubbed fetch.
 * No network, no real KV.
 */
import { describe, it, expect } from "vitest";
import { PrivateKey, AccountId } from "@hiero-ledger/sdk";
import { Interface } from "ethers";
import { prepareVaultPage } from "./vault-mcp";
import { getIntroByClaimCode } from "./agent-intros";
import { getVaultWatch } from "./vault-monitor";

const agent = PrivateKey.generateED25519();
const AGENT_HEX = agent.publicKey.toStringRaw().toLowerCase();
const OTHER_HEX = PrivateKey.generateED25519().publicKey.toStringRaw().toLowerCase();
const VAULT = "0.0.5555";
const HUMAN = "0.0.7777";
const CID = "Qm" + "c".repeat(44);
const RESOLVE_IFACE = new Interface([
  "function resolvePage(string) view returns (address, string, uint8, address, string)",
]);

const watch = {
  vaultId: VAULT,
  humanAccountId: HUMAN,
  humanKeyHex: "aa".repeat(32),
  humanKeyType: "ED25519",
  agentKeyHex: AGENT_HEX,
  agentUsername: "theagent",
  registeredAt: Date.now(),
  cursor: "0.000000000",
  lastScanAt: null,
  lastStatus: null,
};

const deps = {
  getIntroByClaimCode: (async (code: string) =>
    code === "GOOD" ? { handle: "theagent" } : null) as unknown as typeof getIntroByClaimCode,
  getVaultWatch: (async () => ({ ...watch })) as unknown as typeof getVaultWatch,
};

/** Stub fetch: mirror account key set + contract call (revert vs taken). */
function stubFetch(opts: { agentKeyOnChain: string; takenByVault: boolean }) {
  const vaultEvm = `0x${AccountId.fromString(VAULT).toEvmAddress()}`;
  const fn = async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes("/contracts/call")) {
      if (!opts.takenByVault) {
        return { ok: false, status: 400, json: async () => null } as Response;
      }
      const result = RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
        vaultEvm,
        CID,
        1n,
        vaultEvm,
        "purpose",
      ]);
      return { ok: true, status: 200, json: async () => ({ result }) } as Response;
    }
    if (url.includes(`/accounts/${VAULT}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          key: {
            _type: "KeyList",
            keys: [{ _type: "ED25519", key: opts.agentKeyOnChain }],
          },
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  return fn as unknown as typeof fetch;
}

const base = {
  agent_username: "theagent",
  intro_claim_code: "GOOD",
  vault_account_id: VAULT,
  username: "myagentpage",
  ipfs_cid: CID,
};

describe("prepareVaultPage validation", () => {
  it("rejects bad agent usernames, vault ids, missing claim codes, bad actions", async () => {
    const r1 = await prepareVaultPage({ ...base, action: "register", agent_username: "AB" }, fetch, deps);
    expect("error" in r1 && r1.error).toMatch(/invalid agent_username/);

    const r2 = await prepareVaultPage({ ...base, action: "register", vault_account_id: "x" }, fetch, deps);
    expect("error" in r2 && r2.error).toMatch(/0\.0\.x/);

    const r3 = await prepareVaultPage({ ...base, action: "register", intro_claim_code: "  " }, fetch, deps);
    expect("error" in r3 && r3.error).toMatch(/intro_claim_code is required/);

    const r4 = await prepareVaultPage({ ...base, action: "bogus" as never }, fetch, deps);
    expect("error" in r4 && r4.error).toMatch(/register.*update/);
  });

  it("rejects a claim code that doesn't match the agent", async () => {
    const r = await prepareVaultPage({ ...base, action: "register", intro_claim_code: "BAD" }, fetch, deps);
    expect("error" in r && r.error).toMatch(/doesn't match your agent username/);
  });

  it("refuses when no watch names this agent", async () => {
    const noWatch = {
      ...deps,
      getVaultWatch: (async () => null) as unknown as typeof getVaultWatch,
    };
    const r = await prepareVaultPage({ ...base, action: "register" }, fetch, noWatch);
    expect("error" in r && r.error).toMatch(/isn't set up for @theagent/);
  });

  it("requires purpose for register", async () => {
    const r = await prepareVaultPage(
      { ...base, action: "register" },
      stubFetch({ agentKeyOnChain: AGENT_HEX, takenByVault: false }),
      deps,
    );
    expect("error" in r && r.error).toMatch(/purpose is required/);
  });
});

describe("prepareVaultPage revoked-vault refusal", () => {
  it("returns a clear REVOKED answer — never a cryptic error — when the agent's key is gone from the vault", async () => {
    const r = await prepareVaultPage(
      { ...base, action: "register", purpose: "storefront" },
      stubFetch({ agentKeyOnChain: OTHER_HEX, takenByVault: false }),
      deps,
    );
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("REVOKED");
      expect(r.error).toMatch(/removed your key/i);
      // No dev jargon in the refusal.
      expect(r.error).not.toMatch(/INVALID_SIGNATURE|precheck|KeyList|threshold/i);
    }
  });
});

describe("prepareVaultPage register/update", () => {
  it("returns unsigned bytes for a free username, with signing instructions", async () => {
    const r = await prepareVaultPage(
      { ...base, action: "register", purpose: "my storefront" },
      stubFetch({ agentKeyOnChain: AGENT_HEX, takenByVault: false }),
      deps,
    );
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.action).toBe("register");
      expect(r.vault_account_id).toBe(VAULT);
      expect(r.username).toBe("myagentpage");
      expect(typeof r.unsigned_tx_bytes).toBe("string");
      expect(r.transaction_id.startsWith(`${VAULT}@`)).toBe(true);
      // The instructions name where the signing happens — the server never sees the key.
      expect(r.how_to_sign).toMatch(/your own environment/i);
      expect(r.how_to_sign).toMatch(/never.*sees your private key/i);
    }
  });

  it("refuses to register a taken username", async () => {
    const r = await prepareVaultPage(
      { ...base, action: "register", purpose: "storefront" },
      stubFetch({ agentKeyOnChain: AGENT_HEX, takenByVault: true }),
      deps,
    );
    expect("error" in r && r.error).toMatch(/already taken/);
  });

  it("updates a page the vault owns, refuses one it doesn't", async () => {
    const taken = stubFetch({ agentKeyOnChain: AGENT_HEX, takenByVault: true });
    const ok = await prepareVaultPage({ ...base, action: "update" }, taken, deps);
    expect("error" in ok).toBe(false);
    if (!("error" in ok)) {
      expect(ok.action).toBe("update");
      expect(typeof ok.unsigned_tx_bytes).toBe("string");
    }

    const free = stubFetch({ agentKeyOnChain: AGENT_HEX, takenByVault: false });
    const missing = await prepareVaultPage({ ...base, action: "update" }, free, deps);
    expect("error" in missing && missing.error).toMatch(/isn't registered/);
  });
});
