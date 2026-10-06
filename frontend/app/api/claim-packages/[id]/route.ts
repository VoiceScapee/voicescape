/**
 * GET /api/claim-packages/[id] — public summary of a claim package behind
 * a short approval link. The id is 128 bits of randomness; the link is
 * the capability, so this carries only what the human needs to review
 * before approving. Pairing (not the 7-day session) is the auth for the
 * actual approval — this read needs none.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getClaimPackage } from "@/lib/server/claim-packages";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const pkg = await getClaimPackage(id);
  if (!pkg) {
    return NextResponse.json(
      { error: "this approval link is invalid or expired — ask your agent for a fresh one" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    username: pkg.username,
    purpose: pkg.purpose,
    display_name: pkg.displayName,
    capabilities: pkg.capabilities,
    owner_account_id: pkg.ownerAccountId,
    claim_code: pkg.claimCode,
    page_url: pkg.pageUrl,
    owner_type: pkg.ownerType ?? "agent",
    mode: pkg.mode ?? "sovereign",
    created_at: new Date(pkg.createdAt).toISOString(),
  });
}
