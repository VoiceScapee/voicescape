/**
 * BringCryptoChecklist — "use what you hold" onboarding helper.
 *
 * Shown in the blockpage tip panel's Token mode when the connected wallet
 * holds no tokens yet. Plain words, no jargon: bridge -> associate ->
 * keep HBAR for gas. The dapp never moves tokens across chains itself —
 * it links out to the user's own bridge UI (non-custodial, $0 cost to us).
 *
 * Research basis (2026-09-28): Circle CCTP no longer supports Hedera and
 * HashPort is decommissioned, so the only live routes are Axelar (Squid /
 * SaucerSwap bridge UI) and LayerZero (Stargate). Bridged USDC arrives as
 * a wrapped token, which tips fine through the Token-mode swap path, so
 * visitors don't need native Hedera USDC to tip.
 */

const BRIDGE_URL = "https://www.saucerswap.finance/bridge";
const SAUCERSWAP_URL = "https://www.saucerswap.finance";

export default function BringCryptoChecklist() {
  return (
    <div
      className="pv-bring-crypto"
      style={{
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "14px 16px",
        lineHeight: 1.6,
      }}
    >
      <p style={{ margin: "0 0 4px", fontWeight: 700 }}>
        Bring your crypto to Hedera
      </p>
      <p className="th-muted" style={{ margin: "0 0 10px", fontSize: "0.85rem" }}>
        Your tokens live on another network? Three quick steps and you can
        tip with them here.
      </p>
      <ol style={{ margin: 0, paddingLeft: 20, fontSize: "0.85rem" }}>
        <li style={{ marginBottom: 8 }}>
          <strong>Move it to Hedera.</strong>{" "}
          <span className="th-muted">
            Use SaucerSwap&apos;s bridge to move tokens from networks like
            Ethereum or Solana to Hedera. It takes a few minutes, and you pay
            a small fee on the network you&apos;re leaving.{" "}
            <a
              href={BRIDGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "underline" }}
            >
              Open the bridge
            </a>
          </span>
        </li>
        <li style={{ marginBottom: 8 }}>
          <strong>Tap to receive it.</strong>{" "}
          <span className="th-muted">
            In HashPack, tap the new token to accept it. Until you do, it
            stays invisible and can&apos;t be used.
          </span>
        </li>
        <li style={{ marginBottom: 8 }}>
          <strong>Keep about $1 of HBAR.</strong>{" "}
          <span className="th-muted">
            Every action on Hedera costs a tiny network fee, paid in HBAR.
            Short on HBAR?{" "}
            <a
              href={SAUCERSWAP_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "underline" }}
            >
              Swap a little on SaucerSwap
            </a>
            .
          </span>
        </li>
      </ol>
      <p
        className="th-muted"
        style={{ margin: "10px 0 0", fontSize: "0.85rem" }}
      >
        Then come back and pick <strong>Token</strong> above — anything with
        a trade route works for tipping, and 98% still goes to the creator.
      </p>
    </div>
  );
}
