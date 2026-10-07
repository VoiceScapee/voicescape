/**
 * GET /api/claim-packages/[id]/status — agent-pollable package status.
 *
 * Lets the AGENT learn what happened to its claim package without the
 * human relaying it: pending → awaiting_signature → completed, or race_lost /
 * expired. A 404 here means the id never existed; a well-formed id with
 * no status record and no live package means it expired silently after
 * the 24h TTL (reported as expired so the agent stops guessing).
 *
 * Self-healing: an "awaiting_signature" / "awaiting_agent_signature" record
 * means the unsigned tx was issued and we're waiting on the signature
 * (human's wallet for the sovereign path, the agent's own key for the
 * self path). If the page is now registered on-chain (the signature
 * landed but the completion signal never arrived — closed tab, failed
 * request), this endpoint upgrades the record to "completed" on read so
 * the agent learns the truth instead of waiting forever. Best-effort: a
 * failed chain read returns the recorded status.
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
    // Self-heal: "awaiting_signature" / "awaiting_agent_signature" waits
    // on the signature. If the page is on-chain now, the signature landed
    // and the completion signal was lost — upgrade to "completed" so the
    // agent stops waiting.
    if (
      (recorded.status === "awaiting_signature" ||
        recorded.status === "awaiting_agent_signature") &&
      recorded.username
    ) {
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
    // Lazy expiry: the package itself has a 24h TTL but the status record
    // lives 7 days. A non-terminal record whose package is gone means the
    // link expired unused — report "expired" (and write it) so polling
    // agents get the same answer as the web approval page. Terminal
    // records (completed / race_lost) are returned as-is: the package is
    // deleted after completion, which is expected.
    if (
      recorded.status === "pending" ||
      recorded.status === "awaiting_signature" ||
      recorded.status === "awaiting_agent_signature"
    ) {
      const pkg = await getClaimPackage(id);
      // Belt-and-suspenders: even if the KV TTL hasn't fired yet, a package
      // older than 24h is expired. This keeps the API consistent with the
      // web approval page, which 404s once the package is gone.
      const PACKAGE_TTL_MS = 24 * 3_600_000;
      const pkgExpiredByAge =
        !!pkg && Date.now() - new Date(pkg.createdAt).getTime() > PACKAGE_TTL_MS;
      if (!pkg || pkgExpiredByAge) {
        await setPackageStatus("claim", id, "expired", {
          username: recorded.username,
          detail:
            "this approval link expired without being used (24h TTL) — ask your agent for a fresh one if the human still wants to proceed",
        });
        return NextResponse.json({
          package_id: recorded.packageId,
          status: "expired",
          updated_at: new Date().toISOString(),
          ...(recorded.username ? { username: recorded.username } : {}),
          detail:
            "this approval link expired without being used (24h TTL) — ask your agent for a fresh one if the human still wants to proceed",
        });
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
    const selfMode = pkg.mode === "self";
    return NextResponse.json({
      package_id: id,
      status: "pending",
      updated_at: new Date(pkg.createdAt).toISOString(),
      detail: selfMode
        ? "waiting for the agent to finalize and sign with its own key — the human approves in the agent's own chat, no browser link"
        : "waiting for the human to open the approval link and tap approve",
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
