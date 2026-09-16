# Hedera Toolkit Brief — Voicescape's approved building blocks

**Standing rule:** Voicescape is built on official Hedera/Hiero libraries only.
No custom chain plumbing. No non-Hedera chain libraries. This page is the
single source of truth the deploy gate enforces (see `toolkit-map` check in
`~/workspace/ops/voice-engine/gate.sh`).

## Use these (proven pathways)

| Need | Approved piece |
|---|---|
| Wallet connection | `@hashgraph/hedera-wallet-connect` (DAppConnector, HIP-820) |
| Transactions, HCS, HTS, schedules | `@hiero-ledger/sdk` (a.k.a. `@hashgraph/sdk`) |
| Read-only chain verification (login sessions, tips, receipts) | Public Hedera mirror-node REST — free, no auth |
| EVM relay for the Tips contract | Hashio (free tier) |
| Chat / forum / activity feed | HCS topics |
| Marketplace items, badges, collectibles | HTS NFTs |
| Sign-in sessions | Wallet signs a 1-tinybar self-transfer with a login memo; verified server-side via mirror node. 7-day sessions. |
| Media (avatars, uploads, video) | IPFS/Arweave/Filecoin **off-chain**; content hashes anchored on Hedera |
| Small on-chain blobs (NFT metadata JSON, config snapshots) | HFS — small only |

`ethers` is allowed **only** as an EVM calldata decoder, never as a chain
connection. HBAR is the tipping rail in v1; USDC is the approved second rail
(Phase B).

## Do NOT use (gate blocks or flags these)

- **`xrpl` / `ripple-*` imports** — Hedera-only deploy gate. The XRP rail is
  parked until Brandon explicitly waives this (multi-rail = future work).
- **Stablecoin Studio** — parked for v1. Real proof-of-reserve is a banking
  commitment, not just code; HBAR + HTS covers tipping.
- **Hedera Guardian** — environmental-asset certification platform; wrong
  domain, heavy multi-service infra, breaks the $0-cost rule. If identity or
  credentials are ever needed, use DIDs + verifiable credentials via the
  SDK/HCS directly — never a Guardian deployment.
- **HFS for media** — 1,024 kB max file / 6 kB per tx makes avatars, images,
  and video impractical and expensive. Media lives off-chain. (HFS usage in
  code triggers a gate *advisory* — fine for small metadata, never for media.)
- **Non-Hedera chain libs** — `thirdweb`, `wagmi`, `web3`, `@solana/*`
  (already blocked by the `dep-sweep` gate check).
- **Paid tiers** — no paid RPC, mirror-node, or relay tiers. $0 ongoing cost
  is a hard constraint; mainnet only.

## Later, not now

- Scheduled transactions / HSS (recurring tips, vesting)
- Token allowances for recurring payments
- Guardian *patterns* (policy/audit ideas), never the platform

Full research: `~/workspace/research_notes/hedera-toolkit-for-voicescape-20260916-0140/report.md`
Map artifact: the **Hedera Toolkit Map** web artifact.
