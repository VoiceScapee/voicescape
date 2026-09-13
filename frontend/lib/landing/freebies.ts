/**
 * Community-pulse free shelf — VERIFIED free Hedera opportunities only.
 *
 * Rules (Brandon's standing orders + FBI/IC3 PSA 2025-603 phishing warning):
 * - Link ONLY official URLs. Never aggregate third-party "free mint" links.
 * - An offer past its `endsAt` never renders as claimable — the card flips
 *   to a "check the latest drops" state instead of disappearing silently.
 * - Unverified or maybe-live offers are NOT listed here. Ever.
 *
 * Verified live 2026-09-13 (collectibles.mclaren.com):
 * - McLaren MCL/COLLECT — official McLaren Racing collectibles platform on
 *   Hedera; 2026 ESP GP featured drop, "Claim Price FREE", countdown showed
 *   ~2d 3h remaining → drop ends ~midday Sep 15, 2026 ET. `endsAt` matches
 *   that observed window; the card flips to "see current drops" after.
 * - Hedera testnet faucet (portal.hedera.com) — free testnet HBAR, ongoing.
 */

import type { I18nKey } from "@/lib/i18n/dictionaries";

export interface Freebie {
  id: string;
  /** Proper noun — same in every language. */
  name: string;
  descKey: I18nKey;
  ctaKey: I18nKey;
  expiredCtaKey: I18nKey;
  url: string;
  /** ISO date after which the drop is no longer shown as claimable. */
  endsAt: string | null;
  tag: "nft" | "builder";
}

export const FREEBIES: Freebie[] = [
  {
    id: "mclaren-collect",
    name: "McLaren MCL / COLLECT",
    descKey: "landing.freeMclarenDesc",
    ctaKey: "landing.freeMclarenCta",
    expiredCtaKey: "landing.freeMclarenExpiredCta",
    url: "https://collectibles.mclaren.com/",
    endsAt: "2026-09-15T12:00:00-04:00",
    tag: "nft",
  },
  {
    id: "hedera-faucet",
    name: "Hedera Testnet Faucet",
    descKey: "landing.freeFaucetDesc",
    ctaKey: "landing.freeFaucetCta",
    expiredCtaKey: "landing.freeFaucetCta",
    url: "https://portal.hedera.com/",
    endsAt: null,
    tag: "builder",
  },
];

export interface Showcase {
  name: string;
  descKey: I18nKey;
  url: string;
}

/** Real Hedera projects worth knowing — showcased, NOT free claims. */
export const SHOWCASE: Showcase[] = [
  { name: "HashPack", descKey: "landing.showHashpack", url: "https://www.hashpack.app/" },
  { name: "SaucerSwap", descKey: "landing.showSaucer", url: "https://www.saucerswap.finance/" },
];
