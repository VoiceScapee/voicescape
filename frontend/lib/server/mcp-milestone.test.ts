/**
 * Milestone-commit tools — unit tests.
 * prepare: builds real SDK bytes (no network except the worker lookup).
 * verify: every mirror-node call is fixture-driven.
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  ScheduleCreateTransaction,
  Transaction,
} from "@hiero-ledger/sdk";
import { prepareMilestoneCommit, verifyMilestoneCommit } from "./mcp-milestone";

type RouteHandler = (url: string, init?: RequestInit) => unknown;

function mockFetch(routes: Array<[RegExp, RouteHandler | { status: number; body: unknown }]>): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const out: { status: number; body: unknown } =
          typeof handler === "function" ? (handler(url, init) as { status: number; body: unknown }) : handler;
        return {
          ok: out.status >= 200 && out.status < 300,
          status: out.status,
          json: async () => out.body,
        } as Response;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const ok = (body: unknown) => ({ status: 200, body });

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);

function resolveOk() {
  return ok({
    result: RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
      "0xAbC1230000000000000000000000000000000001",
      "QmTestHash",
      1n,
      "0x0000000000000000000000000000000000000000",
      "test agent",
    ]),
  });
}

/** Mirror account lookup (lookupBlockpage resolves owner 0xabc... -> account). */
function workerFetch() {
  return mockFetch([
    [/contracts\/call$/, () => resolveOk()],
    [/accounts\/0xabc123/, () => ok({ account: "0.0.99999" })],
  ]);
}

const GOOD_ARGS = {
  worker_username: "forge",
  amount_hbar: "5",
  milestone_id: "homepage-v2-m1",
  deadline_iso: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  buyer_account_id: "0.0.12345",
  // Deterministic test-only public key (never a real wallet key).
  buyer_public_key: "302d300706052b8104000a03220002bb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020d",
};

/* ------------------------- prepare_milestone_commit ------------------------- */

describe("prepare_milestone_commit", () => {
  it("rejects an invalid worker username", async () => {
    const r = await prepareMilestoneCommit({ ...GOOD_ARGS, worker_username: "Bad Name!" }, workerFetch());
    expect("error" in r).toBe(true);
  });

  it("rejects a non-positive amount", async () => {
    const r = await prepareMilestoneCommit({ ...GOOD_ARGS, amount_hbar: "0" }, workerFetch());
    expect("error" in r).toBe(true);
  });

  it("rejects a past deadline", async () => {
    const r = await prepareMilestoneCommit(
      { ...GOOD_ARGS, deadline_iso: new Date(Date.now() - 1000).toISOString() },
      workerFetch(),
    );
    expect("error" in r).toBe(true);
  });

  it("rejects a deadline beyond the 61-day cap", async () => {
    const r = await prepareMilestoneCommit(
      { ...GOOD_ARGS, deadline_iso: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() },
      workerFetch(),
    );
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("62 days");
  });

  it("rejects a bad buyer account id", async () => {
    const r = await prepareMilestoneCommit({ ...GOOD_ARGS, buyer_account_id: "nope" }, workerFetch());
    expect("error" in r).toBe(true);
  });

  it("rejects an unparseable buyer public key", async () => {
    const r = await prepareMilestoneCommit({ ...GOOD_ARGS, buyer_public_key: "zzz" }, workerFetch());
    expect("error" in r).toBe(true);
  });

  it("refuses to commit to an unregistered worker", async () => {
    const noWorker = mockFetch([[/contracts\/call$/, () => ({ status: 200, body: { result: "0x" } })]]);
    const r = await prepareMilestoneCommit(GOOD_ARGS, noWorker);
    expect("error" in r).toBe(true);
  });

  it("builds unsigned ScheduleCreate bytes with the honest terms", async () => {
    const r = await prepareMilestoneCommit(GOOD_ARGS, workerFetch());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.ok).toBe(true);
    expect(r.worker_username).toBe("forge");
    expect(r.amount_hbar).toBe("5");
    expect(r.creator_net_hbar).toBe("4.9");
    expect(r.treasury_fee_hbar).toBe("0.1");
    expect(r.what_signing_means).toContain("does NOT move funds now");

    // The bytes decode to a ScheduleCreate. Field-level getters throw on
    // frozen transactions, so assert the memo bytes are embedded and rely
    // on the SDK setters (verified by reading the code) + the verify-side
    // decode tests for the rest.
    const tx = Transaction.fromBytes(Buffer.from(r.unsigned_schedule_bytes, "base64"));
    expect(tx instanceof ScheduleCreateTransaction).toBe(true);
    expect(Buffer.from(r.unsigned_schedule_bytes, "base64").includes("homepage-v2-m1")).toBe(true);
    expect(r.unsigned_schedule_bytes.length).toBeGreaterThan(200);
  });
});

/* ------------------------- verify_milestone_commit ------------------------- */

function scheduleBody(overrides: Record<string, unknown> = {}) {
  // Real inner tx bytes: tipPage("forge") payable 5 HBAR.
  const inner = new ContractExecuteTransaction()
    .setContractId("0.0.10854060")
    .setFunction("tipPage", new ContractFunctionParameters().addString("forge"))
    .setPayableAmount(new Hbar(5))
    .setGas(500_000);
  return {
    schedule_id: "0.0.10912653",
    memo: "homepage-v2-m1",
    wait_for_expiry: true,
    expiration_time: `${Math.floor(Date.now() / 1000) + 7 * 24 * 3600}.000000000`,
    executed_timestamp: null,
    deleted: false,
    signatures: [{ public_key_prefix: "302a30", signature: "ab", type: "ED25519" }],
    transaction_body: Buffer.from(inner.toBytes()).toString("base64"),
    ...overrides,
  };
}

function scheduleFetch(body: unknown, status = 200) {
  return mockFetch([[/schedules\/0\.0\.10912653$/, () => ({ status, body })]]);
}

describe("verify_milestone_commit", () => {
  it("rejects a malformed schedule id", async () => {
    const r = await verifyMilestoneCommit({ schedule_id: "nope" }, mockFetch([]));
    expect(r.ok).toBe(false);
  });

  it("reports not-found for an unknown schedule", async () => {
    const r = await verifyMilestoneCommit(
      { schedule_id: "0.0.10912653" },
      mockFetch([[/schedules\//, () => ({ status: 404, body: null })]]),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("verdicts committed + safe_to_start when terms match", async () => {
    const r = await verifyMilestoneCommit(
      {
        schedule_id: "0.0.10912653",
        expected_milestone_id: "homepage-v2-m1",
        expected_worker_username: "forge",
        expected_amount_hbar: "5",
      },
      scheduleFetch(scheduleBody()),
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe("committed");
    expect(r.safe_to_start).toBe(true);
    expect(r.inner_recipient_username).toBe("forge");
    expect(r.inner_amount_hbar).toBe("5");
    expect(r.inner_contract).toBe("0.0.10854060");
  });

  it("flags a deleted schedule — do not start", async () => {
    const r = await verifyMilestoneCommit(
      { schedule_id: "0.0.10912653" },
      scheduleFetch(scheduleBody({ deleted: true })),
    );
    expect(r.status).toBe("deleted");
    expect(r.safe_to_start).toBe(false);
  });

  it("flags an executed schedule — settled", async () => {
    const r = await verifyMilestoneCommit(
      { schedule_id: "0.0.10912653" },
      scheduleFetch(scheduleBody({ executed_timestamp: `${Math.floor(Date.now() / 1000)}.000000000` })),
    );
    expect(r.status).toBe("executed");
    expect(r.safe_to_start).toBe(false);
  });

  it("flags an unsigned schedule — do not start", async () => {
    const r = await verifyMilestoneCommit(
      { schedule_id: "0.0.10912653" },
      scheduleFetch(scheduleBody({ signatures: [] })),
    );
    expect(r.status).toBe("awaiting_buyer_signature");
    expect(r.safe_to_start).toBe(false);
  });

  it("rejects on amount mismatch", async () => {
    const r = await verifyMilestoneCommit(
      { schedule_id: "0.0.10912653", expected_amount_hbar: "10" },
      scheduleFetch(scheduleBody()),
    );
    expect(r.status).toBe("committed");
    expect(r.safe_to_start).toBe(false);
    expect(r.reasons?.join(" ")).toContain("amount mismatch");
  });

  it("rejects when wait_for_expiry is false", async () => {
    const r = await verifyMilestoneCommit(
      { schedule_id: "0.0.10912653" },
      scheduleFetch(scheduleBody({ wait_for_expiry: false })),
    );
    expect(r.safe_to_start).toBe(false);
    expect(r.reasons?.join(" ")).toContain("wait_for_expiry");
  });
});
