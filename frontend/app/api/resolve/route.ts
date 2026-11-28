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
import { resolvePageForOwnerDetailed } from "@/lib/registry-reverse";
import { assessOwnerType } from "@/lib/owner-type";
import { mirrorContractCall, MirrorUnreachable } from "@/lib/tx";
import { CHAINS } from "@/lib/chains";

const REGISTRY_ABI = [
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
];

// Mainnet Registry EVM address
const REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";

const REGISTRY_IFACE = new ethers.Interface(REGISTRY_ABI);

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  const owner = req.nextUrl.searchParams.get("owner");

  // Reverse lookup: wallet account -> registered username. Used by the
  // onboarding gate so a wallet that already owns a page never replays the
  // "first blockpage" wizard on a fresh browser/profile.
  // A mirror-node failure is "unknown", never "owns no page": 503 so the
  // caller retries instead of showing the wizard to a real owner.
  if (owner) {
    const found = await resolvePageForOwnerDetailed(owner);
    if (found.status === "unavailable") {
      return NextResponse.json(
        { error: "couldn't reach Hedera — try again in a moment" },
        { status: 503 },
      );
    }
    if (found.status === "none") {
      return NextResponse.json({ error: "no page registered for this account" }, { status: 404 });
    }
    return NextResponse.json({ username: found.page.username });
  }

  if (!username) {
    return NextResponse.json({ error: "username or owner required" }, { status: 400 });
  }

  try {
    // Read through the official Hedera mirror node (no JSON-RPC provider);
    // ethers only encodes/decodes the calldata.
    const data = REGISTRY_IFACE.encodeFunctionData("resolvePage", [username]);
    const raw = await mirrorContractCall(CHAINS["hedera-mainnet"], REGISTRY_EVM, data);
    const [owner, ipfsHash, ownerType, operator, purpose] = REGISTRY_IFACE.decodeFunctionResult(
      "resolvePage",
      raw,
    ) as unknown as [string, string, bigint, string, string];

    // The human/agent label is a self-declared claim, never a verified
    // fact (Clearance first pass, 2026-11-27, F2): registerPage takes
    // ownerType from the caller and HUMAN pages skip disclosure. The raw
    // ownerType number stays for compatibility; consumers must read
    // owner_type_verified + owner_type_note before trusting the label.
    // Agent pages also carry hcs10_verification_url — the deeper HCS-10
    // registration proof at the standard verify-registration endpoint.
    const assessed = assessOwnerType(ownerType, operator, purpose);
    return NextResponse.json({
      owner,
      ipfsHash,
      ownerType: Number(ownerType),
      operator,
      purpose,
      owner_type: assessed.owner_type,
      owner_type_verified: assessed.owner_type_verified,
      owner_type_note: assessed.owner_type_note,
      hcs10_verification_url:
        assessed.owner_type === "agent"
          ? `${req.nextUrl.origin}/api/agents/verify-registration?username=${encodeURIComponent(username)}`
          : null,
    });
  } catch (err) {
    // A mirror-node failure (MirrorUnreachable) is "unknown", never
    // "not registered": answering 404 on an outage makes every page
    // look unregistered and sends the claim flow down the register path
    // for a taken name (a doomed, gas-burning revert). Only a contract
    // revert means the name is genuinely unregistered.
    if (err instanceof MirrorUnreachable) {
      return NextResponse.json(
        { error: "couldn't reach Hedera — try again in a moment" },
        { status: 503 },
      );
    }
    // Contract reverts when username is not registered
    return NextResponse.json(
      { error: "not registered", detail: err instanceof Error ? err.message : "unknown" },
      { status: 404 }
    );
  }
}
