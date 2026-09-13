/**
 * Curated Mining & DePIN showcase — trusted and verified.
 *
 * Every entry below was checked live on 2026-09-13: homepage resolves
 * (HTTP 200), project is active in 2026, red flags researched. Notes on
 * controversies are included where found — "trusted" doesn't mean flawless.
 * Re-verify on a schedule to keep the "verified" promise honest.
 *
 * Referral links are Brandon's own. `referralUrl: null` means he hasn't
 * provided one yet — the UI falls back to the plain official link, and the
 * referral disclosure only shows when at least one referral link exists.
 * `referralProgram` describes the project's public program (if any) so the
 * UI can flag it even before Brandon wires in his link.
 */
export interface MiningDePinProject {
  id: string;
  name: string;
  category: "mining" | "depin";
  /** Official site — verified live. */
  url: string;
  /** Brandon's referral link for this project, or null until he provides it. */
  referralUrl: string | null;
  /** The project's public referral program (if one was verified), else null. */
  referralProgram: string | null;
  /** Short tagline (English). */
  tagline: string;
  /** 1–2 line description (English). */
  description: string;
  /** Why it's trusted — the verification evidence, warts included (English). */
  whyTrusted: string;
  /** ISO date of last verification, e.g. "2026-09-13". */
  verifiedAt: string;
}

export const MINING_DEPIN_PROJECTS: MiningDePinProject[] = [
  // ------------------------------- MINING -------------------------------
  {
    id: "kryptex",
    name: "Kryptex",
    category: "mining",
    url: "https://pool.kryptex.com",
    referralUrl: null,
    referralProgram: "20% of pool fee to referrer — Affiliates tab on the pool site.",
    tagline: "Mine LTC and get paid in BTC",
    description:
      "Mining pool Brandon uses himself — point your ASIC or GPU at it and earn Litecoin, paid out in Bitcoin.",
    whyTrusted:
      "Brandon mines LTC here daily. Launched the “Pearl” pool June 2026; public no-auth pool API.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "nicehash",
    name: "NiceHash",
    category: "mining",
    url: "https://www.nicehash.com",
    referralUrl: null,
    referralProgram: "Partner Program — 15% of mining fees in BTC (geared to companies/hosting firms).",
    tagline: "The hashpower marketplace",
    description:
      "Buy or sell hashpower since 2014 — the oldest running marketplace for mining power, surviving multiple cycles.",
    whyTrusted:
      "Operating since 2014; repaid users after the 2017 hack. 200th EasyMining solo BTC block mined July 2026.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "viabtc",
    name: "ViaBTC",
    category: "mining",
    url: "https://viabtc.com",
    referralUrl: null,
    referralProgram: "10% referral rewards (12 months) or 20% permanent via the Ambassador program.",
    tagline: "#1 in LTC/DOGE merged mining",
    description:
      "Top pool for Litecoin + Dogecoin merged mining, plus BTC, BCH and ZEC. 2M+ users, 10th anniversary in 2026.",
    whyTrusted:
      "10th anniversary campaign May 2026; #1 in LTC/DOGE merged mining; Stratum V2 working group member.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "f2pool",
    name: "F2Pool",
    category: "mining",
    url: "https://f2pool.com",
    referralUrl: null,
    referralProgram: null,
    tagline: "One of the oldest Bitcoin pools",
    description:
      "Running since 2013, holding ~11–15% of Bitcoin hashrate in 2026. A bedrock pool of the PoW era.",
    whyTrusted:
      "Operating since 2013. Note: Jan 2026 research showed F2Pool filtering OFAC-sanctioned transactions.",
    verifiedAt: "2026-09-13",
  },
  // -------------------------------- DEPIN -------------------------------
  {
    id: "helium",
    name: "Helium",
    category: "depin",
    url: "https://helium.com",
    referralUrl: null,
    referralProgram: "Helium Mobile “Refer a Friend” — for the carrier product, not hotspot earnings.",
    tagline: "The people's wireless network",
    description:
      "Run a hotspot, provide wireless coverage, earn HNT. The original DePIN — millions of hotspots deployed.",
    whyTrusted:
      "Q2 2026: $3.35M revenue, ~2.88M daily Mobile users. SEC case settled Apr 2025 — claims dismissed.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "render",
    name: "Render Network",
    category: "depin",
    url: "https://rendernetwork.com",
    referralUrl: null,
    referralProgram: null,
    tagline: "Decentralized GPU rendering",
    description:
      "Rent out your GPU for 3D rendering and AI workloads, earn RENDER. Real demand from artists and studios.",
    whyTrusted:
      "Founded by OTOY, live since 2020. RenderCon 2026 drew NVIDIA speakers; paying node operators for years.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "filecoin",
    name: "Filecoin",
    category: "depin",
    url: "https://filecoin.io",
    referralUrl: null,
    referralProgram: null,
    tagline: "Decentralized storage network",
    description:
      "Provide hard-drive space, earn FIL for storing real client data. Exabytes of capacity on the network.",
    whyTrusted:
      "Mainnet since 2020; RetroPGF Round 3 paid 500K FIL to 91 builder projects (Jan 2026).",
    verifiedAt: "2026-09-13",
  },
  {
    id: "akash",
    name: "Akash Network",
    category: "depin",
    url: "https://akash.network",
    referralUrl: null,
    referralProgram: null,
    tagline: "Decentralized cloud compute",
    description:
      "Rent out spare server capacity — or buy compute far cheaper than AWS. Earn AKT as a provider.",
    whyTrusted:
      "Live since 2021, open-source. BME upgrade live Mar 2026 — AKT burned on every compute transaction.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "hivemapper",
    name: "Hivemapper (Bee Maps)",
    category: "depin",
    url: "https://hivemapper.com",
    referralUrl: null,
    referralProgram: "Official referral program exists — 2026 terms being re-verified (rewards moved to USDC).",
    tagline: "Drive and map the world",
    description:
      "Mount a dashcam, contribute street-level imagery, earn crypto. A decentralized Google Street View — now Bee Maps.",
    whyTrusted:
      "Raised $32M Oct 2025; enterprise customers (VW, Lyft, Mapbox); USDC driver-rewards beta July 2026.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "ionet",
    name: "io.net",
    category: "depin",
    url: "https://io.net",
    referralUrl: null,
    referralProgram: null,
    tagline: "Decentralized GPU cloud for AI",
    description:
      "Aggregate GPUs into a cloud for AI training and inference. One of the biggest DePIN compute plays on Solana.",
    whyTrusted:
      "Recovered from 2024–25 setbacks: new tokenomics June 2026 (50% of revenue burned in $IO), earnings trending up.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "dimo",
    name: "DIMO",
    category: "depin",
    url: "https://dimo.org",
    referralUrl: null,
    referralProgram: null,
    tagline: "Earn from your car's data",
    description:
      "Plug in a device, share your vehicle's data, earn DIMO. Your car data finally pays you, not the dealer.",
    whyTrusted:
      "~180K connected vehicles; Japan DePIN venture launched June 2026. Note: the token drew down hard in 2026.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "grass",
    name: "Grass",
    category: "depin",
    url: "https://getgrass.io",
    referralUrl: null,
    referralProgram: "In-app referrals — Referrals tab in the dashboard after signup.",
    tagline: "Share bandwidth, earn crypto",
    description:
      "Share your unused internet bandwidth, earn rewards. Stage 2 payouts went out in USDC in July 2026.",
    whyTrusted:
      "$33M annualized revenue reported July 2026. Note: the Oct 2024 airdrop was controversial.",
    verifiedAt: "2026-09-13",
  },
  {
    id: "geodnet",
    name: "GEODNET",
    category: "depin",
    url: "https://geodnet.com",
    referralUrl: null,
    referralProgram: null,
    tagline: "Precision GPS on blockchain",
    description:
      "Run a GNSS station, contribute centimeter-accurate positioning data, earn GEOD. 20K+ stations worldwide.",
    whyTrusted:
      "GEOD spot-trading on Coinbase since June 2026; $2.1M/quarter token burn (80% of revenue).",
    verifiedAt: "2026-09-13",
  },
  {
    id: "nosana",
    name: "Nosana",
    category: "depin",
    url: "https://nosana.com",
    referralUrl: null,
    referralProgram: null,
    tagline: "GPU inference marketplace",
    description:
      "Rent out your GPU for AI inference jobs, earn NOS. Built for the inference side of the AI boom.",
    whyTrusted:
      "Monthly newsletters through Aug 2026; third parties verified renting GPUs on the network.",
    verifiedAt: "2026-09-13",
  },
];
