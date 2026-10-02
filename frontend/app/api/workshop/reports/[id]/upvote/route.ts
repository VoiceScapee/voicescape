import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { upvoteWorkshopReport } from "@/lib/server/agent-workshop";

export const runtime = "nodejs";

/**
 * POST /api/workshop/reports/[id]/upvote {username}
 * One upvote per voter (username or address). Wallet session required;
 * the username must resolve to the session address.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { username?: unknown };
  const cred = sessionCredentialFrom(req);
  if (!cred) return NextResponse.json({ error: "Sign in with your wallet to upvote." }, { status: 401 });
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 401 });

  const name = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  let voter: string;
  if (/^[a-z0-9_-]{3,32}$/.test(name)) {
    const owner = await defaultRegistryPort().resolveOwner(name);
    if (!owner || owner.toLowerCase() !== verified.session.address.toLowerCase()) {
      return NextResponse.json({ error: "That username doesn't belong to this wallet." }, { status: 403 });
    }
    voter = name;
  } else {
    voter = verified.session.address.toLowerCase();
  }

  const res = await upvoteWorkshopReport(id, voter);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ upvotes: res.upvotes });
}
