import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { getKvStore } from "@/lib/server/store";
import { defaultDeps } from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * DM API — direct messages between wallets.
 *
 * POST /api/dms/send — { to, message }
 * GET /api/dms/inbox — list conversations
 * GET /api/dms/thread?with={address} — get messages with someone
 *
 * Storage: KV store (Upstash/Valkey/memory fallback).
 * Auth: signed wallet session required.
 */

function sortAddrs(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

async function getAddress(req: NextRequest): Promise<string | null> {
  const cred = sessionCredentialFrom(req);
  if (!cred) return null;
  try {
    const deps = defaultDeps();
    const verified = await deps.auth.verifySession(cred);
    if (!verified.ok) return null;
    return verified.session.address?.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** POST /api/dms/send */
export async function POST(req: NextRequest) {
  const from = await getAddress(req);
  if (!from) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const to = body.to?.toLowerCase();
  const message = body.message?.trim();

  if (!to || !/^0x[0-9a-f]{40}$/.test(to)) {
    return NextResponse.json({ error: "Invalid recipient address" }, { status: 400 });
  }
  if (!message || message.length > 1000) {
    return NextResponse.json({ error: "Message must be 1-1000 chars" }, { status: 400 });
  }
  if (to === from) {
    return NextResponse.json({ error: "Cannot DM yourself" }, { status: 400 });
  }

  const store = getKvStore();
  const [a1, a2] = sortAddrs(from, to);
  const threadKey = `dm:thread:${a1}:${a2}`;

  const msg = {
    from,
    to,
    message,
    timestamp: Date.now(),
  };

  // Append to thread
  let thread: any[] = [];
  try {
    const existing = await store.get(threadKey);
    if (existing) thread = JSON.parse(existing);
  } catch {}
  thread.push(msg);
  // Keep last 100 messages
  if (thread.length > 100) thread = thread.slice(-100);
  await store.set(threadKey, JSON.stringify(thread), 30 * 24 * 60 * 60 * 1000); // 30 days

  // Update inbox for both users
  for (const [user, other] of [[from, to], [to, from]] as const) {
    const inboxKey = `dm:inbox:${user}`;
    let inbox: any[] = [];
    try {
      const existing = await store.get(inboxKey);
      if (existing) inbox = JSON.parse(existing);
    } catch {}
    // Remove existing entry for this conversation
    inbox = inbox.filter((c) => c.with !== other);
    // Add to front
    inbox.unshift({ with: other, lastMessage: message.slice(0, 50), timestamp: msg.timestamp });
    if (inbox.length > 20) inbox = inbox.slice(0, 20);
    await store.set(inboxKey, JSON.stringify(inbox), 30 * 24 * 60 * 60 * 1000);
  }

  return NextResponse.json({ ok: true, timestamp: msg.timestamp });
}

/** GET /api/dms/inbox or /api/dms/thread */
export async function GET(req: NextRequest) {
  const address = await getAddress(req);
  if (!address) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const withAddr = searchParams.get("with")?.toLowerCase();

  const store = getKvStore();

  if (withAddr) {
    // Get thread
    if (!/^0x[0-9a-f]{40}$/.test(withAddr)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    const [a1, a2] = sortAddrs(address, withAddr);
    const threadKey = `dm:thread:${a1}:${a2}`;
    let thread: any[] = [];
    try {
      const data = await store.get(threadKey);
      if (data) thread = JSON.parse(data);
    } catch {}
    return NextResponse.json({ messages: thread });
  } else {
    // Get inbox
    const inboxKey = `dm:inbox:${address}`;
    let inbox: any[] = [];
    try {
      const data = await store.get(inboxKey);
      if (data) inbox = JSON.parse(data);
    } catch {}
    return NextResponse.json({ conversations: inbox });
  }
}
