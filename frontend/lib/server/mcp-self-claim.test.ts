/**
 * Own-keys agent claim flow — unit tests.
 *
 * prepare_agent_self_claim / finalize_agent_self_claim /
 * complete_agent_self_claim, plus the self-mode claim-status copy. Every
 * mirror-node call is driven by a fixture fetch; the real network is never
 * touched. IPFS pinning is stubbed at the publish boundary (pinAgentPage
 * still assembles the real page document).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import {
  prepareAgentSelfClaim,
  finalizeAgentSelfClaim,
  completeAgentSelfClaim,
  usernameValidationIssue,
} from "./mcp-tools";
import { stashClaimPackage, getClaimPackage } from "./claim-packages";
import { getPackageStatus, setPackageStatus } from "./package-status";
import { resetKvStoreSingleton } from "./store";
import { GET as claimStatusGET } from "@/app/api/claim-packages/[id]/status/route";

vi.mock("./publish.js", () => ({
  publishPageJson: async () => ({ cid: "QmSelfClaimTestCidForUnitTests" }),
}));

const ok = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as Response;
const notFound = { ok: false, status: 404, json: async () => null } as unknown as Response;

const AGENT = "0.0.1234";
const AGENT_EVM = "0x0000000000000000000000000000000000001234";
const OTHER_EVM = "0x0000000000000000000000000000000000005678";

function fundedAccount(body: Record<string, unknown> = {}) {
  return ok({
    account: AGENT,
    evm_address: AGENT_EVM,
    balance: { balance: 500_000_000 },
    ...body,
  });
}

/** contracts/call fixture: "0x" = name free; encoded = name taken. */
function contractsCall(ownerEvm: string | null) {
  if (!ownerEvm) return ok({ result: "0x" });
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "string", "uint8", "address", "string"],
    [ownerEvm, "QmTaken", 1, ownerEvm, "taken"],
  );
  return ok({ result: encoded });
}

function freeNameFetch(accountBody: unknown = fundedAccount()) {
  return (async (url: string) => {
    if (url.includes("/contracts/call")) return contractsCall(null);
    // fundedAccount() already returns a Response-like — don't re-wrap.
    if (url.includes(`/accounts/${AGENT}`)) return accountBody as Response;
    throw new Error("unexpected fetch " + url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetKvStoreSingleton();
});

describe("prepare_agent_self_claim", () => {
  it("rejects a bad username with the machine-readable issue", async () => {
    const res = await prepareAgentSelfClaim(
      { username: "ab", agent_account_id: AGENT, purpose: "test agent" },
      freeNameFetch(),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) {
      // Same structured message the registry wraps with
      // code/retryable/suggestions — see the route-level test.
      expect(res.error).toBe(usernameValidationIssue("ab").message);
    }
  });

  it("rejects an unknown agent account", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return contractsCall(null);
      if (url.includes("/accounts/0.0.7777")) return notFound;
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentSelfClaim(
      { username: "ghostbot", agent_account_id: "0.0.7777", purpose: "test" },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/not found on Hedera mainnet/);
  });

  it("rejects an unfunded agent account with a funding error", async () => {
    const res = await prepareAgentSelfClaim(
      { username: "brokebot", agent_account_id: AGENT, purpose: "test" },
      freeNameFetch(ok({ account: AGENT, evm_address: AGENT_EVM, balance: { balance: 0 } })),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/holds no HBAR/);
  });

  it("rejects owner_type human and points at prepare_agent_claim", async () => {
    const res = await prepareAgentSelfClaim(
      { username: "humanbot", agent_account_id: AGENT, purpose: "test", owner_type: "human" },
      freeNameFetch(),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/prepare_agent_claim/);
  });

  it("rejects a bad operator address", async () => {
    const res = await prepareAgentSelfClaim(
      { username: "opbot", agent_account_id: AGENT, purpose: "test", operator: "nope" },
      freeNameFetch(),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/operator/);
  });

  it("happy path: stashes a self-mode package, pins nothing, returns agent-chat copy", async () => {
    const res = await prepareAgentSelfClaim(
      {
        username: "selfbot",
        agent_account_id: AGENT,
        purpose: "an independent agent with its own keys",
        capabilities: ["tipping"],
      },
      freeNameFetch(),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.claim_package_id).toMatch(/^[0-9a-f]{32}$/);
    expect(res.agent_account_id).toBe(AGENT);
    // Mode "self" stashed; nothing pinned at prepare time.
    const pkg = await getClaimPackage(res.claim_package_id);
    expect(pkg?.mode).toBe("self");
    expect(pkg?.cid).toBeNull();
    expect(pkg?.ownerAccountId).toBe(AGENT);
    // Copy: human approves in the agent's own chat; the agent's key signs.
    expect(res.next).toMatch(/your own chat/i);
    expect(res.next).toMatch(/your key signs everything/i);
    expect(res.next).toMatch(/awaiting_agent_signature/);
    expect(res.preview_summary).toMatch(/you sign with your own key/);
    expect(res.what_youre_signing).toMatch(new RegExp(`owned by ${AGENT.replace(/\./g, "\\.")}`));
    // No approval link — the human never opens a browser.
    expect("approve_url" in res).toBe(false);
  });
});

describe("finalize_agent_self_claim", () => {
  it("rejects an unknown package id", async () => {
    const res = await finalizeAgentSelfClaim({ claim_package_id: "nope" });
    expect("error" in res).toBe(true);
    const res2 = await finalizeAgentSelfClaim({
      claim_package_id: "0".repeat(32),
    });
    expect("error" in res2).toBe(true);
    if ("error" in res2) expect(res2.error).toMatch(/unknown or expired/);
  });

  it("rejects a sovereign-mode package", async () => {
    const rec = await stashClaimPackage({
      username: "sovbot",
      purpose: "sovereign package",
      pageUrl: "https://voicescape.vercel.app/sovbot",
    });
    expect(rec.mode).toBe("sovereign");
    const res = await finalizeAgentSelfClaim({ claim_package_id: rec.id });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/human-approval claim/);
  });

  it("loses the race when the name is taken", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "racebot", agent_account_id: AGENT, purpose: "race test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return contractsCall(AGENT_EVM);
      if (url.includes(`/accounts/${AGENT}`)) return fundedAccount();
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await finalizeAgentSelfClaim({ claim_package_id: prep.claim_package_id }, fetchFn);
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/just registered by someone else/);
    const status = await getPackageStatus("claim", prep.claim_package_id);
    expect(status?.status).toBe("race_lost");
  });

  it("happy path: unsigned bytes with the agent as payer, status awaiting_agent_signature", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "finbot", agent_account_id: AGENT, purpose: "finalize test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const res = await finalizeAgentSelfClaim({ claim_package_id: prep.claim_package_id }, freeNameFetch());
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.unsignedTxBytes.length).toBeGreaterThan(100);
    // The frozen transaction's payer is the agent's own account.
    expect(res.transactionId).toMatch(new RegExp(`^${AGENT.replace(/\./g, "\\.")}@`));
    expect(res.signerAccountId).toBe(`hedera:mainnet:${AGENT}`);
    expect(res.agent_account_id).toBe(AGENT);
    expect(res.cid).toBe("QmSelfClaimTestCidForUnitTests");
    expect(res.signing_instructions).toMatch(/your own.*key/i);
    expect(res.signing_instructions).toMatch(/120s/);
    expect(res.cost_estimate).toMatch(/few cents/);
    const status = await getPackageStatus("claim", prep.claim_package_id);
    expect(status?.status).toBe("awaiting_agent_signature");
    expect(status?.detail).toMatch(/AGENT's own-key signature/);
  });

  it("replays the same bytes within 60s instead of minting a second tx", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "replaybot", agent_account_id: AGENT, purpose: "replay test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const first = await finalizeAgentSelfClaim({ claim_package_id: prep.claim_package_id }, freeNameFetch());
    const second = await finalizeAgentSelfClaim({ claim_package_id: prep.claim_package_id }, freeNameFetch());
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;
    expect(second.unsignedTxBytes).toBe(first.unsignedTxBytes);
    expect(second.transactionId).toBe(first.transactionId);
  });
});

describe("complete_agent_self_claim", () => {
  it("errors when the page is not on-chain yet", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "waitbot", agent_account_id: AGENT, purpose: "wait test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return contractsCall(null);
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await completeAgentSelfClaim(
      { claim_package_id: prep.claim_package_id, transaction_id: "0.0.1234@1234567890.123456789" },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/not registered on-chain yet/);
  });

  it("completes when the page is registered to the agent's account", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "donebot", agent_account_id: AGENT, purpose: "done test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return contractsCall(AGENT_EVM);
      if (url.includes(`/accounts/${AGENT_EVM}`)) return ok({ account: AGENT });
      if (url.includes(`/accounts/${AGENT}`)) return fundedAccount();
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await completeAgentSelfClaim(
      { claim_package_id: prep.claim_package_id, transaction_id: "0.0.1234@1234567890.123456789" },
      fetchFn,
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.ok).toBe(true);
    expect(res.page_url).toMatch(/\/donebot$/);
    const status = await getPackageStatus("claim", prep.claim_package_id);
    expect(status?.status).toBe("completed");
  });

  it("rejects when the page is owned by someone else", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "hijackbot", agent_account_id: AGENT, purpose: "hijack test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return contractsCall(OTHER_EVM);
      if (url.includes(`/accounts/${OTHER_EVM}`)) return ok({ account: "0.0.5678" });
      if (url.includes(`/accounts/${AGENT}`)) return fundedAccount();
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await completeAgentSelfClaim(
      { claim_package_id: prep.claim_package_id, transaction_id: "0.0.1234@1234567890.123456789" },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/owned by 0\.0\.5678, not your account/);
  });

  it("is idempotent once completed", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "idemabot", agent_account_id: AGENT, purpose: "idempotent test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    await setPackageStatus("claim", prep.claim_package_id, "completed", { username: "idemabot" });
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return contractsCall(null);
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await completeAgentSelfClaim(
      { claim_package_id: prep.claim_package_id, transaction_id: "0.0.1234@1.1" },
      fetchFn,
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.ok).toBe(true);
    expect(res.already).toBe(true);
  });
});

describe("claim status copy for self mode", () => {
  const get = (id: string, params: { params: Promise<{ id: string }> } = { params: Promise.resolve({ id }) }) =>
    claimStatusGET(new Request("http://localhost/"), params as never);

  it("pending detail points at the agent's own chat, not a human approval link", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "copybot", agent_account_id: AGENT, purpose: "copy test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    const res = await get(prep.claim_package_id);
    const body = (await res.json()) as { status: string; detail: string };
    expect(body.status).toBe("pending");
    expect(body.detail).toMatch(/agent to finalize and sign with its own key/);
    expect(body.detail).not.toMatch(/human to open the approval link/);
  });

  it("awaiting_agent_signature self-heals to completed when the page lands on-chain", async () => {
    const prep = await prepareAgentSelfClaim(
      { username: "healbot", agent_account_id: AGENT, purpose: "heal test" },
      freeNameFetch(),
    );
    expect("error" in prep).toBe(false);
    if ("error" in prep) return;
    await setPackageStatus("claim", prep.claim_package_id, "awaiting_agent_signature", {
      username: "healbot",
    });
    // lookupBlockpage is driven by the global fetch here — stub it.
    const origFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/contracts/call")) return contractsCall(AGENT_EVM);
      if (u.includes(`/accounts/${AGENT_EVM}`)) return ok({ account: AGENT });
      if (u.includes(`/accounts/${AGENT}`)) return fundedAccount();
      throw new Error("unexpected fetch " + u);
    }) as unknown as typeof fetch;
    try {
      const res = await get(prep.claim_package_id);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("completed");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
