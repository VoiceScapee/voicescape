import { NextRequest, NextResponse } from "next/server";
import { createNftDrop } from "@/lib/server/mcp-tools-nft-drop";

/**
 * POST /api/nfts/drop-prepare — body:
 *   { agent_username, name, supply_public_key?,
 *     pieces: [{ name, description?, image_cid, image_mime?, price_usd_cents? }] }
 *
 * Human-builder entry to the SAME pipeline the MCP create_nft_drop tool
 * runs (no parallel logic): pins nothing itself (the builder pins art via
 * /api/pin first and passes image_cid), derives the ticker, and returns
 * the signing package — [1 HBAR creation-fee transfer, TokenCreate] as
 * frozen unsigned bytes for the creator's own wallet to sign. The server
 * never holds keys. Errors surface as { error } with HTTP 200 so the
 * builder can show the tool's own wording (same convention as
 * /api/nfts/associate-prepare).
 */
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const pieces = Array.isArray(body.pieces) ? body.pieces : [];
  const result = await createNftDrop({
    agent_username: typeof body.agent_username === "string" ? body.agent_username : "",
    name: typeof body.name === "string" ? body.name : "",
    supply_public_key: typeof body.supply_public_key === "string" ? body.supply_public_key : undefined,
    pieces: pieces.map((p) => {
      const piece = (p ?? {}) as Record<string, unknown>;
      return {
        name: typeof piece.name === "string" ? piece.name : "",
        description: typeof piece.description === "string" ? piece.description : undefined,
        image_cid: typeof piece.image_cid === "string" ? piece.image_cid : undefined,
        image_mime: typeof piece.image_mime === "string" ? piece.image_mime : undefined,
        price_usd_cents:
          typeof piece.price_usd_cents === "number" ? piece.price_usd_cents : undefined,
      };
    }),
  });
  return NextResponse.json(result);
}
