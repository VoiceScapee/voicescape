/**
 * GET /api/resolve?username=<name>
 *
 * Server-side page resolution. The browser can't always call the Hedera
 * RPC directly (CORS), so we resolve here where there's no CORS restriction.
 *
 * Returns: { owner, ipfsHash, ownerType, operator, purpose } or 404.
 */

import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

const REGISTRY_ABI = [
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
];

// Mainnet Registry EVM address
const REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const RPC_URL = process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api";

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  if (!username) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
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
