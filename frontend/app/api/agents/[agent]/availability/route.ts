import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { createReadOnlySender } from "@/lib/tx";
import { getActiveChain } from "@/lib/chains";
import { getRegistryAddress } from "@/lib/contracts";
import {
  clearAvailabilityCore,
  setAvailabilityCore,
  type AvailabilityDeps,
} from "@/lib/server/agent-availability";

export const runtime = "nodejs";

/**
 * POST /api/agents/[agent]/availability — set the "open for work" flag.
 * DELETE /api/agents/[agent]/availability — clear it.
 *
 * Body (POST): { "open": boolean } — a real boolean, not a truthy value.
 *
 * Auth: signed wallet session (x-vs-session header). 401 without. The
 * session wallet must own the agent's on-chain page (403 otherwise), and
 * the page must be an agent page (400 for human pages — the flag only
 * surfaces in the agent directory).
 *
 * The flag lives in KV with a 30-day TTL: a flag that isn't refreshed
 * disappears instead of going stale. The directory renders null (no badge)
 * when the flag is missing or expired.
 *
 * Rate limits: 60/hour per IP (flood gate) + 20/hour per wallet.
 */

const WALLET_RATE_LIMIT = 20;
const WALLET_RATE_WINDOW_MS = 3600_000;

function realDeps(): AvailabilityDeps {
  return {
    verifySession: async (cred: unknown) => {
      const res = await defaultAuthPort().verifySession(cred);
      return res.ok
        ? { ok: true as const, address: res.session.address }
        : { ok: false as const, error: res.error };
    },
    resolvePage: async (username: string) => {
      const registry = getRegistryAddress();
      if (!registry) throw new Error("registry not configured");
      const sender = createReadOnlySender(getActiveChain());
      const record = await sender.viewResolve(registry, username);
      return record ? { owner: record.owner, ownerType: record.ownerType } : null;
    },
    store: getKvStore(),
    nowMs: () => Date.now(),
  };
}

/**
 * Shared pre-flight: per-IP flood gate, then session verify, then the
 * per-wallet quota. Returns the authed address, or a response to send.
 * The cores re-verify the session themselves (cheap stateless HMAC) so
 * they stay independently testable.
 */
async function preflight(
  req: NextRequest,
): Promise<{ address: string; cred: unknown } | { response: NextResponse }> {
  const gated = await ipGate(
    req,
    "agent-availability",
    "IP_RATE_LIMIT_AGENT_AVAILABILITY",
    60,
    "too many availability requests from this network — try again later",
  );
  if (gated) return { response: gated };

  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return {
      response: NextResponse.json(
        { error: "missing session: sign in with your wallet" },
        { status: 401 },
      ),
    };
  }
  const verified = await realDeps().verifySession(cred);
  if (!verified.ok) {
    return { response: NextResponse.json({ error: verified.error }, { status: 401 }) };
  }

  let used: number;
  try {
    used = await getKvStore().incr(`agent-availability:${verified.address}`, WALLET_RATE_WINDOW_MS);
  } catch {
    return {
      response: NextResponse.json(
        { error: "rate limiter unavailable — try again in a moment" },
        { status: 503 },
      ),
    };
  }
  if (used > WALLET_RATE_LIMIT) {
    return {
      response: NextResponse.json(
        { error: `rate limit exceeded: ${WALLET_RATE_LIMIT} availability updates per hour` },
        { status: 429 },
      ),
    };
  }
  return { address: verified.address, cred };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agent: string }> }) {
  const pre = await preflight(req);
  if ("response" in pre) return pre.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { agent } = await params;
  const { status, json } = await setAvailabilityCore(agent, body, pre.cred, realDeps());
  return NextResponse.json(json, { status });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ agent: string }> }) {
  const pre = await preflight(req);
  if ("response" in pre) return pre.response;

  const { agent } = await params;
  const { status, json } = await clearAvailabilityCore(agent, pre.cred, realDeps());
  return NextResponse.json(json, { status });
}
