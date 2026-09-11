# smart-contracts

Voicescape's Hedera smart contracts, organized per Brandon's architecture.

## Layout

```
smart-contracts/
├── registry/       # VoicescapeRegistry.sol — username → owner + IPFS hash
├── marketplace/    # Marketplace listings (implemented in tips/)
├── tips/           # VoicescapeTips.sol — 98/2 atomic tip splitter + buyListing
└── rewards/        # Future: referral/badge rewards (not yet designed)
```

## Deployed (Hedera mainnet, 2026-09-10)

| Contract | EVM address | Hedera ID |
|---|---|---|
| VoicescapeRegistry | `0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58` | 0.0.10854058 |
| VoicescapeTips | `0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0` | 0.0.10854060 |
| Treasury | `0x30c63dc43608b6764a6b8b53960553aebf306817` | 0.0.10424063 |

Both contracts are Sourcify-verified (chain 295).

## Build & deploy

The authoritative Hardhat project lives at `../contracts/` (build, test,
deploy scripts, deployment records). The `.sol` files here are the canonical
*source* layout; `../contracts/contracts/` is currently the same content.
During the refactor transition, keep both in sync — `../contracts/` is what
`npx hardhat` actually compiles and deploys.

## Economics invariant

`VoicescapeTips` splits every payment **98% to the recipient / 2% to the
treasury atomically in the same transaction**. There is no escrow — the
contract never holds user funds. `buyListing` (marketplace) uses the same
split: one tx, 98/2 to seller/treasury, zero retained balance.
