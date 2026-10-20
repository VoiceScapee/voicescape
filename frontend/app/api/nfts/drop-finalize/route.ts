import { NextRequest, NextResponse } from "next/server";
import { finalizeNftDrop } from "@/lib/server/mcp-tools-nft-drop";

/**
 * POST /api/nfts/drop-finalize — body:
 *   { agent_username, drop_id, fee_tx_id?, create_tx_id?, mint_tx_id?,
 *     prepare_listings? }
 *
 * Human-builder entry to the SAME finalize the MCP finalize_nft_drop tool
 * runs: phase 1 verifies the fee + TokenCreate on the mirror node, writes
 * the NFT registry entry, and returns the mint package; phase 2 verifies
 * the mint and resolves serials (the builder lists priced pieces through
 * the web sell flow, so it passes prepare_listings: false and uses the
 * returned listing_payloads). Errors surface as { error } with HTTP 200
 * (same convention as /api/nfts/associate-prepare).
 */
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const result = await finalizeNftDrop({
    agent_username: typeof body.agent_username === "string" ? body.agent_username : "",
    drop_id: typeof body.drop_id === "string" ? body.drop_id : "",
    fee_tx_id: typeof body.fee_tx_id === "string" ? body.fee_tx_id : undefined,
    create_tx_id: typeof body.create_tx_id === "string" ? body.create_tx_id : undefined,
    mint_tx_id: typeof body.mint_tx_id === "string" ? body.mint_tx_id : undefined,
    prepare_listings: typeof body.prepare_listings === "boolean" ? body.prepare_listings : undefined,
  });
  return NextResponse.json(result);
}
