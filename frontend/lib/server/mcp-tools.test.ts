/**
 * Voicescape MCP tools — unit tests.
 *
 * Every mirror-node call is driven by a fixture fetch; the real network is
 * never touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import {
  lookupBlockpage,
  verifyTip,
  treasuryStats,
  recentTips,
  searchAgents,
  checkProfilePin,
  postAgentIntro,
  prepareAgentClaim,
  proposePageUpdate,
  getStarted,
  quoteTip,
  trendingCreators,
  blockpageEarnings,
  readAgentMessages,
  prepareAgentMessage,
  listTipAssets,
  requestContextStorage,
  toolResult,
  toolError,
  usernameValidationError,
  usernameValidationIssue,
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
    const first = r.content[0];
    expect(first.type).toBe("text");
    expect(first.type === "text" && JSON.parse(first.text)).toEqual({ a: 1 });
  });

  it("imageResult wraps a PNG buffer as base64 image content", async () => {
    const { imageResult } = await import("./mcp-tools");
    const r = imageResult(Buffer.from([0x89, 0x50]));
    const first = r.content[0];
    expect(first.type).toBe("image");
    if (first.type === "image") {
      expect(first.mimeType).toBe("image/png");
      expect(first.data).toBe(Buffer.from([0x89, 0x50]).toString("base64"));
    }
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
      { origin: "https://voicescape.vercel.app", clientIp: ip, requestId: null, authToken: null },
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

describe("prepare_agent_claim tool", () => {
  const ok = (body: unknown) =>
    (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => body,
      }) as unknown as Response)();

  it("rejects a bad username", async () => {
    const res = await prepareAgentClaim({
      username: "BAD NAME!",
      owner_account_id: "0.0.1234",
      purpose: "test",
    });
    expect("error" in res).toBe(true);
  });

  it("rejects a bad owner account id", async () => {
    const res = await prepareAgentClaim({
      username: "goodbot",
      owner_account_id: "not-an-account",
      purpose: "test",
    });
    expect("error" in res).toBe(true);
  });

  it("rejects a missing purpose", async () => {
    const res = await prepareAgentClaim({
      username: "goodbot",
      owner_account_id: "0.0.1234",
      purpose: "",
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/purpose/i);
  });

  it("rejects a username that is already registered", async () => {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "string", "uint8", "address", "string"],
      [
        "0x0000000000000000000000000000000000001234",
        "QmTaken",
        1,
        "0x0000000000000000000000000000000000001234",
        "taken",
      ],
    );
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: encoded });
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      { username: "takenbot", owner_account_id: "0.0.1234", purpose: "test" },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/already registered/);
  });

  it("rejects when the owner account does not exist", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      if (url.includes("/accounts/")) {
        return {
          ok: false,
          status: 404,
          json: async () => null,
        } as unknown as Response;
      }
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      { username: "freebot", owner_account_id: "0.0.99999999", purpose: "test" },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/not found/);
  });

  it("returns a short approval link package — nothing pinned, no tx built at prepare time", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      {
        username: "linkbot",
        purpose: "an agent page for testing links",
        intro_claim_code: "ABCD-1234",
      },
      fetchFn,
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.claim_package_id).toMatch(/^[0-9a-f]{32}$/);
    expect(res.approve_url).toBe(`https://voicescape.vercel.app/c/${res.claim_package_id}`);
    expect(res.owner_account_id).toBeNull();
    expect(res.intro_claim_code).toBe("ABCD-1234");
    // No transaction bytes at prepare time — built at tap time.
    expect("unsignedTxBytes" in res).toBe(false);
    expect(res.next).toMatch(/approval link/);
  });

  it("rejects non-https URLs in socials/links", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      {
        username: "urlbot",
        purpose: "url validation test",
        socials: [{ platform: "x", url: "javascript:alert(1)" }],
      },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/https/);
  });

  it("rejects data: URLs in links", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      {
        username: "urlbot2",
        purpose: "url validation test",
        links: [{ label: "x", url: "data:text/html,<h1>hi</h1>" }],
      },
      fetchFn,
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/https/);
  });

  it("accepts https URLs in socials/links", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      {
        username: "urlbot3",
        purpose: "url validation test",
        socials: [{ platform: "x", url: "https://x.com/example" }],
        links: [{ label: "site", url: "https://example.com/page" }],
      },
      fetchFn,
    );
    expect("error" in res).toBe(false);
  });

  it("skips the account check when no owner override is given", async () => {
    let accountsHit = 0;
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      if (url.includes("/accounts/")) accountsHit++;
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      { username: "noownerbot", purpose: "no owner needed" },
      fetchFn,
    );
    expect("error" in res).toBe(false);
    expect(accountsHit).toBe(0);
  });

  it("checks the account when an owner override is given", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      if (url.includes("/accounts/0.0.1234")) {
        return ok({ evm_address: "0x0000000000000000000000000000000000001234", balance: { balance: 5_000_000_00 } });
      }
      throw new Error("unexpected fetch " + url);
    }) as unknown as typeof fetch;
    const res = await prepareAgentClaim(
      { username: "ownerbot", owner_account_id: "0.0.1234", purpose: "owned" },
      fetchFn,
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.owner_account_id).toBe("0.0.1234");
    expect(res.owner_funded).toBe(true);
    expect(res.what_youre_signing).toMatch(/owned by 0\.0\.1234/);
  });

  it("rejects a bad operator address", async () => {
    const res = await prepareAgentClaim({
      username: "opbot",
      purpose: "test",
      operator: "not-an-address",
    });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/operator/);
  });
});

describe("get_started", () => {
  it("returns the onboarding payload with no network", async () => {
    const g = getStarted();
    expect(g.guarantees.length).toBeGreaterThan(0);
    expect(g.guarantees.join(" ")).toMatch(/never.*sign/i);
    expect(g.hello_world).toHaveLength(3);
    expect(g.hello_world[0].tool).toBe("lookup_blockpage");
    expect(g.docs.mcp_url).toContain("/api/mcp");
  });

  it("exposes the Hedera Agent Kit wiring block", () => {
    const g = getStarted();
    expect(g.hedera_agent_kit.architecture).toMatch(/RETURN_BYTES/i);
    expect(g.hedera_agent_kit.sign_pattern).toMatch(/finalize_agent_self_claim/);
    expect(g.hedera_agent_kit.sign_pattern).toMatch(/operator key/);
    expect(g.hedera_agent_kit.key_type).toMatch(/ECDSA/);
  });
});

describe("quote_tip", () => {
  const TIP_IFACE = new ethers.Interface(["function tipPage(string username) payable"]);

  function accountFetch(accountExists: boolean, tokens: string[] = []) {
    return mockFetch([
      [/accounts\/0\.0\.123\/tokens/, () => ok({ tokens: tokens.map((t) => ({ token_id: t })) })],
      [/accounts\/0\.0\.123$/, () =>
        accountExists ? ok({ account: "0.0.123" }) : notFound],
    ]);
  }

  it("quotes exact 98/2 split for a valid HBAR tip", async () => {
    const q = await quoteTip(
      { recipient: "0.0.123", amount_hbar: "10" },
      accountFetch(true),
    );
    expect(q.can_settle).toBe(true);
    expect(q.blockers).toEqual([]);
    expect(q.gross_hbar).toBe("10");
    expect(q.creator_net_hbar).toBe("9.8");
    expect(q.treasury_fee_hbar).toBe("0.2");
    expect(q.prerequisites).toEqual({
      recipient_exists: true,
      token_associated: true, // HBAR needs no association
      amount_valid: true,
    });
  });

  it("blocks unknown recipients and bad amounts", async () => {
    const q1 = await quoteTip({ recipient: "0.0.123", amount_hbar: "0" }, accountFetch(true));
    expect(q1.can_settle).toBe(false);
    expect(q1.blockers.join(" ")).toMatch(/positive/);

    const q2 = await quoteTip({ recipient: "0.0.999", amount_hbar: "1" }, mockFetch([
      [/accounts\/0\.0\.999$/, () => notFound],
    ]));
    expect(q2.can_settle).toBe(false);
    expect(q2.blockers.join(" ")).toMatch(/not found/);
  });

  it("blocks unassociated token tips — the unsettleable case", async () => {
    const q = await quoteTip(
      { recipient: "0.0.123", amount_hbar: "5", asset: "0.0.456858" },
      accountFetch(true, []), // token NOT associated
    );
    expect(q.can_settle).toBe(false);
    expect(q.prerequisites.token_associated).toBe(false);
    expect(q.blockers.join(" ")).toMatch(/not associated/);

    const q2 = await quoteTip(
      { recipient: "0.0.123", amount_hbar: "5", asset: "0.0.456858" },
      accountFetch(true, ["0.0.456858"]),
    );
    expect(q2.can_settle).toBe(true);
  });

  it("resolves usernames via the registry", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc1230000000000000000000000000000000001$/, () => ok({ account: "0.0.777" })],
      [/accounts\/0\.0\.777$/, () => ok({ account: "0.0.777" })],
    ]);
    const q = await quoteTip({ recipient: "alice", amount_hbar: "2" }, fetchFn);
    expect(q.recipient_account).toBe("0.0.777");
    expect(q.can_settle).toBe(true);
  });
});

describe("trending_creators", () => {
  const TIP_IFACE = new ethers.Interface(["function tipPage(string username) payable"]);
  const tipParams = (u: string) => TIP_IFACE.encodeFunctionData("tipPage", [u]);

  function trendingFetch() {
    return mockFetch([
      [/contracts\/0\.0\.10854060\/results/, () =>
        ok({
          results: [
            { function_parameters: tipParams("alice"), amount: 200_000_000, consensus_timestamp: "1790000003.0", error_message: "" },
            { function_parameters: tipParams("bob"), amount: 500_000_000, consensus_timestamp: "1790000002.0", error_message: "" },
            { function_parameters: tipParams("alice"), amount: 100_000_000, consensus_timestamp: "1790000001.0", error_message: "" },
            { function_parameters: "0xdeadbeef", amount: 0, consensus_timestamp: "1790000000.0", error_message: "revert" },
          ],
          links: { next: null },
        })],
      [/contracts\/call/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0x/, () => ok({ account: "0.0.1" })],
    ]);
  }

  it("ranks by volume then recency", async () => {
    const r = await trendingCreators(10, "7d", trendingFetch());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.creators).toHaveLength(2);
    expect(r.creators[0].username).toBe("bob"); // 5 HBAR > 3 HBAR
    expect(r.creators[0].total_tips_hbar).toBe("5");
    expect(r.creators[1].username).toBe("alice");
    expect(r.creators[1].tip_count).toBe(2);
    expect(r.creators[1].total_tips_hbar).toBe("3");
    expect(r.window).toBe("7d");
  });

  it("rejects bad limits and windows fall back to 7d", async () => {
    expect(await trendingCreators(0, "7d", mockFetch([]))).toEqual({
      error: "limit must be an integer between 1 and 50",
    });
    const r = await trendingCreators(5, "bogus", trendingFetch());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.window).toBe("7d");
  });
});

describe("usernameValidationError", () => {
  it("diagnoses too-short names with a concrete alternative", () => {
    const msg = usernameValidationError("ab");
    expect(msg).toMatch(/too short/);
    expect(msg).toMatch(/ab-agent/);
    expect(msg).toMatch(/Do not retry "ab"/);
  });
  it("diagnoses too-long names", () => {
    const msg = usernameValidationError("a".repeat(40));
    expect(msg).toMatch(/too long/);
    expect(msg).toMatch(/Do not retry/);
  });
  it("diagnoses bad characters", () => {
    const msg = usernameValidationError("BAD NAME!");
    expect(msg).toMatch(/bad characters/);
    expect(msg).toMatch(/Do not retry/);
  });
  it("handles empty input", () => {
    expect(usernameValidationError("")).toMatch(/empty/);
    expect(usernameValidationError(undefined)).toMatch(/empty/);
  });
});

describe("usernameValidationIssue", () => {
  it("returns a machine-readable payload for too-short names", () => {
    const issue = usernameValidationIssue("ab");
    expect(issue.code).toBe("USERNAME_TOO_SHORT");
    expect(issue.retryable).toBe(false);
    expect(issue.suggestions).toEqual(["ab-agent", "my-ab-bot"]);
    expect(issue.message).toBe(usernameValidationError("ab"));
  });
  it("codes every failure mode with retryable false", () => {
    for (const [input, code] of [
      ["", "USERNAME_EMPTY"],
      ["a".repeat(40), "USERNAME_TOO_LONG"],
      ["BAD NAME!", "USERNAME_BAD_CHARACTERS"],
    ] as const) {
      const issue = usernameValidationIssue(input);
      expect(issue.code).toBe(code);
      expect(issue.retryable).toBe(false);
      expect(issue.suggestions.length).toBeGreaterThan(0);
      for (const s of issue.suggestions) {
        expect(s).toMatch(/^[a-z0-9_-]{3,32}$/);
      }
    }
  });
});

describe("toolError with opts", () => {
  it("serializes code, retryable and suggestions for machines", () => {
    const issue = usernameValidationIssue("ab");
    const res = toolError(issue.message, {
      code: issue.code,
      retryable: issue.retryable,
      suggestions: issue.suggestions,
    });
    expect(res.isError).toBe(true);
    const first = res.content[0];
    if (first.type !== "text") throw new Error("expected text content");
    const body = JSON.parse(first.text);
    expect(body.error).toBe(issue.message);
    expect(body.code).toBe("USERNAME_TOO_SHORT");
    expect(body.retryable).toBe(false);
    expect(body.suggestions).toEqual(["ab-agent", "my-ab-bot"]);
  });
  it("stays prose-only when no opts are given", () => {
    const res = toolError("something broke");
    const first = res.content[0];
    if (first.type !== "text") throw new Error("expected text content");
    const body = JSON.parse(first.text);
    expect(body).toEqual({ error: "something broke" });
  });
});
/* ------------------------- blockpage_earnings ------------------------- */

describe("blockpage_earnings", () => {
  const OWNER_EVM = "0xabc1230000000000000000000000000000000001";
  const OWNER_ACCT = "0.0.99999";

  function earningsFetch() {
    return mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: OWNER_ACCT })],
      [/accounts\/0\.0\.99999$/, () => ok({ account: OWNER_ACCT, evm_address: OWNER_EVM })],
      [
        /results\/logs/,
        () =>
          ok({
            logs: [
              {
                // TipSent paying the owner — should be counted.
                topics: [
                  TIPSENT_TOPIC,
                  addrTopic("0x1111111111111111111111111111111111111111"),
                  addrTopic("0x2222222222222222222222222222222222222222"),
                  addrTopic(OWNER_EVM),
                ],
                data: "0x" + pad32(100_000_000n) + pad32(2_000_000n),
                consensus_timestamp: "1790769255.000001045",
                transaction_hash:
                  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              },
              {
                // TipSent paying someone else — must be excluded.
                topics: [
                  TIPSENT_TOPIC,
                  addrTopic("0x1111111111111111111111111111111111111111"),
                  addrTopic("0x2222222222222222222222222222222222222222"),
                  addrTopic("0x9999999999999999999999999999999999999999"),
                ],
                data: "0x" + pad32(50_000_000n) + pad32(1_000_000n),
                consensus_timestamp: "1790769256.000001045",
                transaction_hash:
                  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
              {
                // Non-TipSent log — must be excluded.
                topics: [addrTopic("0x1111111111111111111111111111111111111111")],
                data: "0x" + pad32(1n),
                consensus_timestamp: "1790769257.000001045",
                transaction_hash:
                  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              },
            ],
          }),
      ],
    ]);
  }

  it("sums only TipSent events paying the page owner", async () => {
    const r = await blockpageEarnings("forge", 10, earningsFetch());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.username).toBe("forge");
    expect(r.owner_account).toBe(OWNER_ACCT);
    expect(r.tip_count).toBe(1);
    expect(r.total_gross_hbar).toBe("1");
    expect(r.total_creator_hbar).toBe("0.98");
    expect(r.total_treasury_hbar).toBe("0.02");
    expect(r.recent_tips).toHaveLength(1);
    expect(r.recent_tips[0].gross_hbar).toBe("1");
    expect(r.recent_tips[0].hashscan).toContain("hashscan.io");
  });

  it("rejects invalid usernames without hitting the network", async () => {
    const r = await blockpageEarnings("ab", 10, mockFetch([]));
    expect("error" in r).toBe(true);
  });

  it("errors honestly for unregistered pages", async () => {
    const fetchFn = mockFetch([[/contracts\/call$/, () => ok({ result: "0x" })]]);
    const r = await blockpageEarnings("no-such-user", 10, fetchFn);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/not registered/);
  });

  it("returns zeroed totals when no tips found", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: OWNER_ACCT })],
      [/accounts\/0\.0\.99999$/, () => ok({ account: OWNER_ACCT, evm_address: OWNER_EVM })],
      [/results\/logs/, () => ok({ logs: [] })],
    ]);
    const r = await blockpageEarnings("forge", 10, fetchFn);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.tip_count).toBe(0);
    expect(r.total_gross_hbar).toBe("0");
  });
});

/* ------------------------- read_agent_messages ------------------------- */

describe("read_agent_messages", () => {
  const OWNER_ACCT = "0.0.99999";
  const OUTBOUND_TOPIC = "0.0.77777";

  function inboxFetch() {
    return mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: OWNER_ACCT })],
      [
        /transactions\?account\.id=0\.0\.99999/,
        () =>
          ok({
            transactions: [
              { entity_id: OUTBOUND_TOPIC },
              { entity_id: "0.0.88888" },
            ],
          }),
      ],
      [/topics\/0\.0\.77777$/, () => ok({ topic_id: OUTBOUND_TOPIC, memo: "hcs-10:1:0:1" })],
      [/topics\/0\.0\.88888$/, () => ok({ topic_id: "0.0.88888", memo: "not an hcs-10 memo" })],
      [
        /topics\/0\.0\.77777\/messages/,
        () =>
          ok({
            messages: [
              {
                consensus_timestamp: "1790769255.000001045",
                sequence_number: 42,
                message: Buffer.from(
                  JSON.stringify({ p: "hcs-10", op: "message", data: "hello agents" }),
                ).toString("base64"),
              },
              {
                consensus_timestamp: "1790769256.000001045",
                sequence_number: 43,
                message: Buffer.from("plain text update").toString("base64"),
              },
            ],
          }),
      ],
    ]);
  }

  it("reads messages from the agent's HCS-10 outbound topic", async () => {
    const r = await readAgentMessages("forge", 10, inboxFetch());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.outbound_topic_id).toBe(OUTBOUND_TOPIC);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].hcs10_op).toBe("message");
    expect(r.messages[0].message_text).toContain("hello agents");
    expect(r.messages[1].hcs10_op).toBeNull();
    expect(r.messages[1].message_text).toBe("plain text update");
  });

  it("returns honest empty when no outbound topic exists", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: OWNER_ACCT })],
      [/transactions\?account\.id=/, () => ok({ transactions: [] })],
    ]);
    const r = await readAgentMessages("forge", 10, fetchFn);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.outbound_topic_id).toBeNull();
    expect(r.messages).toEqual([]);
    expect(r.note).toMatch(/no HCS-10 outbound topic/);
  });

  it("rejects invalid usernames", async () => {
    const r = await readAgentMessages("ab", 10, mockFetch([]));
    expect("error" in r).toBe(true);
  });
});

/* ------------------------- prepare_agent_message ------------------------- */

describe("prepare_agent_message", () => {
  const RECIP_ACCT = "0.0.99999";
  const SENDER_ACCT = "0.0.11111";
  const RECIP_INBOUND = "0.0.55555";
  const SENDER_INBOUND = "0.0.66666";

  function messageFetch() {
    return mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: RECIP_ACCT })],
      [
        /transactions\?account\.id=0\.0\.99999/,
        () => ok({ transactions: [{ entity_id: RECIP_INBOUND }] }),
      ],
      [
        /transactions\?account\.id=0\.0\.11111/,
        () => ok({ transactions: [{ entity_id: SENDER_INBOUND }] }),
      ],
      [/topics\/0\.0\.55555$/, () => ok({ topic_id: RECIP_INBOUND, memo: "hcs-10:1:0:0" })],
      [/topics\/0\.0\.66666$/, () => ok({ topic_id: SENDER_INBOUND, memo: "hcs-10:1:0:0" })],
    ]);
  }

  it("builds an unsigned HCS-10 connection_request payload", async () => {
    // Sender "sender-agent" resolves via a second contracts/call; override
    // the generic mock by matching sender lookups first is complex, so we
    // pass the sender as a raw account id here.
    const r = await prepareAgentMessage("forge", SENDER_ACCT, "hello from a fellow agent", messageFetch());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.recipient_username).toBe("forge");
    expect(r.recipient_inbound_topic).toBe(RECIP_INBOUND);
    expect(r.sender_account).toBe(SENDER_ACCT);
    expect(r.sender_inbound_topic).toBe(SENDER_INBOUND);
    expect(r.submit_to_topic).toBe(RECIP_INBOUND);
    expect(r.hcs10_payload.p).toBe("hcs-10");
    expect(r.hcs10_payload.op).toBe("connection_request");
    expect(r.hcs10_payload.operator_id).toBe(`${SENDER_INBOUND}@${SENDER_ACCT}`);
    expect(r.hcs10_payload.data).toBe("hello from a fellow agent");
    expect(r.instructions).toMatch(/UNSIGNED/);
  });

  it("refuses empty messages", async () => {
    const r = await prepareAgentMessage("forge", SENDER_ACCT, "   ", mockFetch([]));
    expect("error" in r).toBe(true);
  });

  it("errors honestly when the recipient has no inbound topic", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: RECIP_ACCT })],
      [/transactions\?account\.id=/, () => ok({ transactions: [] })],
    ]);
    const r = await prepareAgentMessage("forge", SENDER_ACCT, "hi", fetchFn);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/no HCS-10 inbound topic/);
  });

  it("refuses self-messages", async () => {
    const fetchFn = mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [/accounts\/0xabc123/, () => ok({ account: RECIP_ACCT })],
    ]);
    const r = await prepareAgentMessage("forge", RECIP_ACCT, "hi", fetchFn);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/same account/);
  });
});

/* ------------------------- list_tip_assets ------------------------- */

describe("list_tip_assets", () => {
  it("lists HBAR as the tip rail with live price", async () => {
    const fetchFn = mockFetch([
      [
        /network\/exchangerate/,
        () => ok({ current_rate: { cent_equivalent: 240000, hbar_equivalent: 30000 } }),
      ],
    ]);
    const r = await listTipAssets(fetchFn);
    expect(r.assets).toHaveLength(2);
    expect(r.assets[0].asset).toBe("HBAR");
    expect(r.assets[0].split).toMatch(/98%/);
    expect(r.assets[1].asset).toBe("USDC");
    expect(r.assets[1].rail).toMatch(/NOT for tips/);
    expect(r.hbar_usd).toBe("0.080000");
  });

  it("stays fail-soft when the price feed is down", async () => {
    const fetchFn = mockFetch([[/network\/exchangerate/, () => notFound]]);
    const r = await listTipAssets(fetchFn);
    expect(r.hbar_usd).toBeNull();
    expect(r.assets).toHaveLength(2);
  });
});

/* ------------------------- propose_page_update ------------------------- */

describe("propose_page_update tool", () => {
  const OWNER = "0.0.10425049";

  beforeEach(async () => {
    await resetKvStoreSingleton();
  });

  async function issueToken(scopes?: ("page:update:propose" | "page:read" | "media:pin")[]) {
    const { issueCapabilityToken } = await import("./capability-tokens");
    const { token } = await issueCapabilityToken(OWNER, { label: "test", scopes });
    return token;
  }

  function pageFetch(ownerAccount: string | null = OWNER) {
    return mockFetch([
      [/contracts\/call$/, () => ok({ result: resolvePageResult() })],
      [
        /accounts\/0xabc123/,
        () => ok(ownerAccount ? { account: ownerAccount } : null),
      ],
    ]);
  }

  const BASE_ARGS = {
    username: "forge",
    change_summary: "Updated the bio text",
    display_name: "Forge",
    purpose: "test agent",
  };

  it("fails closed on a bad capability token", async () => {
    const res = await proposePageUpdate(
      { ...BASE_ARGS, capability_token: "vs_cap_" + "0".repeat(48) },
      pageFetch(),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/capability token/i);
  });

  it("rejects when the token's human does not own the page", async () => {
    const token = await issueToken();
    const res = await proposePageUpdate(
      { ...BASE_ARGS, capability_token: token },
      pageFetch("0.0.99999999"),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/only work on pages your human owns/i);
  });

  it("rejects an unregistered username", async () => {
    const token = await issueToken();
    const fetchFn = mockFetch([[/contracts\/call$/, () => ok({ result: "0x" })]]);
    const res = await proposePageUpdate({ ...BASE_ARGS, capability_token: token }, fetchFn);
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/not a registered blockpage/i);
  });

  it("enforces the scope: a read-only token cannot propose", async () => {
    const token = await issueToken(["page:read"]);
    const res = await proposePageUpdate({ ...BASE_ARGS, capability_token: token }, pageFetch());
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/capability token/i);
  });

  function withAuthToken<T>(token: string | null, fn: () => Promise<T>): Promise<T> {
    return requestContextStorage.run(
      {
        origin: "https://voicescape.vercel.app",
        clientIp: "test",
        requestId: null,
        authToken: token,
      },
      fn,
    );
  }

  it("authenticates via the Authorization header when the argument is omitted", async () => {
    const token = await issueToken();
    const res = await withAuthToken(token, () => proposePageUpdate({ ...BASE_ARGS }, pageFetch()));
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect((res as { status: string }).status).toBe("awaiting_human_approval");
    expect((res as { owner_account_id: string }).owner_account_id).toBe(OWNER);
  });

  it("fails closed with neither argument nor header token", async () => {
    const res = await withAuthToken(null, () => proposePageUpdate({ ...BASE_ARGS }, pageFetch()));
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/capability token/i);
  });

  it("rejects an invalid header token", async () => {
    const res = await withAuthToken("vs_cap_" + "0".repeat(48), () =>
      proposePageUpdate({ ...BASE_ARGS }, pageFetch()),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/capability token/i);
  });

  it("explicit argument wins over the header token", async () => {
    const token = await issueToken();
    const res = await withAuthToken("vs_cap_" + "0".repeat(48), () =>
      proposePageUpdate({ ...BASE_ARGS, capability_token: token }, pageFetch()),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect((res as { status: string }).status).toBe("awaiting_human_approval");
  });

  it("enforces scope on the header token too", async () => {
    const token = await issueToken(["page:read"]);
    const res = await withAuthToken(token, () => proposePageUpdate({ ...BASE_ARGS }, pageFetch()));
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/capability token/i);
  });

  it("stashes the proposal and returns awaiting_human_approval", async () => {
    const token = await issueToken();
    const res = await proposePageUpdate({ ...BASE_ARGS, capability_token: token }, pageFetch());
    expect("error" in res).toBe(false);
    const okRes = res as unknown as {
      proposal_id: string;
      status: string;
      owner_account_id: string;
      expires_in: string;
      approval_url: string;
      next: string;
    };
    expect(okRes.proposal_id).toMatch(/^[0-9a-f]{16}$/);
    expect(okRes.status).toBe("awaiting_human_approval");
    expect(okRes.owner_account_id).toBe(OWNER);
    expect(okRes.expires_in).toBe("24h");
    expect(okRes.approval_url).toMatch(new RegExp(`/p/${okRes.proposal_id}$`));
    expect(okRes.next).toMatch(/approval link/i);
  });

  describe("request_capability_token tool", () => {
    it("returns an issuance URL for a valid label", async () => {
      const { requestCapabilityToken } = await import("./mcp-tools");
      const res = await requestCapabilityToken({ label: "muse AI agent" });
      expect("error" in res).toBe(false);
      const ok = res as unknown as {
        request_id: string;
        label: string;
        scopes: string[];
        issuance_url: string;
        expires_in: string;
        next: string;
      };
      expect(ok.request_id).toMatch(/^[0-9a-f]{32}$/);
      expect(ok.label).toBe("muse AI agent");
      expect(ok.scopes).toEqual(["page:update:propose", "page:read", "media:pin"]);
      expect(ok.issuance_url).toMatch(new RegExp(`/t/${ok.request_id}$`));
      expect(ok.expires_in).toBe("24h");
      expect(ok.next).toMatch(/issuance link/i);
    });

    it("rejects a missing label and bad scopes", async () => {
      const { requestCapabilityToken } = await import("./mcp-tools");
      const noLabel = await requestCapabilityToken({ label: "   " });
      expect("error" in noLabel).toBe(true);
      const badScopes = await requestCapabilityToken({ label: "x", scopes: ["admin:everything"] });
      expect("error" in badScopes).toBe(true);
      expect((badScopes as { error: string }).error).toMatch(/scopes/i);
    });

    it("honors a requested scope subset", async () => {
      const { requestCapabilityToken } = await import("./mcp-tools");
      const res = await requestCapabilityToken({ label: "x", scopes: ["page:update:propose"] });
      expect("error" in res).toBe(false);
      expect((res as unknown as { scopes: string[] }).scopes).toEqual(["page:update:propose"]);
    });

    it("the issued pass validates for the paired account with requested scopes", async () => {
      const { requestCapabilityToken } = await import("./mcp-tools");
      const { consumeTokenRequest } = await import("./token-requests");
      const { issueCapabilityToken, validateCapabilityToken } = await import("./capability-tokens");
      const req = await requestCapabilityToken({ label: "tester", scopes: ["page:update:propose"] });
      expect("error" in req).toBe(false);
      const requestId = (req as unknown as { request_id: string }).request_id;
      // Simulate the human opening /t/<id> and pairing 0.0.99999.
      const consumed = await consumeTokenRequest(requestId);
      expect(consumed).not.toBeNull();
      const { token } = await issueCapabilityToken("0.0.99999", {
        label: consumed!.label,
        scopes: consumed!.scopes,
      });
      const validated = await validateCapabilityToken(token, "page:update:propose");
      expect(validated).not.toBeNull();
      expect(validated!.record.ownerAccountId).toBe("0.0.99999");
      // One-time link: already consumed.
      expect(await consumeTokenRequest(requestId)).toBeNull();
    });
  });

  it("requires a change summary and content fields", async () => {
    const token = await issueToken();
    const noSummary = await proposePageUpdate(
      { ...BASE_ARGS, change_summary: "  ", capability_token: token },
      pageFetch(),
    );
    expect("error" in noSummary).toBe(true);
    const noName = await proposePageUpdate(
      { ...BASE_ARGS, display_name: "", capability_token: token },
      pageFetch(),
    );
    expect("error" in noName).toBe(true);
  });

  it("rejects non-https URLs like the claim path", async () => {
    const token = await issueToken();
    const res = await proposePageUpdate(
      {
        ...BASE_ARGS,
        capability_token: token,
        links: [{ label: "evil", url: "javascript:alert(1)" }],
      },
      pageFetch(),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/https:\/\//);
  });
});

/* ------------------------- verify_purchase / my_purchases ------------------------- */

vi.mock("./townhall/badges", () => ({
  verifyPurchase: async (wallet: string, listingRef: string) =>
    wallet === "0.0.1" && listingRef === "sticker-pack",
  walletPurchases: async (_hcs: unknown, wallet: string) =>
    wallet === "0.0.1"
      ? [
          {
            listingRef: "sticker-pack",
            title: "Sticker Pack",
            tx: "0.0.1@1700000000.000000000",
            timestamp: "1700000000.000000000",
          },
        ]
      : [],
}));

vi.mock("./townhall/hcs", () => ({
  defaultHcsPort: () => ({}),
}));

describe("verify_purchase", () => {
  it("verifies a real on-chain purchase with its receipt", async () => {
    const { verifyPurchaseTool } = await import("./mcp-tools");
    const res = (await verifyPurchaseTool("0.0.1", "sticker-pack")) as {
      verified: boolean;
      listing_title: string;
      transaction_id: string;
    };
    expect(res.verified).toBe(true);
    expect(res.listing_title).toBe("Sticker Pack");
    expect(res.transaction_id).toBe("0.0.1@1700000000.000000000");
  });

  it("reports unverified when no purchase exists", async () => {
    const { verifyPurchaseTool } = await import("./mcp-tools");
    const res = (await verifyPurchaseTool("0.0.2", "sticker-pack")) as { verified: boolean };
    expect(res.verified).toBe(false);
  });

  it("requires wallet and listingRef", async () => {
    const { verifyPurchaseTool } = await import("./mcp-tools");
    expect("error" in (await verifyPurchaseTool("", "x"))).toBe(true);
    expect("error" in (await verifyPurchaseTool("0.0.1", ""))).toBe(true);
  });
});

describe("my_purchases", () => {
  it("lists verified purchases for the wallet", async () => {
    const { myPurchasesTool } = await import("./mcp-tools");
    const res = (await myPurchasesTool("0.0.1")) as {
      wallet: string;
      purchases: { listing_ref: string }[];
    };
    expect(res.wallet).toBe("0.0.1");
    expect(res.purchases).toHaveLength(1);
    expect(res.purchases[0].listing_ref).toBe("sticker-pack");
  });

  it("returns an empty list for a wallet with no purchases", async () => {
    const { myPurchasesTool } = await import("./mcp-tools");
    const res = (await myPurchasesTool("0.0.9")) as { purchases: unknown[] };
    expect(res.purchases).toEqual([]);
  });

  it("requires a wallet", async () => {
    const { myPurchasesTool } = await import("./mcp-tools");
    expect("error" in (await myPurchasesTool(""))).toBe(true);
  });
});
