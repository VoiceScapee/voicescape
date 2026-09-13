/**
 * GET /api/resolve?username=<name> | ?owner=<0.0.x | 0x…>
 *
 * Server-side page resolution. The browser can't always call the Hedera
 * RPC directly (CORS), so we resolve here where there's no CORS restriction.
 *
 * ?username= → { owner, ipfsHash, ownerType, operator, purpose } or 404.
 * ?owner=    → { username } — reverse lookup: which page does this wallet
 *              account own? Finds the account's latest registerPage call on
 *              the Registry via the mirror node. 404 when the account owns
 *              no page.
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";

const REGISTRY_ABI = [
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
];

// Mainnet Registry EVM address
const REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const RPC_URL = process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC?.trim() || "https://mainnet.hashio.io/api";

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  const owner = req.nextUrl.searchParams.get("owner");

  // Reverse lookup: wallet account -> registered username. Used by the
  // onboarding gate so a wallet that already owns a page never replays the
  // "first blockpage" wizard on a fresh browser/profile.
  if (owner) {
    const found = await resolveUsernameForOwner(owner);
    if (!found) {
      return NextResponse.json({ error: "no page registered for this account" }, { status: 404 });
    }
    return NextResponse.json({ username: found });
  }

  if (!username) {
    return NextResponse.json({ error: "username or owner required" }, { status: 400 });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(REGISTRY_EVM, REGISTRY_ABI, provider);
    const [owner, ipfsHash, ownerType, operator, purpose] = await contract.resolvePage(username);

    return NextResponse.json({
      owner,
      ipfsHash,
      ownerType: Number(ownerType),
      operator,
      purpose,
    });
  } catch (err) {
    // Contract reverts when username is not registered
    return NextResponse.json(
      { error: "not registered", detail: err instanceof Error ? err.message : "unknown" },
      { status: 404 }
    );
  }
}
