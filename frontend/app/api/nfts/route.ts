/**
 * GET /api/nfts?tokenId=0.0.x — live NFT gallery data for a collection.
 *
 * Reads the official Hedera mirror node (token info + minted serials),
 * resolves each serial's artwork through its wallet-readable (HIP-412)
 * metadata JSON — the same document HashPack's NFT gallery reads — and
 * returns HashScan links for independent verification. No keys, no
 * signing, no platform state: pure read-through.
 */
import { NextResponse } from "next/server";
import {
  getNftCollection,
  type NftToolDeps,
} from "@/lib/server/mcp-tools-nft";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tokenId = (searchParams.get("tokenId") ?? "").trim();
  if (!/^0\.0\.\d+$/.test(tokenId)) {
    return NextResponse.json(
      { error: "tokenId must look like 0.0.123456" },
      { status: 400 },
    );
  }
  const deps: NftToolDeps = {};
  const res = await getNftCollection({ token_id: tokenId }, deps);
  if ("error" in res) {
    const status = /does not exist/.test(res.error) ? 404 : 502;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json(res, {
    headers: { "cache-control": "public, max-age=30" },
  });
}
