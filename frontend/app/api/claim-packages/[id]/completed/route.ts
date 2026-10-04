/**
 * POST /api/claim-packages/[id]/completed — the /c/[id] approval page calls
 * this after the wallet's signature confirms on-chain.
 *
 * Body: { transaction_id: string } — the confirmed transaction id.
 *
 * The server does NOT trust the client: it verifies the username is
 * registered on-chain via lookupBlockpage (mirror-node contract read)
 * before marking the package "completed". If the page isn't on-chain
 * yet, it returns 409 and the agent keeps seeing "awaiting_signature".
 *
 * Why this exists: the agent polls GET /api/claim-packages/[id]/status
 * to learn when its blockpage is live. Without this signal the status
 * sat at "awaiting_signature" ("waiting for the human's wallet signature") forever
 * — the agent told the human "I can't run my blockpage until it's
 * registered" even after the human signed. Now the human's signature
 * completes the registration, and the agent sees "completed" with the
 * live page URL.
 *
 * Auth: the unguessable package id. The output is a status flip gated on
 * an on-chain read — no keys, no signing, no spending. Rate-limited.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getClaimPackage } from "@/lib/server/claim-packages";
import {
  getPackageStatus,
  setPackageStatus,
} from "@/lib/server/package-status";
import { lookupBlockpage } from "@/lib/server/mcp-tools";
import { ipGate } from "@/lib/server/rate-limit";

const ID_RE = /^[0-9a-f]{32}$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await ipGate(
    req,
    "claim-completed",
    "CLAIM_COMPLETED_IP_LIMIT",
    20,
    "too many completion reports — try again in a bit",
  );
  if (gated) return gated;

  const { id } = await params;
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: "unknown package id" }, { status: 404 });
  }

  let transactionId = "";
  try {
    const body = (await req.json()) as { transaction_id?: unknown };
    transactionId = typeof body.transaction_id === "string" ? body.transaction_id : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with transaction_id" }, { status: 400 });
  }
  if (!transactionId.trim()) {
    return NextResponse.json({ error: "transaction_id is required" }, { status: 400 });
  }

  // Find the username: the live package first, else the status record
  // written at finalize time (the package may already be deleted).
  const pkg = await getClaimPackage(id);
  const recorded = await getPackageStatus("claim", id);
  const username = pkg?.username ?? recorded?.username;
  if (!username) {
    return NextResponse.json({ error: "unknown package id" }, { status: 404 });
  }
  if (recorded?.status === "completed") {
    return NextResponse.json({ ok: true, already: true, username });
  }

  // Ground truth: is the page registered on-chain? Never trust the client.
  let lookup;
  try {
    lookup = await lookupBlockpage(username);
  } catch {
    return NextResponse.json(
      { error: "registry unreachable — try again in a moment" },
      { status: 503 },
    );
  }
  if (!lookup.found) {
    return NextResponse.json(
      { error: "blockpage not registered on-chain yet" },
      { status: 409 },
    );
  }

  const appOrigin = (process.env.APP_ORIGIN ?? "https://voicescape.vercel.app").replace(/\/$/, "");
  await setPackageStatus("claim", id, "completed", {
    username,
    transactionId: transactionId.trim(),
    detail: `registered on-chain — live at ${appOrigin}/${username}`,
  });
  return NextResponse.json({ ok: true, username, page_url: `${appOrigin}/${username}` });
}
