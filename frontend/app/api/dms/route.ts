import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { getKvStore } from "@/lib/server/store";
import { defaultDeps } from "@/lib/server/townhall/handlers";
import { ipGate } from "@/lib/server/rate-limit";
import { globalQuotaStore, quotaLimitFromEnv } from "@/lib/server/quota";
import {
  ADDR_RE,
  DM_DAILY_LIMIT_FALLBACK,
  DM_REPORT_DAILY_LIMIT_FALLBACK,
  getBlocked,
  getInbox,
  getThread,
  reportDm,
  sendDm,
  setBlocked,
} from "@/lib/server/dms";

export const runtime = "nodejs";

/**
 * DM API — direct messages between wallets.
 *
 * POST /api/dms            { to, message }            — send a message
 * POST /api/dms            { action: "block", address }   — block a user
 * POST /api/dms            { action: "unblock", address } — unblock a user
 * POST /api/dms            { action: "report", address, reason } — report a user
 * GET  /api/dms                                    — list conversations
 * GET  /api/dms?with={address}                     — get messages with someone
 * GET  /api/dms?blocks=1                           — list blocked addresses
 *
 * Storage: KV store (Valkey/Upstash/memory fallback), 30-day TTL.
 * Auth: signed wallet session required.
 * Rate limits: per-IP gate + per-wallet daily quota (Sybil bound).
 */

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

/** POST /api/dms — send / block / unblock / report */
export async function POST(req: NextRequest) {
  // Per-IP rate limit first (Sybil bound #2: one IP can't multiply wallets).
  const gated = await ipGate(
    req,
    "dm",
    "IP_RATE_LIMIT_DMS",
    60,
    "too many DM requests from this network — try again later",
  );
  if (gated) return gated;

  const from = await getAddress(req);
  if (!from) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const store = getKvStore();
  const quota = globalQuotaStore();

  // --- Block / unblock ---
  if (body.action === "block" || body.action === "unblock") {
    const addr = String(body.address ?? "").toLowerCase();
    if (!ADDR_RE.test(addr)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    try {
      const blocked = await setBlocked(store, from, addr, body.action === "block");
      return NextResponse.json({ ok: true, blocked });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const status = msg === "invalid-address" ? 400 : msg === "cannot-block-self" ? 400 : 500;
      return NextResponse.json(
        { error: msg === "cannot-block-self" ? "Cannot block yourself" : "Invalid address" },
        { status },
      );
    }
  }

  // --- Report ---
  if (body.action === "report") {
    const res = await reportDm(
      {
        store,
        quota,
        reportLimit: quotaLimitFromEnv("DM_REPORT_DAILY_LIMIT", DM_REPORT_DAILY_LIMIT_FALLBACK),
      },
      from,
      String(body.address ?? ""),
      String(body.reason ?? ""),
    );
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ ok: true });
  }

  // --- Send (default) ---
  const res = await sendDm(
    {
      store,
      quota,
      dmLimit: quotaLimitFromEnv("DM_DAILY_LIMIT", DM_DAILY_LIMIT_FALLBACK),
    },
    from,
    String(body.to ?? ""),
    String(body.message ?? ""),
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true, timestamp: res.timestamp });
}

/** GET /api/dms — inbox, thread, or block list */
export async function GET(req: NextRequest) {
  const address = await getAddress(req);
  if (!address) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const withAddr = searchParams.get("with")?.toLowerCase();
  const store = getKvStore();

  if (searchParams.get("blocks") === "1") {
    return NextResponse.json({ blocked: await getBlocked(store, address) });
  }

  if (withAddr) {
    if (!ADDR_RE.test(withAddr)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    return NextResponse.json({ messages: await getThread(store, address, withAddr) });
  }

  return NextResponse.json({ conversations: await getInbox(store, address) });
}
