/**
 * Shared plumbing for the liaison API routes (app/api/liaison/*).
 *
 * Not a route itself (underscore-prefixed files are private in the app
 * router). Each route stays thin: per-IP gate, wallet-session auth via
 * the standard x-vs-session header, per-wallet quota — then delegates to
 * the framework-free handlers in lib/server/liaison/handlers.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { getKvStore } from "@/lib/server/store";
import {
  MIRROR_NODE_BASE,
  assertLiaisonPriceFloor,
  liaisonPriceFloorHbar,
  liaisonPriceHbar,
} from "@/lib/liaison";
import type { HandlerResult, LiaisonDeps } from "@/lib/server/liaison/handlers";
import {
  fetchMirrorJson,
  forwardLiaisonRevenue,
  sdkExecuteTransfer,
} from "@/lib/server/liaison/forwarder";

/** Verified session wallet (lowercase EVM), or null when signed out. */
export async function liaisonSessionAddr(req: NextRequest): Promise<string | null> {
  try {
    const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
    if (!verified.ok) return null;
    return verified.session.address.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Real production deps for the liaison handlers.
 *
 * BOOT ASSERTION (economics invariant — the platform never loses money on
 * the liaison): refuses to build deps when LIAISON_PRICE_HBAR sits below
 * LIAISON_PRICE_FLOOR_HBAR (default 1 HBAR). Slice-1 marginal cost is ~$0
 * (deterministic KB, no LLM, free mirror-node reads, free-tier KV), so any
 * price at/above the floor is profitable — a misconfigured price can only
 * fail closed, never sell help at a loss. See liaisonPriceFloorHbar for
 * the margin math.
 */
export function liaisonDeps(): LiaisonDeps {
  const priceHbar = liaisonPriceHbar();
  assertLiaisonPriceFloor(priceHbar, liaisonPriceFloorHbar());
  return {
    kv: getKvStore(),
    nowMs: () => Date.now(),
    priceHbar,
    mirrorGet: async (path: string) => {
      const res = await fetch(`${MIRROR_NODE_BASE}${path}`, {
        headers: { Accept: "application/json" },
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* non-JSON — leave null */
      }
      return { ok: res.ok, status: res.status, json };
    },
    // Revenue sweep: after each verified tip, forward the liaison's own
    // received share to treasury (best-effort; never fails verification).
    afterTipVerified: async () => {
      const r = await forwardLiaisonRevenue({
        mirrorGet: fetchMirrorJson,
        executeTransfer: sdkExecuteTransfer,
      });
      return r.forwarded && r.txId ? r.txId : null;
    },
  };
}

/**
 * Build route deps, or return a 503 when the price-floor boot assertion
 * fires (misconfigured LIAISON_PRICE_HBAR — operator must fix the env).
 */
export function liaisonRouteDeps():
  | { ok: true; deps: LiaisonDeps }
  | { ok: false; response: NextResponse } {
  try {
    return { ok: true, deps: liaisonDeps() };
  } catch (e) {
    console.error("[liaison] refusing to serve:", e instanceof Error ? e.message : e);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Danny help is temporarily unavailable — please try again later" },
        { status: 503 },
      ),
    };
  }
}

/** Translate a handler result into a NextResponse. */
export function toResponse(r: HandlerResult): NextResponse {
  return NextResponse.json(r.body, { status: r.status });
}

/** Read a JSON body, tolerating empty/malformed input (handlers validate). */
export async function readJsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
