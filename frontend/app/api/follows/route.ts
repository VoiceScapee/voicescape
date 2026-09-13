import { NextRequest, NextResponse } from "next/server";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { getKvStore } from "@/lib/server/store";
import { ipGate } from "@/lib/server/rate-limit";
import {
  globalQuotaStore,
  quotaExceededBody,
  quotaLimitFromEnv,
} from "@/lib/server/quota";
import {
  followPage,
  readFollowList,
  unfollowPage,
  USERNAME_RE,
} from "@/lib/follows";

export const runtime = "nodejs";

/**
 * GET /api/follows — the caller's own following list (private: only the
 * signed-in wallet's session may read it).
 * Response: { following: ["alice","bob"] }
 *
 * POST /api/follows { username } — follow a page. Wallet-signed.
 *   400 invalid username | 404 unknown username (not registered on-chain) |
 *   400 self-follow.
 * Response: { ok: true, following: [...] }
 *
 * DELETE /api/follows { username } — unfollow. Idempotent.
 * Response: { ok: true, following: [...] }
 */

async function authedWallet(req: NextRequest): Promise<{ wallet: string } | NextResponse> {
  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  return { wallet: verified.session.address };
}

export async function GET(req: NextRequest) {
  const authed = await authedWallet(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const following = await readFollowList(getKvStore(), authed.wallet);
    return NextResponse.json({ following });
  } catch (err) {
    console.error("[follows] GET failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "could not load your following list" }, { status: 503 });
  }
}

async function writeGate(req: NextRequest): Promise<NextResponse | null> {
  return ipGate(
    req,
    "follows",
    "IP_RATE_LIMIT_FOLLOWS",
    120,
    "too many follow requests from this network — try again later",
  );
}

/** Per-wallet daily quota for follows (POST only — the growth vector).
 * KV growth is real but cheap, so the default is generous; the point is
 * to stop an automated wallet from following unlimited pages. Fail
 * closed (503) when the quota store is unreachable. */
async function followQuota(wallet: string): Promise<NextResponse | null> {
  const limit = quotaLimitFromEnv("FOLLOWS_DAILY_QUOTA", 100);
  let res;
  try {
    res = await globalQuotaStore().consume(
      "follows",
      wallet.toLowerCase(),
      limit,
    );
  } catch (e) {
    console.error(
      `[follows] quota store unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }
  if (!res.allowed) {
    return NextResponse.json(
      quotaExceededBody(res, "daily follow quota exceeded — try again after UTC midnight"),
      { status: 429 },
    );
  }
  return null;
}

async function readBody(req: NextRequest): Promise<{ username?: unknown }> {
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") return body as { username?: unknown };
  } catch {
    /* fall through */
  }
  return {};
}

export async function POST(req: NextRequest) {
  const gated = await writeGate(req);
  if (gated) return gated;
  const authed = await authedWallet(req);
  if (authed instanceof NextResponse) return authed;

  const { username } = await readBody(req);
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!USERNAME_RE.test(name)) {
    return NextResponse.json({ error: "invalid username" }, { status: 400 });
  }

  const quotaHit = await followQuota(authed.wallet);
  if (quotaHit) return quotaHit;

  try {
    const result = await followPage({
      store: getKvStore(),
      wallet: authed.wallet,
      username: name,
      registry: defaultRegistryPort(),
    });
    if (!result.ok) {
      const status =
        result.error === "unknown-username" ? 404
        : result.error === "self-follow" ? 400
        : 400;
      const message =
        result.error === "unknown-username"
          ? `no page is registered for "${name}"`
          : result.error === "self-follow"
            ? "you can't follow your own page"
            : "invalid username";
      return NextResponse.json({ error: message }, { status });
    }
    return NextResponse.json({ ok: true, following: result.following });
  } catch (err) {
    console.error("[follows] POST failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "could not follow that page right now" }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  const gated = await writeGate(req);
  if (gated) return gated;
  const authed = await authedWallet(req);
  if (authed instanceof NextResponse) return authed;

  const { username } = await readBody(req);
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";

  try {
    const following = await unfollowPage(getKvStore(), authed.wallet, name);
    return NextResponse.json({ ok: true, following });
  } catch (err) {
    console.error("[follows] DELETE failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "could not unfollow that page right now" }, { status: 503 });
  }
}
