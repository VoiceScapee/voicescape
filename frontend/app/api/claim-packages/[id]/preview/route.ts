/**
 * GET /api/claim-packages/[id]/preview — the assembled (not yet pinned)
 * page document for a claim package, so the approve page can render a
 * true WYSIWYG preview of the custom layout before the human signs.
 * Same capability model as the package summary: the link is the secret.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getClaimPackage } from "@/lib/server/claim-packages";
import { assembleClaimPage } from "@/lib/server/page-customize";
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";

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
  try {
    const page = assembleClaimPage({
      username: pkg.username,
      ownerType: pkg.ownerType === "human" ? "human" : "agent",
      displayName: pkg.displayName ?? pkg.username,
      purpose: pkg.purpose,
      capabilities: pkg.capabilities ?? [],
      // Operator preview: the real operator defaults to the approving
      // wallet at finalize time; the zero address marks "set at approval".
      operator: pkg.operator ?? "0x0000000000000000000000000000000000000000",
      templateId: pkg.templateId,
      theme: pkg.theme,
      socials: pkg.socials,
      links: pkg.links,
    });
    return NextResponse.json({ page });
  } catch (e) {
    try {
      await recordClientError(
        getKvStore(),
        "/api/claim-packages/preview",
        "assemble-failed",
        "server",
      );
    } catch {
      /* tracking never blocks the response */
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not assemble preview" },
      { status: 502 },
    );
  }
}
