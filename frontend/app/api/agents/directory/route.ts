import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { PAGEREGISTERED_TOPIC } from "@/lib/registry-topics";

/**
 * GET /api/agents/directory
 *
 * Returns agent blockpages from the on-chain Registry.
 * Filters PageRegistered events by OwnerType.AGENT (1).
 *
 * Guardrails: per-IP rate limit (60/hr) plus a 15-minute server-side
 * result cache. Without these, a polling loop turns one request into a
 * serial mirror-node fan-out that can blow the Vercel function's time
 * budget for every caller. Directory data changes slowly (on-chain
 * registrations), so a 15-minute stale window is fine.
 */

const REGISTRY_ID = "0.0.10854058";
// NOTE: the topic hash lives in lib/registry-topics.ts (single source of
// truth, verified against the canonical event signature). A hardcoded copy
// here once pointed at the PageUpdated topic instead, which silently
// emptied the directory — do not reintroduce a local constant.

/** Server-side cache of the computed directory; best-effort, fail-open. */
const DIRECTORY_CACHE_KEY = "agents:directory:v1";
const DIRECTORY_CACHE_TTL_MS = 15 * 60_000;

/** Decode username from registerPage call data. */
function decodeUsername(functionParameters: string): string | null {
  try {
    const hex = functionParameters.startsWith("0x")
      ? functionParameters.slice(2)
      : functionParameters;
    if (hex.length < 8 + 64) return null;
    const offset = parseInt(hex.slice(8, 8 + 64), 16);
    const strStart = 8 + offset * 2;
    const len = parseInt(hex.slice(strStart, strStart + 64), 16);
    if (len <= 0 || len > 64) return null;
    const strHex = hex.slice(strStart + 64, strStart + 64 + len * 2);
    const username = Buffer.from(strHex, "hex").toString("utf8");
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) return null;
    return username;
  } catch {
    return null;
  }
}

/** Decode ownerType (2nd word) from log data. 0=HUMAN, 1=AGENT */
function decodeOwnerType(data: string): number | null {
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length < 128) return null;
    return parseInt(hex.slice(64, 128), 16);
  } catch {
    return null;
  }
}

/** Decode purpose string (4th param) from log data for search. */
function decodePurpose(data: string): string {
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length < 256) return "";
    const purposeOffset = parseInt(hex.slice(192, 256), 16);
    const strStart = purposeOffset * 2;
    const len = parseInt(hex.slice(strStart, strStart + 64), 16);
    if (len <= 0 || len > 200) return "";
    const strHex = hex.slice(strStart + 64, strStart + 64 + len * 2);
    return Buffer.from(strHex, "hex").toString("utf8").slice(0, 200);
  } catch {
    return "";
  }
}

export async function GET(req: NextRequest) {
  // Per-IP gate: one polling agent must not turn this endpoint into an
  // unauthenticated mirror-node amplification vector.
  const gated = await ipGate(
    req,
    "agents-directory",
    "IP_RATE_LIMIT_AGENTS_DIRECTORY",
    60,
    "too many directory requests from this network — try again later",
  );
  if (gated) return gated;

  // Serve from the shared cache when fresh; a directory miss is the only
  // path that fans out to the mirror node. Fail-open: a broken cache
  // must not take the directory offline.
  try {
    const cached = await getKvStore().get(DIRECTORY_CACHE_KEY);
    if (cached) {
      return NextResponse.json(JSON.parse(cached));
    }
  } catch {
    /* fall through to a live fetch */
  }

  try {
    const logsUrl =
      `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${REGISTRY_ID}/results/logs` +
      `?order=desc&limit=50`;

    const logsRes = await fetch(logsUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (!logsRes.ok) throw new Error("Mirror Node unavailable");

    const logsData = await logsRes.json();
    const logs = (logsData.logs || []).filter(
      (l: any) => l.topics?.[0]?.toLowerCase() === PAGEREGISTERED_TOPIC
    );

    const seen = new Set<string>();
    const agents: any[] = [];

    for (const log of logs.slice(0, 30)) {
      try {
        // Filter by OwnerType.AGENT
        const ownerType = decodeOwnerType(log.data || "");
        if (ownerType !== 1) continue;

        const txRes = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/transactions?timestamp=${log.timestamp}`,
          { headers: { Accept: "application/json" } }
        );
        if (!txRes.ok) continue;
        const txData = await txRes.json();
        const txId = txData.transactions?.[0]?.transaction_id;
        if (!txId) continue;

        const resultRes = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/contracts/results/${txId}`,
          { headers: { Accept: "application/json" } }
        );
        if (!resultRes.ok) continue;
        const resultData = await resultRes.json();
        const username = decodeUsername(resultData.function_parameters || "");
        if (!username || seen.has(username)) continue;
        seen.add(username);

        const purpose = decodePurpose(log.data || "");
        const owner = log.topics[2] ? "0x" + log.topics[2].slice(-40) : null;

        agents.push({
          username,
          purpose,
          owner,
        });

        if (agents.length >= 20) break;
      } catch {
        continue;
      }
    }

    const result = { agents, count: agents.length };

    // Best-effort cache write — directory freshness is bounded by the TTL.
    try {
      await getKvStore().set(DIRECTORY_CACHE_KEY, JSON.stringify(result), DIRECTORY_CACHE_TTL_MS);
    } catch {
      /* a missed cache write is not an error */
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[agents] Error:", err);
    return NextResponse.json({ agents: [], count: 0 });
  }
}
