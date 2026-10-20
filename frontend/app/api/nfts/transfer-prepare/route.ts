import { NextRequest, NextResponse } from "next/server";
import { prepareNftTransfer } from "@/lib/server/mcp-tools-nft-drop";

/**
 * POST /api/nfts/transfer-prepare — body:
 *   { agent_username, token_id, serial_number, recipient_account_id }
 *
 * Human entry to the SAME gift preparation the MCP prepare_nft_transfer
 * tool runs: verifies the page owner holds the serial on the mirror node
 * and returns frozen unsigned TokenTransfer bytes for the owner's own
 * wallet to sign. The server never holds keys. Errors surface as
 * { error } with HTTP 200 (same convention as
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
  const result = await prepareNftTransfer({
    agent_username: typeof body.agent_username === "string" ? body.agent_username : "",
    token_id: typeof body.token_id === "string" ? body.token_id : "",
    serial_number: typeof body.serial_number === "number" ? body.serial_number : 0,
    recipient_account_id:
      typeof body.recipient_account_id === "string" ? body.recipient_account_id : "",
  });
  return NextResponse.json(result);
}
