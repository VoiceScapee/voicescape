/**
 * POST /api/intros/claim — link an agent intro to a registered blockpage.
 *
 * Body: { claim_code: string } with either
 *   (a) x-vs-session auth (the 7-day wallet session token, HMAC-verified
 *       server-side), or
 *   (b) { package_id: string } — the short id of the claim package that
 *       produced the registration, sent right after on-chain confirmation
 *       from the /c/<id> approval page. No session needed.
 *
 * Auth (b): the package's stored claim code must match the claim_code, and
 * the username must be registered ON-CHAIN (verified via lookupBlockpage)
 * before the intro links. The unguessable package id plus the on-chain
 * read is the authorization; the package is deleted after a successful
 * link so the id can't be replayed. No payment, no chain write — this
 * only records the link between an intro and its blockpage.
 *
 * Ownership check (a): the session's wallet address is reverse-resolved
 * through the on-chain Registry (resolveUsernameForOwner). A wallet with
 * no registered blockpage cannot claim.
 */
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { claimAgentIntro } from "@/lib/server/agent-intros";
import { getClaimPackage, deleteClaimPackage } from "@/lib/server/claim-packages";
import { setPackageStatus } from "@/lib/server/package-status";
import { lookupBlockpage } from "@/lib/server/mcp-tools";

export async function POST(req: NextRequest): Promise<Response> {
  let claimCode = "";
  let packageId = "";
  try {
    const body = (await req.json()) as { claim_code?: unknown; package_id?: unknown };
    claimCode = typeof body.claim_code === "string" ? body.claim_code : "";
    packageId = typeof body.package_id === "string" ? body.package_id : "";
  } catch {
    return Response.json({ error: "body must be JSON with claim_code" }, { status: 400 });
  }
  if (!claimCode.trim()) {
    return Response.json({ error: "claim_code is required" }, { status: 400 });
  }

  // Branch (b): package-authorized auto-link, no session.
  if (packageId.trim()) {
    return linkViaClaimPackage(packageId.trim(), claimCode.trim());
  }

  // Branch (a): session-authorized claim, unchanged.
  const token = req.headers.get(SESSION_HEADER)?.trim() ?? "";
  // Agent tokens are accepted here (explicit allowlist opt-in): the
  // linked username is forced to the token's own agent — never
  // reverse-resolved, so a token can never claim another page's intro.
  const verified = await defaultAuthPort().verifySession(token || null, { allowAgent: true });
  if (!verified.ok) {
    return Response.json(
      { error: "sign in with your wallet first" },
      { status: 401 },
    );
  }

  // Agent scope: the token's username IS the claim target. A full human
  // session keeps the existing reverse-resolve behavior.
  let username: string | null;
  if (verified.session.agent?.username) {
    username = verified.session.agent.username;
  } else {
    // The wallet must own a registered blockpage on-chain.
    username = await resolveUsernameForOwner(verified.session.address);
  }
  if (!username) {
    return Response.json(
      {
        error:
          "this wallet doesn't own a registered blockpage yet — build one first, then link your intro",
      },
      { status: 403 },
    );
  }

  const res = await claimAgentIntro(claimCode, username);
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400 });
  }
  return Response.json({
    ok: true,
    username,
    handle: res.intro.handle,
    linked_blockpage: res.intro.linked_blockpage,
  });
}

/**
 * Package-authorized auto-link: the package must exist, its stored claim
 * code must match, and the username must be registered on-chain NOW.
 * Deletes the package on success so the id can't be replayed.
 */
async function linkViaClaimPackage(
  packageId: string,
  claimCode: string,
): Promise<Response> {
  const pkg = await getClaimPackage(packageId);
  if (!pkg) {
    return Response.json(
      { error: "approval link invalid or expired — link the intro manually" },
      { status: 404 },
    );
  }
  if (!pkg.claimCode || pkg.claimCode !== claimCode.trim().toUpperCase()) {
    return Response.json(
      { error: "claim code doesn't match this approval — link the intro manually" },
      { status: 403 },
    );
  }
  // The registration must be on-chain before the intro links — the /c page
  // sends this after mirror-node confirmation, but never trust the client.
  let lookup;
  try {
    lookup = await lookupBlockpage(pkg.username);
  } catch {
    return Response.json(
      { error: "registry unreachable — link the intro manually" },
      { status: 503 },
    );
  }
  if (!lookup.found) {
    return Response.json(
      { error: "blockpage not registered on-chain yet — link the intro manually" },
      { status: 409 },
    );
  }

  const res = await claimAgentIntro(claimCode, pkg.username);
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400 });
  }
  // The page is verified on-chain above (lookup.found) — the claim is
  // complete. Mark it BEFORE deleting the package so the agent polling
  // the package status sees "completed" instead of waiting forever.
  const appOrigin = (process.env.APP_ORIGIN ?? "https://voicescape.vercel.app").replace(/\/$/, "");
  await setPackageStatus("claim", packageId, "completed", {
    username: pkg.username,
    detail: `registered on-chain — live at ${appOrigin}/${pkg.username}`,
  });
  await deleteClaimPackage(packageId);
  return Response.json({
    ok: true,
    username: pkg.username,
    handle: res.intro.handle,
    linked_blockpage: res.intro.linked_blockpage,
  });
}
