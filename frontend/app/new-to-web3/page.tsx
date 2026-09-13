/**
 * "New to Web3? Start here" — its own page, linked from the navbar.
 *
 * The plain-language dApp explainer (what a dApp is, wallet-as-login, why
 * Hedera fees are pennies) gets a dedicated, linkable home so new users can
 * find it without scrolling the landing page. Reuses the landing section
 * component so the copy stays in one place.
 */
import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { NewToWeb3 } from "@/components/landing/NewToWeb3";

export const metadata: Metadata = {
  title: "New to Web3? Start here — Voicescape",
  description:
    "Crypto explained like a human: what a dApp is, why your wallet is your login, and why Hedera keeps fees at pennies, not dollars.",
};

export default function NewToWeb3Page() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--vs-bg)" }}>
      <Navbar right={<WalletConnect />} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 18px 72px" }}>
        <NewToWeb3 />
      </div>
    </main>
  );
}
