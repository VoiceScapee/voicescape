/**
 * Voicescape MCP tools — unit tests.
 *
 * Every mirror-node call is driven by a fixture fetch; the real network is
 * never touched.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  lookupBlockpage,
  verifyTip,
  treasuryStats,
  recentTips,
  searchAgents,
  checkProfilePin,
  postAgentIntro,
  requestContextStorage,
  toolResult,
  MIRROR_BASE,
  TREASURY_ID,
} from "./mcp-tools";
import { TIPSENT_TOPIC } from "../leaderboard";
import { checkIpRateLimit } from "./rate-limit";
import { resetKvStoreSingleton } from "./store";

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
const notFound = { status: 404, body: null };

/* ------------------------- fixtures ------------------------- */

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);

function resolvePageResult(): string {
  return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
    "0xAbC1230000000000000000000000000000000001",
    "QmTestHash",
    1n,
    "0x0000000000000000000000000000000000000000",
    "test agent",
  ]);
}

const TIP_TX = "0.0.10424063-1790769243-014218142";
const GROSS = 91824244n; // tinybar
const FEE = (GROSS * 200n) / 10000n;
const pad32 = (n: bigint) => n.toString(16).padStart(64, "0");
const addrTopic = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

function tipContractsResult() {
  return {
    contract_id: "0.0.10854060",
    status: "0x1",
    logs: [
      {
        topics: [
          TIPSENT_TOPIC,
          "0x" + "0".repeat(64),
          addrTopic("0x1111111111111111111111111111111111111111"),
          addrTopic("0x2222222222222222222222222222222222222222"),
        ],
        data: "0x" + pad32(GROSS) + pad32(FEE),
        timestamp: "1790769255.000001045",
      },
    ],
  };
}

/* ------------------------- lookup_blockpage ------------------------- */

describe("lookup_blockpage", () => {
  it("resolves a registered username via the Registry", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: "0.0.99999" })],
    ]);
    const r = await lookupBlockpage("forge", fetchFn);
    expect(r.found).toBe(true);
    expect(r.username).toBe("forge");
    expect(r.owner_evm).toBe("0xabc1230000000000000000000000000000000001");
    expect(r.owner_account).toBe("0.0.99999");
    expect(r.ipfs_hash).toBe("QmTestHash");
    expect(r.owner_type).toBe("agent");
    expect(r.purpose).toBe("test agent");
  });

  it("returns found=false when the Registry reverts (unknown name)", async () => {
    const fetchFn = mockFetch([[/contracts\/call$/, () => ok({ result: "0x" })]]);
    const r = await lookupBlockpage("no-such-user", fetchFn);
    expect(r).toEqual({ found: false, username: "no-such-user" });
  });

  it("returns found=false for malformed usernames without hitting the network", async () => {
    const fetchFn = mockFetch([]);
    const r = await lookupBlockpage("BAD NAME!!", fetchFn);
    expect(r.found).toBe(false);
  });

  it("stays fail-soft when the account lookup fails", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\//, () => notFound],
    ]);
    const r = await lookupBlockpage("forge", fetchFn);
    expect(r.found).toBe(true);
    expect(r.owner_account).toBeNull();
  });
});

/* ------------------------- check_profile_pin ------------------------- */

describe("check_profile_pin", () => {
  const PIN_CID = "Qm" + "1".repeat(44);

  function pinPageResult(): string {
    return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
      "0xAbC1230000000000000000000000000000000001",
      PIN_CID,
      1n,
      "0x0000000000000000000000000000000000000000",
      "test agent",
    ]);
  }

  function streamResponse(chunks: Uint8Array[], contentType = "application/json"): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": contentType } });
  }

  /** Routes mirror-node calls to the Registry fixture; gateway calls per `gw`. */
  function pinFetch(
    gw: (url: string) => Response | { status: number },
  ): typeof fetch {
    return (async (input: any) => {
      const url = String(input);
      if (/contracts\/call$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ result: pinPageResult() }) } as Response;
      }
      if (/accounts\//.test(url)) {
        return { ok: true, status: 200, json: async () => ({ account: "0.0.99999" }) } as Response;
      }
      const out = gw(url);
      return out instanceof Response ? out : ({ ok: false, status: out.status, body: null } as unknown as Response);
    }) as unknown as typeof fetch;
  }

  it("resolves the username's CID and reports reachable with byte count", async () => {
    const body = new TextEncoder().encode('{"name":"forge"}');
    const fetchFn = pinFetch(() => streamResponse([body]));
    const r = await checkProfilePin({ username: "forge" }, fetchFn);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.username).toBe("forge");
    expect(r.cid).toBe(PIN_CID);
    expect(r.reachable).toBe(true);
    expect(r.bytes_fetched).toBe(body.byteLength);
    expect(r.gateway).toContain("pinata");
    expect(r.truncated).toBe(false);
  });

  it("falls through to the second gateway when the first fails", async () => {
    const body = new TextEncoder().encode("{}");
    const fetchFn = pinFetch((url) =>
      url.includes("pinata") ? { status: 500 } : streamResponse([body]),
    );
    const r = await checkProfilePin({ cid: PIN_CID }, fetchFn);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.reachable).toBe(true);
    expect(r.gateway).toContain("ipfs.io");
  });

  it("reports unreachable when every gateway fails", async () => {
    const fetchFn = pinFetch(() => ({ status: 500 }));
    const r = await checkProfilePin({ cid: PIN_CID }, fetchFn);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.reachable).toBe(false);
    expect(r.bytes_fetched).toBe(0);
    expect(r.gateway).toBeNull();
    expect(r.note).toContain("not retrievable");
  });

  it("rejects malformed CIDs without hitting the network", async () => {
    const fetchFn = pinFetch(() => {
      throw new Error("must not fetch");
    });
    const r = await checkProfilePin({ cid: "not-a-cid" }, fetchFn);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.reachable).toBe(false);
    expect(r.note).toContain("CID");
  });

  it("reports unreachable for an unregistered username", async () => {
    const fetchFn = pinFetch(() => ({ status: 500 }));
    // Override: Registry reverts for unknown names.
    const f2 = (async (input: any) => {
      const url = String(input);
      if (/contracts\/call$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ result: "0x" }) } as Response;
      }
      return (fetchFn as any)(input);
    }) as unknown as typeof fetch;
    const r = await checkProfilePin({ username: "no-such-user" }, f2);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.reachable).toBe(false);
    expect(r.note).toContain("not registered");
  });

  it("returns an error when given neither username nor cid", async () => {
    const r = await checkProfilePin({}, pinFetch(() => ({ status: 500 })));
    expect("error" in r).toBe(true);
  });

  it("truncates reads past the byte cap", async () => {
    const big = new Uint8Array(300 * 1024).fill(7);
    const fetchFn = pinFetch(() => streamResponse([big]));
    const r = await checkProfilePin({ cid: PIN_CID }, fetchFn);
    if ("error" in r) throw new Error("unexpected error");
    expect(r.reachable).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.bytes_fetched).toBeLessThanOrEqual(256 * 1024);
  });
});

/* ------------------------- verify_tip ------------------------- */

describe("verify_tip", () => {
  function tipFetch() {
    return mockFetch([
      [/\/transactions\//, () =>
        ok({
          transactions: [
            {
              entity_id: "0.0.10854060",
              result: "SUCCESS",
              consensus_timestamp: "1790769255.000001045",
            },
          ],
        })],
      [/contracts\/results\//, () => ok(tipContractsResult())],
    ]);
  }

  it("verifies a real tip and decodes the exact 98/2 split", async () => {
    const r = await verifyTip("0.0.10424063@1790769243.014218142", tipFetch());
    expect(r.is_tip).toBe(true);
    expect(r.status).toBe("SUCCESS");
    expect(r.gross_hbar).toBe("0.91824244");
    expect(r.treasury_hbar).toBe("0.01836484");
    expect(r.creator_hbar).toBe("0.8998776");
    expect(r.split_exact_98_2).toBe(true);
    expect(r.sender_evm).toBe("0x1111111111111111111111111111111111111111");
    expect(r.recipient_evm).toBe("0x2222222222222222222222222222222222222222");
    expect(r.hashscan).toContain("hashscan.io");
  });

  it("accepts the dash-separated id form too", async () => {
    const r = await verifyTip(TIP_TX, tipFetch());
    expect(r.is_tip).toBe(true);
    expect(r.transaction_id).toBe(TIP_TX);
  });

  it("rejects malformed ids without network", async () => {
    const r = await verifyTip("not-a-tx", mockFetch([]));
    expect(r.is_tip).toBe(false);
    expect(r.reason).toContain("transaction id");
  });

  it("reports not-a-tip when the tx targeted another contract", async () => {
    const fetchFn = mockFetch([
      [/\/transactions\//, () =>
        ok({ transactions: [{ entity_id: "0.0.999", result: "SUCCESS" }] })],
    ]);
    const r = await verifyTip(TIP_TX, fetchFn);
    expect(r.is_tip).toBe(false);
    expect(r.reason).toContain("not a successful tip");
  });

  it("reports not-a-tip for a Tips call with no TipSent event (e.g. purchase)", async () => {
    const fetchFn = mockFetch([
      [/\/transactions\//, () =>
        ok({ transactions: [{ entity_id: "0.0.10854060", result: "SUCCESS" }] })],
      [/contracts\/results\//, () => ok({ contract_id: "0.0.10854060", status: "0x1", logs: [] })],
    ]);
    const r = await verifyTip(TIP_TX, fetchFn);
    expect(r.is_tip).toBe(false);
  });
});

/* ------------------------- treasury_stats ------------------------- */

describe("treasury_stats", () => {
  it("returns balance and recent inbound transfers", async () => {
    const fetchFn = mockFetch([
      [/accounts\/0\.0\.10424063$/, () => ok({ balance: { balance: 5_000_000_000 } })],
      [/transactions\?/, () =>
        ok({
          transactions: [
            {
              transaction_id: "0.0.1-2-3",
              consensus_timestamp: "1790000000.000000001",
              transfers: [
                { account: "0.0.10424063", amount: 1_836_484 },
                { account: "0.0.10854060", amount: 89_987_760 },
                { account: "0.0.555", amount: -91_824_244 },
              ],
            },
            {
              transaction_id: "0.0.1-2-4",
              consensus_timestamp: "1790000001.000000001",
              transfers: [{ account: "0.0.10424063", amount: -500 }],
            },
          ],
        })],
    ]);
    const r = await treasuryStats(fetchFn);
    expect(r.treasury).toBe(TREASURY_ID);
    expect(r.balance_hbar).toBe("50");
    expect(r.recent_inbound).toHaveLength(1);
    expect(r.recent_inbound[0].amount_hbar).toBe("0.01836484");
    expect(r.recent_inbound[0].from).toBe("0.0.555");
  });

  it("returns a null balance instead of throwing when the mirror node is down", async () => {
    const r = await treasuryStats(mockFetch([[/accounts\//, () => ({ status: 500, body: null })]]));
    expect(r.balance_hbar).toBeNull();
    expect(r.recent_inbound).toEqual([]);
  });
});

/* ------------------------- recent_tips ------------------------- */

describe("recent_tips", () => {
  const TIPPAGE_SEL = new ethers.Interface([
    "function tipPage(string username) payable",
  ]).getFunction("tipPage")!.selector;

  it("lists recent calls with kind labels", async () => {
    const fetchFn = mockFetch([
      [/contracts\/0\.0\.10854060\/results/, () =>
        ok({
          results: [
            {
              timestamp: "1790000002.000000001",
              from: "0xaaaa",
              amount: 100_000_000,
              function_parameters: TIPPAGE_SEL + "00".repeat(32),
              transaction_id: "0.0.1-2-5",
            },
            {
              timestamp: "1790000001.000000001",
              from: "0xbbbb",
              amount: 0,
              function_parameters: "0xdeadbeef" + "00".repeat(32),
              error_message: "",
            },
            {
              timestamp: "1790000000.000000001",
              from: "0xcccc",
              amount: 0,
              function_parameters: "0xdeadbeef",
              error_message: "revert",
            },
          ],
        })],
    ]);
    const r = await recentTips(10, fetchFn);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.contract).toBe("0.0.10854060");
    expect(r.tips).toHaveLength(2); // reverted row excluded
    expect(r.tips[0].kind).toBe("tip");
    expect(r.tips[0].amount_hbar).toBe("1");
    expect(r.tips[0].transaction_id).toBe("0.0.1-2-5");
    expect(r.tips[1].kind).toBe("other");
  });

  it("rejects out-of-range limits", async () => {
    expect(await recentTips(0, mockFetch([]))).toEqual({
      error: "limit must be an integer between 1 and 25",
    });
    expect(await recentTips(26, mockFetch([]))).toEqual({
      error: "limit must be an integer between 1 and 25",
    });
  });
});

/* ------------------------- search_agents ------------------------- */

describe("search_agents", () => {
  it("filters the directory by query text", async () => {
    const fetchFn = mockFetch([
      [/api\/agents\/directory$/, () =>
        ok({
          agents: [
            { username: "forge", purpose: "builds blockpages", owner: "0xabc" },
            { username: "helper", purpose: "answers questions", owner: "0xdef" },
          ],
          count: 2,
        })],
    ]);
    const r = await searchAgents("build", fetchFn, "https://test.local");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].username).toBe("forge");
    expect(r.total_in_directory).toBe(2);
    expect(r.note).toContain("self-reported");
  });

  it("returns empty matches for a blank query without fetching", async () => {
    const r = await searchAgents("   ", mockFetch([]), "https://test.local");
    expect(r.matches).toEqual([]);
  });

  it("passes the availability flag through when present, null when absent", async () => {
    const fetchFn = mockFetch([
      [/api\/agents\/directory$/, () =>
        ok({
          agents: [
            {
              username: "forge",
              purpose: "builds blockpages",
              owner: "0xabc",
              availability: { open: true, updatedAt: "2026-09-30T00:00:00.000Z" },
            },
            { username: "helper", purpose: "builds helpers", owner: "0xdef" },
            {
              username: "shady",
              purpose: "builds trouble",
              owner: "0xghi",
              availability: { open: "yes please" },
            },
          ],
          count: 3,
        })],
    ]);
    const r = await searchAgents("build", fetchFn, "https://test.local");
    expect(r.matches).toHaveLength(3);
    expect(r.matches[0].availability).toEqual({ open: true, updatedAt: "2026-09-30T00:00:00.000Z" });
    expect(r.matches[1].availability).toBeNull();
    // Malformed flag degrades to null, never a fabricated "open".
    expect(r.matches[2].availability).toBeNull();
  });
});

/* ------------------------- toolResult helper ------------------------- */

describe("toolResult", () => {
  it("serializes objects as JSON text content", () => {
    const r = toolResult({ a: 1 });
    expect(r.content[0].type).toBe("text");
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1 });
  });
});

/* ------------------------- rate limiter ------------------------- */

describe("MCP per-IP rate limit (20/hour)", () => {
  beforeEach(async () => {
    await resetKvStoreSingleton();
  });

  it("allows 20 requests then blocks the 21st", async () => {
    const ip = "9.9.9.9";
    for (let i = 1; i <= 20; i++) {
      const r = await checkIpRateLimit(ip, "mcp", 20, 3_600_000);
      expect(r.allowed).toBe(true);
      expect(r.used).toBe(i);
    }
    const blocked = await checkIpRateLimit(ip, "mcp", 20, 3_600_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.used).toBe(21);
  });

  it("tracks IPs independently", async () => {
    for (let i = 0; i < 20; i++) await checkIpRateLimit("1.1.1.1", "mcp", 20, 3_600_000);
    const other = await checkIpRateLimit("2.2.2.2", "mcp", 20, 3_600_000);
    expect(other.allowed).toBe(true);
    expect(other.used).toBe(1);
  });

  it("resets in a new window", async () => {
    const now = Date.now();
    await checkIpRateLimit("3.3.3.3", "mcp", 1, 60_000, now);
    const blocked = await checkIpRateLimit("3.3.3.3", "mcp", 1, 60_000, now);
    expect(blocked.allowed).toBe(false);
    const next = await checkIpRateLimit("3.3.3.3", "mcp", 1, 60_000, now + 60_001);
    expect(next.allowed).toBe(true);
  });
});

/* ------------------------- post_agent_intro ------------------------- */

describe("post_agent_intro tool", () => {
  beforeEach(async () => {
    await resetKvStoreSingleton();
  });

  function withIp<T>(ip: string, fn: () => Promise<T>): Promise<T> {
    return requestContextStorage.run(
      { origin: "https://voicescape.vercel.app", clientIp: ip },
      fn,
    );
  }

  it("posts an intro and returns a claim code", async () => {
    const res = await withIp("7.7.7.7", () =>
      postAgentIntro("helloagent", "I index agent reputations."),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.posted).toBe(true);
    expect(res.claim_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.message).toMatch(/Save this claim code/);
  });

  it("rate-limits to one intro per IP per day", async () => {
    const first = await withIp("8.8.8.8", () => postAgentIntro("agenta", "first intro"));
    expect("error" in first).toBe(false);
    const second = await withIp("8.8.8.8", () => postAgentIntro("agentb", "second intro"));
    expect("error" in second).toBe(true);
    if ("error" in second) expect(second.error).toMatch(/one intro per day/i);
  });

  it("rejects intros containing links", async () => {
    const res = await withIp("9.8.7.6", () =>
      postAgentIntro("linker", "find me at https://example.com"),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/can't include links/i);
  });
});

void MIRROR_BASE;
