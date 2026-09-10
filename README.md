# Voicescape — MySpace-style block pages with on-chain tips

**Status: MVP wired end-to-end.** Contracts compile, all 10 tests pass,
frontend typechecks and `next build` succeeds. Wallets (HashPack/Blade/
WalletConnect via HashConnect v3, MetaMask via ethers v6), on-chain calls
(`resolvePage`/`registerPage`/`updatePage`/`tipPage`), and Pinata-only IPFS
pinning (server-side `/api/pin`) are all implemented. Nothing was deployed
anywhere, and no real keys exist in this repo.

## Architecture

```
┌──────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Builder    │      │   /api/vibecode  │      │    IPFS         │
│  (Next.js)   │─────▶│  (Anthropic API) │      │ (Pinata-only)   │
│ template +   │ JSON │  NL instruction  │      │  page content   │
│ AI chat edit │◀─────│  → page JSON     │      │  via /api/pin   │
└──────┬───────┘      └──────────────────┘      └────────┬────────┘
       │  publish: pin JSON → registerPage()             │
       ▼                                                 │
┌────────────────────────────────────────────────────────┴────────┐
│  Hedera (primary) / Polygon (fallback) — EVM smart contracts    │
│                                                                  │
│  VoicescapeRegistry:  username → (owner wallet, IPFS hash)       │
│  VoicescapeTips:      tipPage(username) payable                  │
│                       98% → page owner, 2% → treasury (on-chain) │
└──────────────────────────────────────────────────────────────────┘
       ▲                                                 │
       │  /[username]: resolvePage() → fetch IPFS → render + Tip button
┌──────┴───────┐
│ Public page  │
│  (Next.js)   │
└──────────────┘
```

**Key design decision:** page *content* lives on IPFS; the chain stores only a
registry mapping `username → owner wallet → IPFS content hash`. Putting full
page HTML on-chain would be cost-prohibitive. Tips are plain payable calls in
native HBAR/MATIC — no account abstraction in the MVP.

## Repo layout

```
voicescape/
├── contracts/          # Solidity + Hardhat
│   ├── contracts/VoicescapeRegistry.sol
│   ├── contracts/VoicescapeTips.sol
│   ├── scripts/deploy.js      # refuses mainnet without CONFIRM_MAINNET=1; DRY_RUN=1 validates spend-free
│   └── test/voicescape.test.js
├── frontend/           # Next.js App Router + TypeScript
│   ├── app/page.tsx               # landing
│   ├── app/builder/page.tsx       # template picker + editor + vibecode chat + publish
│   ├── app/[username]/page.tsx    # public page + tip button
│   ├── app/api/pin/route.ts       # server-side Pinata pinning (JWT never in browser)
│   ├── app/api/vibecode/route.ts  # Anthropic-backed page editor
│   ├── components/PageRenderer.tsx
│   └── lib/ (schema, templates, wallet, chains, contracts, ipfs, tx,
│             server/publish.js)
├── ipfs/               # IPFS strategy notes (live code lives in frontend/lib/server)
├── README.md
└── .env.example        # every variable, documented, no real values
```

## Transaction wiring

All on-chain calls go through `frontend/lib/tx.ts`, a `TxSender` abstraction
with two implementations:

- **EVM** (MetaMask, Polygon): ethers v6 — read-only `JsonRpcProvider` for
  `resolvePage`, signer for `registerPage`/`updatePage`/`tipPage`.
- **Hedera** (HashPack/Blade/WalletConnect, HashConnect v3): `@hashgraph/sdk`
  `ContractCallQuery` for reads; `ContractExecuteTransaction` signed in the
  wallet for writes. Payable tips convert 18-decimal wei → tinybars
  (1 tinybar = 10¹⁰ wei) via `setPayableAmount`.

`frontend/lib/contracts.ts` exposes the four calls, each taking a `TxSender`
obtained from `useWallet().getTxSender()` — no hidden global state.

## Setup

```bash
# 1. Contracts
cd contracts && npm install

# 2. Frontend
cd ../frontend && npm install

# 3. Copy and fill env (see .env.example — never commit real keys)
cp ../.env.example ../.env   # then edit; or per-directory .env files
```

## Contracts: compile, test, deploy

```bash
cd contracts
npx hardhat compile          # ✅ verified: 2 files, evm target paris
npx hardhat test             # ✅ verified: 10/10 passing

# Deploy to Hedera TESTNET (needs testnet HBAR + DEPLOYER_PRIVATE_KEY + TREASURY_ADDRESS)
npx hardhat run scripts/deploy.js --network hederaTestnet

# Polygon Amoy testnet
npx hardhat run scripts/deploy.js --network polygonAmoy

# Mainnet is deliberately hard: the script REFUSES hederaMainnet/polygon
# without CONFIRM_MAINNET=1 (env var — hardhat rejects unknown CLI flags).
# DRY_RUN=1 validates the config spend-free first. Nothing here has ever been
# deployed to mainnet.
```

Solidity is pinned to `^0.8.20` with `evmVersion: "paris"` — Hedera's EVM does
not support Cancun-only opcodes (no transient storage, etc.).

## Frontend: run

```bash
cd frontend
npm run dev   # needs PINATA_JWT for pinning; contract addresses can stay empty
              # until deploy (calls throw clear errors until then).
              # The vibecode AI chat is BYOK: users bring their own Anthropic
              # API key in the builder — no server key needed.
```

Verified: `npx tsc --noEmit` clean, `next build` succeeds.

## What Brandon must provide (nothing here works in prod without these)

1. **Treasury wallet address** → `TREASURY_ADDRESS` (receives the 2% fee;
   changeable later via `setTreasury()` by the contract owner).
2. **Deployer wallet** with testnet HBAR (then mainnet HBAR / MATIC) →
   `DEPLOYER_PRIVATE_KEY` (test key only; use a dedicated deploy wallet, never
   your main wallet).
3. **Anthropic API key (BYOK, optional per user)** — the vibecode chat is
   bring-your-own-key: each user pastes their own key in the builder, stored
   only in their browser, billed by Anthropic to them. No server key needed.
   (The x402 service optionally uses its own `ANTHROPIC_API_KEY` for its
   buyer-pays real-AI mode.)
4. **Pinata JWT** → `PINATA_JWT` (server-side only) for IPFS pinning via
   `/api/pin`. Pinata-only by design — the sunset web3.storage fallback was
   removed rather than shipped unverified.
5. **WalletConnect project ID** → `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
   (free at cloud.reown.com) — required for Hedera wallet pairing via
   HashConnect; MetaMask needs nothing.

## Known limitations

- Hedera wallet pairing needs a real WalletConnect project ID; without it the
  Hedera adapters throw a clear setup error. MetaMask works with no setup.
- `/[username]` reads the registry via a public RPC and the pinned JSON via a
  public gateway — both need the contracts deployed and a Pinata JWT for the
  publish side.
- Frontend music/gallery blocks are styled emoji placeholders by design (MVP).
- The full visual redesign (splash screen, blockchain/MySpace reskin) is still
  ahead — this build is functionally wired with the scaffold UI.

## Suggested path to launch

1. Fill `.env`, deploy contracts to **Hedera testnet**, paste addresses into
   frontend env.
2. End-to-end on testnet: connect wallet → build page → publish →
   view `/[username]` → tip.
3. Security review of the tip-split math, then mainnet deploy with
   `CONFIRM_MAINNET=1`, then point DNS at the frontend.
