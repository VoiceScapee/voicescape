/**
 * verify-registration lib tests.
 *
 * The mirror-node fetch is stubbed (no network). Env is scrubbed of
 * HCS10_REGISTRY_TOPIC so the registry check deterministically reports
 * `unconfigured` on mainnet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRegisterMessageFor,
  matchAgentTopics,
  verifyAgentRegistration,
  VerifierError,
} from "./verify-registration";

const ACCT = "0.0.123456";

function topicRow(topic_id: string, memo: string | null) {
  return { topic_id, memo };
}

function jsonRes(body: unknown) {
  // Typed as Response so vi.mocked(fetch).mockImplementation accepts it;
  // tests only ever read ok/json.
  return { ok: true, json: async () => body } as unknown as Response;
}

/**
 * URL-dispatching mirror stub: creation txs, per-topic memos, account
 * lookups, our directory, and registry messages.
 */
function stubMirror(opts: {
  createdTopics?: Array<{ id: string; memo: string | null }>;
  directoryAgents?: Array<{ username: string; owner: string }>;
  registryMessages?: Array<{ message: string; consensus_timestamp: string; sequence_number: string }>;
} = {}) {
  const memos = new Map((opts.createdTopics ?? []).map((t) => [t.id, t.memo]));
  return async (url: any) => {
    const u = String(url);
    if (u.includes("/api/agents/directory")) {
      return jsonRes({ agents: opts.directoryAgents ?? [] });
    }
    if (u.includes("/api/v1/accounts/")) {
      return jsonRes({ account: ACCT });
    }
    if (u.includes("transactiontype=CONSENSUSCREATETOPIC")) {
      return jsonRes({
        transactions: (opts.createdTopics ?? []).map((t) => ({ entity_id: t.id })),
      });
    }
    if (u.includes("/messages")) {
      return jsonRes({ messages: opts.registryMessages ?? [] });
    }
    const m = u.match(/\/api\/v1\/topics\/(0\.0\.\d+)/);
    if (m) {
      const id = m[1];
      return jsonRes({ topic_id: id, memo: memos.has(id) ? memos.get(id) : null });
    }
    return jsonRes({});
  };
}

const BOTH_TOPICS = [
  { id: "0.0.11", memo: `hcs-10:0:0:0:${ACCT}` },
  { id: "0.0.12", memo: "hcs-10:0:0:1" },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ topics: [] })));
  vi.stubEnv("HCS10_REGISTRY_TOPIC", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("matchAgentTopics", () => {
  it("matches inbound (type 0 + account params) and outbound (type 1)", () => {
    const { inbound, outbound } = matchAgentTopics(
      [
        topicRow("0.0.1", `hcs-10:0:0:0:${ACCT}`),
        topicRow("0.0.2", "hcs-10:0:0:1"),
        topicRow("0.0.3", "some other memo"),
        topicRow("0.0.4", null),
      ],
      ACCT,
    );
    expect(inbound).toEqual({ topicId: "0.0.1", memo: `hcs-10:0:0:0:${ACCT}` });
    expect(outbound).toEqual({ topicId: "0.0.2", memo: "hcs-10:0:0:1" });
  });

  it("rejects an inbound memo bound to a different account", () => {
    const { inbound } = matchAgentTopics(
      [topicRow("0.0.1", "hcs-10:0:0:0:0.0.999")],
      ACCT,
    );
    expect(inbound).toBeNull();
  });

  it("accepts indexed=1 inbound memos (flags the deviation downstream)", () => {
    const { inbound } = matchAgentTopics(
      [topicRow("0.0.1", `hcs-10:1:0:0:${ACCT}`)],
      ACCT,
    );
    expect(inbound?.topicId).toBe("0.0.1");
  });
});

describe("isRegisterMessageFor", () => {
  it("matches an hcs-10 register op with the exact operator_id", () => {
    expect(
      isRegisterMessageFor(
        { p: "hcs-10", op: "register", operator_id: `0.0.1@${ACCT}` },
        "0.0.1",
        ACCT,
      ),
    ).toBe(true);
  });

  it("rejects wrong op, wrong prefix, wrong operator_id, and junk", () => {
    expect(
      isRegisterMessageFor({ p: "hcs-10", op: "message", operator_id: `0.0.1@${ACCT}` }, "0.0.1", ACCT),
    ).toBe(false);
    expect(
      isRegisterMessageFor({ p: "hcs-10", op: "register", operator_id: `0.0.2@${ACCT}` }, "0.0.1", ACCT),
    ).toBe(false);
    expect(isRegisterMessageFor({ p: "hcs-1" }, "0.0.1", ACCT)).toBe(false);
    expect(isRegisterMessageFor("hcs-10 register", "0.0.1", ACCT)).toBe(false);
    expect(isRegisterMessageFor(null, "0.0.1", ACCT)).toBe(false);
  });
});

describe("verifyAgentRegistration", () => {
  it("verifies when inbound+outbound topics exist (registry unconfigured is excluded, not failed)", async () => {
    vi.mocked(fetch).mockImplementation(stubMirror({ createdTopics: BOTH_TOPICS }));
    const r = await verifyAgentRegistration({
      accountId: ACCT,
      network: "mainnet",
      origin: "https://example.com",
    });
    expect(r.accountId).toBe(ACCT);
    expect(r.checks.inboundTopic.ok).toBe(true);
    expect(r.checks.inboundTopic.topicId).toBe("0.0.11");
    expect(r.checks.outboundTopic.ok).toBe(true);
    expect(r.checks.registryRegistration.status).toBe("unconfigured");
    expect(r.verified).toBe(true);
  });

  it("is not verified when topics are missing", async () => {
    const r = await verifyAgentRegistration({
      accountId: ACCT,
      network: "mainnet",
      origin: "https://example.com",
    });
    expect(r.verified).toBe(false);
    expect(r.checks.inboundTopic.ok).toBe(false);
    expect(r.checks.outboundTopic.ok).toBe(false);
  });

  it("flags indexed=1 memos with a note instead of failing", async () => {
    vi.mocked(fetch).mockImplementation(
      stubMirror({
        createdTopics: [
          { id: "0.0.11", memo: `hcs-10:1:0:0:${ACCT}` },
          { id: "0.0.12", memo: "hcs-10:0:0:1" },
        ],
      }),
    );
    const r = await verifyAgentRegistration({
      accountId: ACCT,
      network: "mainnet",
      origin: "https://example.com",
    });
    expect(r.verified).toBe(true);
    expect(r.checks.inboundTopic.note).toContain("indexed=1");
  });

  it("confirms a register message when a registry topic is configured", async () => {
    vi.stubEnv("HCS10_REGISTRY_TOPIC", "0.0.555");
    const payload = Buffer.from(
      JSON.stringify({ p: "hcs-10", op: "register", operator_id: `0.0.11@${ACCT}` }),
    ).toString("base64");
    vi.mocked(fetch).mockImplementation(
      stubMirror({
        createdTopics: BOTH_TOPICS,
        registryMessages: [
          { message: payload, consensus_timestamp: "123.456", sequence_number: "7" },
        ],
      }),
    );
    const r = await verifyAgentRegistration({
      accountId: ACCT,
      network: "mainnet",
      origin: "https://example.com",
    });
    expect(r.checks.registryRegistration.status).toBe("confirmed");
    expect(r.checks.registryRegistration.evidence?.sequenceNumber).toBe("7");
    expect(r.verified).toBe(true);
  });

  it("reports not_found when the registry scan has no register message", async () => {
    vi.stubEnv("HCS10_REGISTRY_TOPIC", "0.0.555");
    vi.mocked(fetch).mockImplementation(stubMirror({ createdTopics: BOTH_TOPICS }));
    const r = await verifyAgentRegistration({
      accountId: ACCT,
      network: "mainnet",
      origin: "https://example.com",
    });
    expect(r.checks.registryRegistration.status).toBe("not_found");
    expect(r.verified).toBe(false);
  });

  it("rejects a missing/invalid identity with 400", async () => {
    await expect(
      verifyAgentRegistration({ network: "mainnet", origin: "https://example.com" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      verifyAgentRegistration({ accountId: "nope", network: "mainnet", origin: "https://example.com" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("resolves username → account via our directory + mirror accounts lookup", async () => {
    const evm = "0x" + "ab".repeat(20);
    vi.mocked(fetch).mockImplementation(
      stubMirror({
        createdTopics: [{ id: "0.0.11", memo: `hcs-10:0:0:0:${ACCT}` }],
        directoryAgents: [{ username: "bacon-the-dino", owner: evm }],
      }),
    );
    const r = await verifyAgentRegistration({
      username: "bacon-the-dino",
      network: "mainnet",
      origin: "https://example.com",
    });
    expect(r.username).toBe("bacon-the-dino");
    expect(r.accountId).toBe(ACCT);
    expect(r.checks.inboundTopic.ok).toBe(true);
  });

  it("returns 404 for an unknown username", async () => {
    vi.mocked(fetch).mockImplementation(async () => jsonRes({ agents: [] }));
    const err = await verifyAgentRegistration({
      username: "nope",
      network: "mainnet",
      origin: "https://example.com",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(VerifierError);
    expect(err.status).toBe(404);
  });
});
