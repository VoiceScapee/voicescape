import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/hashpack-profile?account=<0.0.x | 0x…>
 *
 * Server-side proxy for HashPack's free, no-auth Profile API. The browser
 * never talks to api.hashpack.app directly (CORS + response shaping).
 * Returns a trimmed profile: HNS username, bio, X handle, PFP thumbnail.
 * Best-effort pre-fill for the builder — callers must treat every field as
 * optional and never block on this route.
 */
export const revalidate = 300;

const UPSTREAM = "https://api.hashpack.app/user-profile/get";

interface UpstreamProfile {
  username?: { name?: string | null } | null;
  bio?: string | null;
  twitterHandle?: string | null;
  profilePicture?: { thumbUrl?: string | null } | null;
}

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get("account")?.trim();
  if (!account || !/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/.test(account)) {
    return NextResponse.json({ error: "account required (0.0.x or 0x…)" }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: account, network: "mainnet" }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return NextResponse.json(
      { error: "profile service unavailable — try again", code: "UPSTREAM_UNAVAILABLE", retryable: true },
      { status: 502 },
    );
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: "profile lookup failed" }, { status: 502 });
  }
  let data: UpstreamProfile;
  try {
    data = (await upstream.json()) as UpstreamProfile;
  } catch {
    return NextResponse.json({ error: "profile parse failed" }, { status: 502 });
  }
  return NextResponse.json({
    username: data?.username?.name ?? null,
    bio: typeof data?.bio === "string" ? data.bio : null,
    twitterHandle: typeof data?.twitterHandle === "string" ? data.twitterHandle : null,
    pfp: data?.profilePicture?.thumbUrl ?? null,
  });
}
