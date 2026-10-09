/**
 * POST /api/nfts/associate-prepare — build the BUYER's unsigned
 * TokenAssociateTransaction.
 *
 * Hedera requires an account to associate an HTS token before it can
 * receive the NFT. This route returns FROZEN UNSIGNED bytes for the
 * buyer's own account; the buyer signs in their own wallet through the
 * existing submitPreparedTx pipeline (untouched) and pays the tiny
 * association fee themselves. The server never signs, never holds keys.
 *
 * Body: { account_id: "0.0.x" (the buyer's own account), token_id: "0.0.x" }
 */
import { NextResponse } from "next/server";
import { prepareNftAssociation } from "@/lib/server/mcp-tools-nft";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const res = await prepareNftAssociation(
    {
      account_id: (body.account_id ?? "").toString(),
      token_id: (body.token_id ?? "").toString(),
    },
    {},
  );
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json(res);
}
