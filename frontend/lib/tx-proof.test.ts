/**
 * tx-proof tests: the split explorer's data layer against mocked mirror-node
 * responses. No network in this file — fetch is injected.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildTipProofUrl,
  buildTipShareIntentUrl,
  computeSplitFromGross,
  fetchTipProof,
  fillTipShareText,
  normalizeTxId,
  shortAddress,
  tinybarToHbar,
  TIPS_CONTRACT_ID,
} from "./tx-proof";
import { TIPSENT_TOPIC } from "./leaderboard";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SDK_ID = "0.0.10424063-1789255464-614991104";
const EVM_HASH =
  "0x3e26249f497850248cfcbbd91841851d992216cec982b59fae1b14008e94a9a5";

// Real-shaped TipSent log: gross 134,111,178 tinybar, fee 2,682,223
// (exactly gross * 200 / 10000), from/to as topic-padded addresses.
const FROM = "0x30c63dc43608b6764a6b8b53960553aebf306817";
const TO = "0xfc1177680ecf347f06cf3c086fa58ca2713fb462";
const TIP_LOG = {
  timestamp: "1789255464.614991104",
  topics: [
    TIPSENT_TOPIC,
    "0xc312b7d4c1a07ec67596cdab638b0b421634631c0cc6d4fd3cc50cf77a169a59",
    "0x000000000000000000000000" + FROM.slice(2),
    "0x000000000000000000000000" + TO.slice(2),
  ],
  data:
    "0x" +
    "0000000000000000000000000000000000000000000000000000000007fe5fca" +
    "000000000000000000000000000000000000000000000000000000000028ed6f",
};

function txEndpointBody(overrides: Record<string, unknown> = {}) {
  return {
    transactions: [
      {
        transaction_id: SDK_ID,
        consensus_timestamp: "1789255464.614991104",
        entity_id: TIPS_CONTRACT_ID,
        result: "SUCCESS",
        ...overrides,
      },
    ],
  };
}

function contractResultBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "0x1",
    contract_id: TIPS_CONTRACT_ID,
    logs: [TIP_LOG],
    ...overrides,
  };
}

interface RouteMap {
  [urlPart: string]: { status: number; body: unknown };
}

/** Build a fetch mock that serves canned responses per URL substring. */
function mockFetch(routes: RouteMap) {
  return vi.fn(async (url: string) => {
    for (const [part, route] of Object.entries(routes)) {
      if (url.includes(part)) {
        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          json: async () => route.body,
        } as Response;
      }
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
}

const happyRoutes: RouteMap = {
  "/transactions/": { status: 200, body: txEndpointBody() },
  "/contracts/results/": { status: 200, body: contractResultBody() },
};

/* ------------------------------------------------------------------ */
/* normalizeTxId                                                       */
/* ------------------------------------------------------------------ */

describe("normalizeTxId", () => {
  it("accepts @-form SDK ids and normalizes to dash form", () => {
    const r = normalizeTxId("0.0.10424063@1789255464.614991104");
    expect(r).toEqual({ ok: true, txId: SDK_ID, kind: "sdk" });
  });

  it("accepts dash-form SDK ids as-is", () => {
    expect(normalizeTxId(SDK_ID)).toEqual({ ok: true, txId: SDK_ID, kind: "sdk" });
  });

  it("accepts EVM hashes (lowercased)", () => {
    const r = normalizeTxId("0x" + EVM_HASH.slice(2).toUpperCase());
    expect(r).toEqual({ ok: true, txId: EVM_HASH, kind: "evm" });
  });

  it.each([
    "garbage",
    "0.0.1234",
    "0x1234",
    "0.0.abc@123.456",
    "1.2.3@4.5", // wrong shard.realm
    "0.0.1234@123456789012345.1", // seconds too long
    "",
  ])("rejects malformed ids: %s", (raw) => {
    expect(normalizeTxId(raw)).toEqual({ ok: false });
  });
});

/* ------------------------------------------------------------------ */
/* tinybarToHbar / computeSplitFromGross                                */
/* ------------------------------------------------------------------ */

describe("tinybarToHbar", () => {
  it("formats exact decimals without float rounding", () => {
    expect(tinybarToHbar(134_111_178n)).toBe("1.34111178");
    expect(tinybarToHbar(2_682_223n)).toBe("0.02682223");
    expect(tinybarToHbar(100_000_000n)).toBe("1");
    expect(tinybarToHbar(1n)).toBe("0.00000001");
    expect(tinybarToHbar(0n)).toBe("0");
  });
});

describe("computeSplitFromGross", () => {
  it("splits 98/2 exactly in tinybar on fixture amounts", () => {
    const gross = 134_111_178n;
    const { creator, fee } = computeSplitFromGross(gross);
    expect(fee).toBe(2_682_223n); // == gross * 200 / 10000
    expect(creator).toBe(gross - fee);
    expect(creator + fee).toBe(gross);
  });

  it("handles tiny gross amounts without losing a tinybar", () => {
    const { creator, fee } = computeSplitFromGross(100n);
    expect(creator + fee).toBe(100n);
    expect(fee).toBe(2n);
  });
});

/* ------------------------------------------------------------------ */
/* fetchTipProof                                                        */
/* ------------------------------------------------------------------ */

describe("fetchTipProof", () => {
  it("decodes a valid tip tx: exact 98/2 split from the gross amount", async () => {
    const r = await fetchTipProof(SDK_ID, mockFetch(happyRoutes) as typeof fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.proof;
    expect(p.sender).toBe(FROM);
    expect(p.recipient).toBe(TO);
    expect(p.grossTinybar).toBe(134_111_178n);
    expect(p.feeTinybar).toBe(2_682_223n);
    expect(p.creatorTinybar).toBe(134_111_178n - 2_682_223n);
    expect(p.creatorTinybar + p.feeTinybar).toBe(p.grossTinybar);
    expect(p.splitExact).toBe(true);
    expect(tinybarToHbar(p.creatorTinybar)).toBe("1.31428955");
    expect(tinybarToHbar(p.feeTinybar)).toBe("0.02682223");
    expect(p.consensusTimestamp).toBe("1789255464.614991104");
  });

  it("works for EVM-hash inputs via the contract-results endpoint alone", async () => {
    const f = mockFetch({
      "/contracts/results/": { status: 200, body: contractResultBody() },
    });
    const r = await fetchTipProof(EVM_HASH, f as typeof fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proof.grossTinybar).toBe(134_111_178n);
    expect(f).not.toHaveBeenCalledWith(
      expect.stringContaining("/transactions/"),
      expect.anything(),
    );
  });

  it("rejects malformed ids without touching the network", async () => {
    const f = mockFetch(happyRoutes);
    const r = await fetchTipProof("not-a-tx-id", f as typeof fetch);
    expect(r).toEqual({ ok: false, error: "malformed" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports not-found on mirror 404", async () => {
    const f = mockFetch({
      "/transactions/": { status: 404, body: { _status: {} } },
    });
    const r = await fetchTipProof(SDK_ID, f as typeof fetch);
    expect(r).toEqual({ ok: false, error: "not-found" });
  });

  it("reports network on mirror 500 / fetch throw", async () => {
    const r500 = await fetchTipProof(
      SDK_ID,
      mockFetch({ "/transactions/": { status: 500, body: {} } }) as typeof fetch,
    );
    expect(r500).toEqual({ ok: false, error: "network" });

    const rThrow = await fetchTipProof(
      SDK_ID,
      (async () => {
        throw new Error("down");
      }) as typeof fetch,
    );
    expect(rThrow).toEqual({ ok: false, error: "network" });
  });

  it("says not-a-tip when the tx called a different contract", async () => {
    const r = await fetchTipProof(
      SDK_ID,
      mockFetch({
        "/transactions/": {
          status: 200,
          body: txEndpointBody({ entity_id: "0.0.10854058" }),
        },
        "/contracts/results/": { status: 200, body: contractResultBody() },
      }) as typeof fetch,
    );
    expect(r).toEqual({ ok: false, error: "not-a-tip" });
  });

  it("says not-a-tip for a Tips-contract call with no TipSent log (e.g. a purchase)", async () => {
    const purchaseLog = {
      ...TIP_LOG,
      topics: [
        "0x8555727c6813e10ae0b5a9b0a53a88a93176679845f5a005a248cdb9f1c05f2e",
      ],
    };
    const r = await fetchTipProof(
      SDK_ID,
      mockFetch({
        "/transactions/": { status: 200, body: txEndpointBody() },
        "/contracts/results/": {
          status: 200,
          body: contractResultBody({ logs: [purchaseLog] }),
        },
      }) as typeof fetch,
    );
    expect(r).toEqual({ ok: false, error: "not-a-tip" });
  });

  it("reports reverted when the tx failed on-chain", async () => {
    const r = await fetchTipProof(
      SDK_ID,
      mockFetch({
        "/transactions/": {
          status: 200,
          body: txEndpointBody({ result: "CONTRACT_REVERT_EXECUTED" }),
        },
      }) as typeof fetch,
    );
    expect(r).toEqual({ ok: false, error: "reverted" });
  });

  it("reports decode when the event data is unreadable", async () => {
    const r = await fetchTipProof(
      SDK_ID,
      mockFetch({
        "/transactions/": { status: 200, body: txEndpointBody() },
        "/contracts/results/": {
          status: 200,
          body: contractResultBody({ logs: [{ ...TIP_LOG, data: "0xdead" }] }),
        },
      }) as typeof fetch,
    );
    expect(r).toEqual({ ok: false, error: "decode" });
  });
});

/* ------------------------------------------------------------------ */
/* share builders                                                      */
/* ------------------------------------------------------------------ */

describe("share builders", () => {
  it("builds the proof URL", () => {
    expect(buildTipProofUrl("https://voicescape.vercel.app/", SDK_ID)).toBe(
      `https://voicescape.vercel.app/tx/${encodeURIComponent(SDK_ID)}`,
    );
  });

  it("fills the localized share template", () => {
    const text = fillTipShareText(
      "I tipped {hbar} HBAR to @{username} on Voicescape — 98% went straight to the creator, verifiable on-chain: {url}",
      "1.3143",
      "alice",
      "https://voicescape.vercel.app/tx/abc",
    );
    expect(text).toBe(
      "I tipped 1.3143 HBAR to @alice on Voicescape — 98% went straight to the creator, verifiable on-chain: https://voicescape.vercel.app/tx/abc",
    );
  });

  it("encodes the X share intent URL correctly", () => {
    const url = buildTipShareIntentUrl(
      "I tipped 1.3143 HBAR to @alice — see: https://voicescape.vercel.app/tx/abc?x=1&y=2",
    );
    expect(url.startsWith("https://x.com/intent/tweet?text=")).toBe(true);
    expect(decodeURIComponent(url.split("text=")[1])).toContain(
      "https://voicescape.vercel.app/tx/abc?x=1&y=2",
    );
    // No raw reserved characters leak unencoded into the query string.
    expect(url.split("text=")[1]).not.toContain(" ");
    expect(url.split("text=")[1]).not.toContain("&y=");
  });
});

describe("shortAddress", () => {
  it("shortens EVM addresses", () => {
    expect(shortAddress(FROM)).toBe("0x30c6…6817");
  });
  it("passes through non-addresses", () => {
    expect(shortAddress("alice")).toBe("alice");
  });
});
