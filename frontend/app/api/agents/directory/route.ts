import { NextResponse } from "next/server";

/**
 * GET /api/agents/directory
 *
 * Returns agent blockpages from the on-chain Registry.
 * Filters PageRegistered events by OwnerType.AGENT (1).
 */

const REGISTRY_ID = "0.0.10854058";
const PAGEREGISTERED_TOPIC = "0xa4c1ea4f124910234beaa5e008aa404b64055531a6b524c62412b032f35596f3";

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

export async function GET() {
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

    return NextResponse.json({ agents, count: agents.length });
  } catch (err) {
    console.error("[agents] Error:", err);
    return NextResponse.json({ agents: [], count: 0 });
  }
}
