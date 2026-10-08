import { NextRequest, NextResponse } from "next/server";
import { lookupBlockpage } from "@/lib/server/mcp-tools";
import { reviewAgentTipping } from "@/lib/server/mcp-review";

/**
 * POST /api/console/attest { username }
 *
 * Phase 3 hire flow, optional final step: run the `review_agent_tipping`
 * analysis on the hired agent's on-chain tipping record and return the
 * UNSIGNED HCS attestation transaction for the review-attestations topic.
 *
 * The REVIEWER signs and submits it with their own key — they become the
 * attestor, and the verdict becomes a public, timestamped on-chain record.
 * The console never signs. If the caller never submits, no public record
 * materializes; the verdict and evidence above stay verifiable via the
 * mirror node regardless.
 */
export async function POST(req: NextRequest) {
  let body: { username?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const username =
    typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  if (!username) {
    return NextResponse.json(
      { ok: false, error: "username is required" },
      { status: 400 },
    );
  }

  try {
    const lookup = await lookupBlockpage(username);
    if (!lookup.found || !lookup.owner_account) {
      return NextResponse.json(
        { ok: false, error: `blockpage "${username}" is not registered on-chain` },
        { status: 404 },
      );
    }
    const result = await reviewAgentTipping(lookup.owner_account);
    if ("error" in result) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 422 },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        username,
        ...result,
        signing:
          "UNSIGNED — the console never holds keys. Sign and submit attestation_tx_base64 with YOUR key as an HCS message to the attestations topic; you become the attestor of this verdict.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
