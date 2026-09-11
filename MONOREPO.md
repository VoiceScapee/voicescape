# Voicescape Monorepo

Modular Hedera-native architecture (Brandon's directive, 2026-09-11).

## Layout

```
voicescape/
├── apps/               # Future app shells (web, admin, marketplace)
├── packages/
│   ├── wallet/         # ✅ @voicescape/wallet — HashPack/Blade/WC + MetaMask
│   ├── contracts/      # ✅ @voicescape/contracts — ABIs, addresses, TxSenders
│   ├── ui/             # ✅ @voicescape/ui — Logo, Splash, icons, PWA button
│   ├── analytics/      # Scaffold — mirror-node dashboards, referrals
│   ├── storage/        # Scaffold — IPFS + HCS anchoring
│   ├── search/         # Scaffold — page/agent search, Yellow Pages
│   └── ai/             # Scaffold — BYOK/x402, voice-to-page, agent tx builder
├── smart-contracts/
│   ├── registry/       # VoicescapeRegistry.sol
│   ├── marketplace/    # (design doc — buyListing lives in tips/)
│   ├── tips/           # VoicescapeTips.sol (98/2 atomic splitter)
│   └── rewards/        # Planned — referral/badge rewards
├── database/           # Planned — PostgreSQL schema (not yet needed)
├── services/           # Planned — mirror-node, ipfs, indexing, notifications, i18n
├── contracts/          # Authoritative Hardhat project (build/test/deploy)
└── frontend/           # Production monolith (deployed to Vercel, untouched)
```

## Status

**Phase 1 complete (2026-09-11):** three packages extracted from the
production monolith, all TypeScript-clean:

| Package | Source | Lines |
|---|---|---|
| `@voicescape/wallet` | `frontend/lib/wallet.tsx` + `lib/chains.ts` | ~550 |
| `@voicescape/contracts` | `frontend/lib/tx.ts` + `lib/contracts.ts` | ~550 |
| `@voicescape/ui` | `frontend/components/` (5 presentational) | ~580 |

The extraction is **additive**: `frontend/` is untouched and still deployed.
The packages are not yet consumed by any app.

## Key design decisions

- **The ~2.3MB `@hashgraph/sdk` is never statically imported** by
  `@voicescape/wallet`. The concrete `TxSender` factories live in
  `@voicescape/contracts` and are dynamically imported only when signing —
  preserving the mobile ChunkLoadError fix.
- **`TxSender` is the package boundary.** Wallet connection
  (`@voicescape/wallet`) knows nothing about transaction construction;
  `@voicescape/contracts` knows nothing about React.
- **`smart-contracts/` is the canonical source layout**; `contracts/` remains
  the Hardhat project that actually compiles/deploys (keep in sync during
  transition).
- **No Postgres yet.** Current storage (HCS + IPFS + Upstash Redis free
  tier) is sufficient; a database is added only when relational queries
  become a real bottleneck.

## Next steps

1. **Phase 2:** point `frontend/` imports at the workspace packages and
   verify 1:1 behavior (tests + build + deploy).
2. **Phase 3:** move `frontend/` → `apps/web/`, update Vercel root dir.
3. **Phase 4:** extract `@voicescape/storage`, `@voicescape/analytics`,
   `@voicescape/ai`, `@voicescape/search` from the monolith.
4. **Phase 5:** `apps/admin` dashboard on existing moderation APIs.

## Commands

```bash
# Install workspace deps (does NOT touch frontend/ — it has its own lockfile)
npm install

# Typecheck all packages
npm run typecheck --workspaces --if-present
```
