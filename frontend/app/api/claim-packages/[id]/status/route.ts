/**
 * GET /api/claim-packages/[id]/status — agent-pollable package status.
 *
 * Lets the AGENT learn what happened to its claim package without the
 * human relaying it: pending → finalized → completed, or race_lost /
 * expired. A 404 here means the id never existed; a well-formed id with
 * no status record and no live package means it expired silently after
 * the 24h TTL (reported as expired so the agent stops guessing).
 *
 * Self-healing: a "finalized" record means the unsigned tx was issued and
 * we're waiting on the human's signature. If the page is now registered
 * on-chain (the human signed but the completion signal never arrived —
 * closed tab, failed request), this endpoint upgrades the record to
 * "completed" on read so the agent learns the truth instead of waiting
 * forever. Best-effort: a failed chain read returns the recorded status.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getClaimPackage } from "@/lib/server/claim-packages";
import { getPackageStatus, setPackageStatus } from "@/lib/server/package-status";
import { lookupBlockpage } from "@/lib/server/mcp-tools";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const recorded = await getPackageStatus("claim", id);
  if (recorded) {
    // Self-heal: "finalized" waits on the human's signature. If the page
    // is on-chain now, the human signed and the completion signal was
    // lost — upgrade to "completed" so the agent stops waiting.
    if (recorded.status === "finalized" && recorded.username) {
      try {
        const lookup = await lookupBlockpage(recorded.username);
        if (lookup.found) {
          const appOrigin = (process.env.APP_ORIGIN ?? "https://voicescape.vercel.app").replace(
            /\/$/,
            "",
          );
          await setPackageStatus("claim", id, "completed", {
            username: recorded.username,
            transactionId: recorded.transactionId,
            detail: `registered on-chain — live at ${appOrigin}/${recorded.username}`,
          });
          return NextResponse.json({
            package_id: recorded.packageId,
            status: "completed",
            updated_at: new Date().toISOString(),
            username: recorded.username,
            ...(recorded.transactionId ? { transaction_id: recorded.transactionId } : {}),
            detail: `registered on-chain — live at ${appOrigin}/${recorded.username}`,
          });
        }
      } catch {
        // Chain read failed — fall through to the recorded status.
      }
    }
    return NextResponse.json({
      package_id: recorded.packageId,
      status: recorded.status,
      updated_at: new Date(recorded.updatedAt).toISOString(),
      ...(recorded.detail ? { detail: recorded.detail } : {}),
      ...(recorded.transactionId ? { transaction_id: recorded.transactionId } : {}),
      ...(recorded.username ? { username: recorded.username } : {}),
    });
  }
  // No terminal record: is the package still alive (pending) or gone?
  const pkg = await getClaimPackage(id);
  if (pkg) {
    return NextResponse.json({
      package_id: id,
      status: "pending",
      updated_at: new Date(pkg.createdAt).toISOString(),
      detail: "waiting for the human to open the approval link and tap approve",
    });
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return NextResponse.json({ error: "unknown package id" }, { status: 404 });
  }
  return NextResponse.json({
    package_id: id,
    status: "expired",
    detail:
      "this approval link expired without being used (24h TTL) — ask your agent for a fresh one if the human still wants to proceed",
  });
}
