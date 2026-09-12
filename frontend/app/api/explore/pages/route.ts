import { NextResponse } from "next/server";

/**
 * GET /api/explore/pages
 *
 * Returns real discoverable blockpages from the on-chain Registry.
 * Queries Hedera Mirror Node for PageRegistered events, newest first.
 * Falls back to featured pages if the Mirror Node is unavailable.
 */

const REGISTRY_ID = "0.0.10854058";
// PageRegistered(string,address,string,uint8,address,string) — also covers PageUpdated
const PAGEREGISTERED_TOPIC = "0xa4c1ea4f124910234beaa5e008aa404b64055531a6b524c62412b032f35596f3";

const FEATURED_PAGES = [
  {
    username: "user-10424063",
    displayName: "Voicescape Founder",
    description: "Founder's blockpage — the first on Voicescape.",
    featured: true,
  },
];

/** Decode the first string arg (username) from registerPage call data. */
function decodeUsername(functionParameters: string): string | null {
  try {
    const hex = functionParameters.startsWith("0x")
      ? functionParameters.slice(2)
      : functionParameters;
    if (hex.length < 8 + 64) return null;
    // Skip 4-byte selector, read offset of first string (32 bytes)
    const offset = parseInt(hex.slice(8, 8 + 64), 16);
    const strStart = 8 + offset * 2;
    const len = parseInt(hex.slice(strStart, strStart + 64), 16);
    if (len <= 0 || len > 64) return null;
    const strHex = hex.slice(strStart + 64, strStart + 64 + len * 2);
    const username = Buffer.from(strHex, "hex").toString("utf8");
    // Validate: 3-32 chars of a-z 0-9 _ -
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) return null;
    return username;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    // Get recent PageRegistered logs
    const logsUrl =
      `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${REGISTRY_ID}/results/logs` +
      `?order=desc&limit=20`;

    const logsRes = await fetch(logsUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 }, // Cache 5 minutes
    });

    if (!logsRes.ok) throw new Error("Mirror Node unavailable");

    const logsData = await logsRes.json();
    const logs = (logsData.logs || []).filter(
      (l: any) => l.topics?.[0]?.toLowerCase() === PAGEREGISTERED_TOPIC
    );

    const seen = new Set<string>();
    const pages: any[] = [];

    for (const log of logs.slice(0, 10)) {
      try {
        // Get transaction ID from timestamp
        const txRes = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/transactions?timestamp=${log.timestamp}`,
          { headers: { Accept: "application/json" } }
        );
        if (!txRes.ok) continue;
        const txData = await txRes.json();
        const txId = txData.transactions?.[0]?.transaction_id;
        if (!txId) continue;

        // Get function parameters to decode username
        const resultRes = await fetch(
          `https://mainnet.mirrornode.hedera.com/api/v1/contracts/results/${txId}`,
          { headers: { Accept: "application/json" } }
        );
        if (!resultRes.ok) continue;
        const resultData = await resultRes.json();
        const username = decodeUsername(resultData.function_parameters || "");
        if (!username || seen.has(username)) continue;
        seen.add(username);

        // Owner from topic2
        const owner = log.topics[2] ? "0x" + log.topics[2].slice(-40) : null;

        pages.push({
          username,
          displayName: username,
          description: owner ? `Owner: ${owner.slice(0, 6)}…${owner.slice(-4)}` : "",
          featured: false,
        });

        if (pages.length >= 12) break;
      } catch {
        continue;
      }
    }

    // Always include featured pages first, then real ones (dedupe)
    const featuredUsernames = new Set(FEATURED_PAGES.map((p) => p.username));
    const realPages = pages.filter((p) => !featuredUsernames.has(p.username));

    return NextResponse.json({
      pages: [...FEATURED_PAGES, ...realPages],
      count: FEATURED_PAGES.length + realPages.length,
    });
  } catch (err) {
    console.error("[explore] Error fetching pages:", err);
    // Fallback to featured pages
    return NextResponse.json({
      pages: FEATURED_PAGES,
      count: FEATURED_PAGES.length,
    });
  }
}
