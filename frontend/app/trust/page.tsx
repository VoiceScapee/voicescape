import type { Metadata } from "next";
import ExternalLink from "@/components/ExternalLink";

export const metadata: Metadata = {
  title: "Trust — Voicescape",
  description:
    "Why Voicescape is trustworthy: Sourcify-verified contracts, the 98/2 split enforced on-chain, Hedera's ABFT finality and council governance, and non-custodial design. Verify everything yourself.",
};

const REGISTRY_ID = "0.0.10854058";
const TIPS_ID = "0.0.10854060";
const TREASURY_ID = "0.0.10424063";
const contractUrl = (id: string) => `https://hashscan.io/mainnet/contract/${id}`;

const section: React.CSSProperties = { marginBottom: 28 };
const h2: React.CSSProperties = { fontSize: 19, margin: "0 0 8px" };
const p: React.CSSProperties = { color: "var(--vs-muted)", lineHeight: 1.6, margin: "0 0 8px" };
const mono: React.CSSProperties = {
  fontFamily: "var(--vs-mono, monospace)",
  fontSize: 13,
  wordBreak: "break-all",
};

export default function TrustPage() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "32px 20px 64px",
      }}
    >
      <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Trust, verified</h1>
      <p style={{ ...p, marginBottom: 32 }}>
        Don&apos;t take our word for any of this. Every claim below links to
        the public record — the ledger, the contract source, the explorer.
      </p>

      <section style={section}>
        <h2 style={h2}>The 98/2 split is enforced by code, not promises</h2>
        <p style={p}>
          Every tip and marketplace purchase is a single atomic contract call:
          98% goes to the creator, 2% to the treasury, in the same transaction.
          There is no step where the split could be &quot;adjusted&quot; later —
          the contract settles both legs at once or the whole thing reverts.
        </p>
        <p style={p}>
          Both contracts are Sourcify-verified, so the exact source code
          running on mainnet is public and readable:
        </p>
        <ul style={{ ...p, paddingLeft: 20 }}>
          <li>
            <span style={mono}>Registry {REGISTRY_ID}</span> —{" "}
            <ExternalLink href={contractUrl(REGISTRY_ID)}>
              view on HashScan
            </ExternalLink>
          </li>
          <li>
            <span style={mono}>Tips {TIPS_ID}</span> —{" "}
            <ExternalLink href={contractUrl(TIPS_ID)}>view on HashScan</ExternalLink>
          </li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={h2}>We never hold your money</h2>
        <p style={p}>
          Voicescape is non-custodial by design. There is no escrow contract
          and no platform balance: funds move directly from the buyer&apos;s
          wallet to the seller&apos;s wallet and the treasury (
          <span style={mono}>{TREASURY_ID}</span>) in one transaction. We only
          ever receive the 2% fee we are paid — we cannot lose, freeze, or
          redirect your funds because we never touch them.
        </p>
      </section>

      <section style={section}>
        <h2 style={h2}>Finality you can put a timestamp on</h2>
        <p style={p}>
          Hedera reaches consensus with ABFT — the strongest standard in
          distributed systems — and finalizes transactions in about 3–5
          seconds. Every receipt on Voicescape shows the network-assigned
          consensus timestamp: the exact moment the whole network agreed your
          transaction settled. Not our server&apos;s clock, not your
          device&apos;s clock — the ledger&apos;s.
        </p>
      </section>

      <section style={section}>
        <h2 style={h2}>A network that can&apos;t fork under you</h2>
        <p style={p}>
          Hedera is governed by a council of global organizations on rotating,
          term-limited seats — no single company, miner group, or validator
          set can split the network or rewrite its rules unilaterally. Your
          page, your tips, and your history live on one canonical ledger.
        </p>
      </section>

      <section style={section}>
        <h2 style={h2}>Fees that stay tiny</h2>
        <p style={p}>
          Network fees on Hedera are fixed in USD and cost a fraction of a
          cent (~$0.0001) — they don&apos;t spike when the network gets busy.
          That&apos;s what makes micro-tips and AI-agent commerce practical
          here. Our fee is a flat 2%, quoted in USD so the price you see is
          the price you pay.
        </p>
      </section>

      <section style={section}>
        <h2 style={h2}>Carbon-neutral transactions</h2>
        <p style={p}>
          Hedera&apos;s proof-of-stake network uses a tiny fraction of the
          energy of proof-of-work chains, and Hedera offsets its carbon
          footprint. Transacting on Voicescape is carbon-neutral.
        </p>
      </section>

      <section style={section}>
        <h2 style={h2}>Fair ordering, provably</h2>
        <p style={p}>
          Wherever order matters — leaderboard ties, referral races, poll
          tallies — we break ties by Hedera consensus timestamp: the order
          the network itself assigned. Nobody at Voicescape can reorder it,
          which means nobody can rig it.
        </p>
      </section>

      <p style={{ ...p, marginTop: 36, fontSize: 13 }}>
        Found something that doesn&apos;t check out? Tell us — the whole
        point of this page is that you don&apos;t have to trust us.
      </p>
    </main>
  );
}
