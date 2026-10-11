"use client";

/**
 * SignatureEffectNotice — names the ledger-side effect a wallet signature moves.
 *
 * Adopted from thechomps' failure-patterns rule: "each signature should name
 * the ledger-side effect it moves." A real incident: two wallet prompts that
 * looked identical (session login vs claim registration) — the human saw
 * "done" after the login signature and thought the claim went through. It
 * hadn't; the login moves nothing on-ledger.
 *
 * Every signing prompt pairs an optional step indicator (when the signature
 * is sequenced, e.g. "Signature 1 of 2"), a plain-language title, and a
 * one-line effect statement. Status language follows bothireagent's rule:
 * the session login is PRECONDITION_MET (never "done"); the claim / update /
 * purchase is DONE only when the chain confirms.
 */

export interface SignatureEffectSpec {
  /** e.g. "Signature 1 of 2" — omit for standalone (unsequenced) prompts. */
  step?: string;
  /** Plain-language title, e.g. "Session login". */
  title: string;
  /** One line naming the ledger-side effect, in human words. */
  effect: string;
}

/** Standalone session login — the only signature (no sequencing). */
export const SESSION_LOGIN_EFFECT: SignatureEffectSpec = {
  title: "Session login",
  effect:
    "Proves you own this wallet and signs you in for 7 days. Sends 1 tinybar to yourself — changes nothing else on-chain.",
};

/**
 * Signature 1 of 2 in a claim/approval ceremony: the session login that
 * fires automatically after the wallet connects. Explicitly NOT the action.
 */
export function approvalLoginEffect(actionNoun: string): SignatureEffectSpec {
  return {
    step: "Signature 1 of 2",
    title: "Session login",
    effect: `Signs you in for 7 days. Sends 1 tinybar to yourself — changes nothing on-chain. This is not the ${actionNoun}.`,
  };
}

/** Signature 2 of 2 — the blockpage claim registration. */
export function claimRegistrationEffect(username: string): SignatureEffectSpec {
  return {
    step: "Signature 2 of 2",
    title: "Claim registration",
    effect: `Registers @${username} on the Hedera registry contract. This is the one that makes it yours.`,
  };
}

/** Signature 2 of 2 — a blockpage content update. */
export function pageUpdateEffect(username: string): SignatureEffectSpec {
  return {
    step: "Signature 2 of 2",
    title: "Page update",
    effect: `Points @${username}'s on-chain record at the new content. Nothing else changes.`,
  };
}

/** Signature 2 of 2 — a marketplace purchase. */
export function purchaseEffect(itemTitle: string, amountHbar: string): SignatureEffectSpec {
  return {
    step: "Signature 2 of 2",
    title: "Purchase",
    effect: `Pays ${amountHbar} HBAR for "${itemTitle}" — the Tips contract splits it 98% to the seller, 2% to the platform, atomically.`,
  };
}

export function SignatureEffectNotice({ spec }: { spec: SignatureEffectSpec }) {
  return (
    <div
      role="note"
      aria-label={`${spec.step ? `${spec.step} — ` : ""}${spec.title}: ${spec.effect}`}
      style={{
        border: "1px solid rgba(180,92,240,.45)",
        borderRadius: 12,
        padding: "12px 14px",
        background: "rgba(123,63,242,.08)",
        marginBottom: 12,
      }}
    >
      {spec.step && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#b45cf0",
            marginBottom: 4,
          }}
        >
          {spec.step}
        </div>
      )}
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>{spec.title}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, opacity: 0.85 }}>{spec.effect}</div>
    </div>
  );
}
