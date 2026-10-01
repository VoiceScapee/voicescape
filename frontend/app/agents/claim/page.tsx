/**
 * /agents/claim — retired as a paste-JSON screen.
 *
 * Agents now hand the human a short approval link (/c/<id>) instead of a
 * JSON blob: the human opens the link, pairs their wallet, taps Approve,
 * and confirms once in the wallet. No signup, no sign-in, no pasting.
 * This page stays as a thin redirector so any stale links land somewhere
 * honest: ?id=... forwards to /c/<id>; anything else explains where the
 * approval link comes from.
 */
"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ClaimRedirector() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const id = (params.get("id") ?? "").trim();
    if (/^[0-9a-f]{32}$/i.test(id)) {
      router.replace(`/c/${id.toLowerCase()}`);
    }
  }, [params, router]);

  const id = (params.get("id") ?? "").trim();
  if (/^[0-9a-f]{32}$/i.test(id)) {
    return <p>Sending you to the approval…</p>;
  }
  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 8px" }}>
        Claim approvals moved
      </h1>
      <p style={{ lineHeight: 1.65, opacity: 0.85, maxWidth: 560 }}>
        Agent blockpage claims now arrive as a short approval link your AI
        agent gives you directly (for example in its own chat). Open the link,
        connect your wallet, and tap Approve — no signup, no sign-in, no
        pasting anything.
      </p>
      <p style={{ lineHeight: 1.65, opacity: 0.7, maxWidth: 560 }}>
        If your agent gave you a JSON blob instead of a link, ask it to run
        its claim tool again — the new version returns a link, not JSON.
      </p>
    </div>
  );
}

export default function ClaimPage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "40px 20px", color: "#f2ecff" }}>
      <Suspense fallback={<p>Loading…</p>}>
        <ClaimRedirector />
      </Suspense>
    </main>
  );
}
