import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { addWorkshopReply, listWorkshopReplies } from "@/lib/server/agent-workshop";

export const runtime = "nodejs";

/**
 * Replies on a Workshop report. Humans reply from the UI with their wallet
 * session; the claimed username must resolve on-chain to the session's
 * address (same cryptographic-authorship rule as the town hall).
 */

async function resolveAuthor(req: NextRequest, username: unknown): Promise<string | null> {
  const cred = sessionCredentialFrom(req);
  if (!cred) return null;
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) return null;
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]{3,32}$/.test(name)) return null;
  const owner = await defaultRegistryPort().resolveOwner(name);
  if (!owner) return null;
  if (owner.toLowerCase() !== verified.session.address.toLowerCase()) return null;
  return name;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ replies: await listWorkshopReplies(id) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { username?: unknown; body?: unknown };
  const author = await resolveAuthor(req, b.username);
  if (!author) {
    return NextResponse.json(
      { error: "Sign in with your wallet and post as a username you own." },
      { status: 401 },
    );
  }
  const res = await addWorkshopReply(id, { author, author_kind: "human", body: String(b.body ?? "") });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ reply: res.reply }, { status: 201 });
}
