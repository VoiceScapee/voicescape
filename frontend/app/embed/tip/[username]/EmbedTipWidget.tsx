"use client";

/**
 * <EmbedTipWidget> — the standalone tip widget rendered at
 * /embed/tip/[username] for embedding on external sites.
 *
 * Fully self-contained inside the iframe: resolves the username through the
 * existing on-chain registry lookup, shows an honest empty state for unknown
 * names (never fake content), and runs the shared <TipModal> tip flow with
 * its own in-frame wallet connect.
 *
 * Security: the embedding page is cross-origin, so it cannot read the
 * visitor's Voicescape session, wallet state, or anything inside the frame.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import TipModal from "@/components/TipModal";
import { WalletConnect } from "@/components/WalletConnect";
import { resolvePage } from "@/lib/contracts";
import { getActiveChain } from "@/lib/chains";
import { normalizeEmbedAmount, normalizeEmbedUsername } from "@/lib/embed";
import "../../embed.css";

type Status = "loading" | "found" | "missing" | "error";

function WidgetInner({ username }: { username: string }) {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status>("loading");
  // Remount the panel after a completed tip so "Done" returns to a fresh widget.
  const [cycle, setCycle] = useState(0);

  const name = normalizeEmbedUsername(username);
  const amount = normalizeEmbedAmount(
    searchParams.get("amount") == null ? null : Number(searchParams.get("amount")),
  );

  useEffect(() => {
    document.title = name ? `Tip @${name} on Voicescape` : "Tip on Voicescape";
  }, [name]);

  useEffect(() => {
    if (!name) {
      setStatus("missing");
      return;
    }
    let cancelled = false;
    // Existing registry lookup: the same guardrail the tip flow itself uses
    // before ever prompting a wallet signature.
    resolvePage(name, getActiveChain())
      .then((r) => {
        if (!cancelled) setStatus(r ? "found" : "missing");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (status === "loading") {
    return (
      <div className="embed-shell">
        <div className="embed-card">
          <div className="embed-spinner" role="status" aria-label="Loading" />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="embed-shell">
        <div className="embed-card">
          <div className="embed-empty">
            <h2>Couldn't reach the network</h2>
            <p>Check your connection and refresh the page to try again. No tip was sent.</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "missing" || !name) {
    return (
      <div className="embed-shell">
        <div className="embed-card">
          <div className="embed-empty">
            <h2>We couldn't find @{username}</h2>
            <p>
              This tip button points to a Voicescape page that doesn't exist. Check the
              spelling, or ask the creator for their correct link. Nothing was charged.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="embed-shell">
      <div className="embed-card">
        <div className="embed-brand">
          <span className="embed-brand-dot" aria-hidden="true" />
          Voicescape
        </div>
        <h1 className="embed-who">Tip @{name}</h1>
        <p className="embed-sub">
          Tips settle on Hedera in one transaction — <strong>they keep 98%</strong> of
          every tip, sent straight to their wallet.
        </p>
        <div className="embed-connect">
          <WalletConnect />
        </div>
        <TipModal
          key={cycle}
          author={name}
          onClose={() => setCycle((c) => c + 1)}
          inline
          initialAmount={amount ?? undefined}
        />
        <p className="embed-foot">
          Secured by Hedera ·{" "}
          <a href={`/${name}`} target="_blank" rel="noopener noreferrer">
            View @{name}&apos;s blockpage
          </a>
        </p>
      </div>
    </div>
  );
}

export default function EmbedTipWidget({ username }: { username: string }) {
  return (
    <Suspense
      fallback={
        <div className="embed-shell">
          <div className="embed-card">
            <div className="embed-spinner" role="status" aria-label="Loading" />
          </div>
        </div>
      }
    >
      <WidgetInner username={username} />
    </Suspense>
  );
}
