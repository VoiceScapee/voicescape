# Voicescape — Mainnet Launch Checklist

**Target:** Hedera mainnet · **Budget:** ~$15–20 of HBAR, one time · **Ongoing cost:** $0
**Scope:** block pages + on-chain tipping (98/2), town hall (forum/chat/polls/
marketplace with atomic direct sales — no escrow), agent pages + hire-an-agent
directory, x402 pay-per-request rail. Full hosting plan (all $0): see `DEPLOY_FREE.md`.

Nothing deploys until Brandon says "go" after reviewing the deploy plan.
The deploy script refuses mainnet without `CONFIRM_MAINNET=1` (env var —
hardhat rejects unknown CLI flags), and `DRY_RUN=1` validates config
spend-free before anything touches the network.

---

## BRANDON'S STEPS (phone)

Do these in order. The exchange/KYC step takes days — start it first.

- [ ] **1. Buy ~$15–20 of HBAR.** Any major exchange (Coinbase, Binance.US, etc.).
  This is the only money the project ever needs. (~$0.20 per contract deploy,
  ~$0.05 per account, cents for everything else — $20 is a comfort margin.)
- [ ] **2. Install HashPack** (mobile) and create a **brand-new, separate**
  deployer account. Do NOT use the wallet holding your main funds.
- [ ] **3. Send the HBAR** to the new deployer account.
- [ ] **4. Decide the treasury address** — the wallet collecting the 2% fee on
  every tip. Can be the deployer account or a different wallet. (It can be
  changed later via `setTreasury`, but decide before deploy.)
- [ ] **5. Create the GitHub repo** (for hosting): github.com → new repository,
  name it `voicescape`, **Public**, no README. Send me the URL.
- [ ] **6. Free API keys** (all free tiers, 5 minutes each):
  - Pinata (pinata.cloud) → API key / JWT — pins page content to IPFS.
  - WalletConnect (cloud.walletconnect.com) → Project ID — wallet connections.
  - **Upstash (upstash.com) → free Redis database → REST URL + token** —
    this is what makes sign-ins, quotas and anti-spam work across all of
    the app's server instances (without it, limits reset on every restart).
    Setup: upstash.com → "Create Database" (free tier, pick any region) →
    copy the **REST URL** and **REST TOKEN** → paste both into the hosting
    env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).
    Free tier: 500k commands/month, 256 MB, no credit card. If you make a
    temporary no-signup database, claim it within 3 days or it's deleted.
- [ ] **7. Hand me the deployer key via the Secure Vault** (I'll send the secure
  card when we're ready). NEVER paste keys in chat. The vault goes straight to
  secure storage — I never see the value, I only use it to sign the deploy.

## DANNY'S STEPS (already prepped, executed on your "go")

- [x] Contracts reviewed for mainnet (Paris EVM, no testnet-isms, treasury configurable).
- [x] Deploy script hardened: `contracts/scripts/deploy.js` — writes every
  deployment to `contracts/deployments/<network>.json`, refuses mainnet
  without `CONFIRM_MAINNET=1`, and `DRY_RUN=1` validates the config
  spend-free (tested 2026-09-10: dry-run prints the plan and exits without
  keys, network calls, or files written).
- [x] Frontend mainnet config: `frontend/.env.production.example` — chain key,
  contract addresses, RPC, IPFS, keys, quotas. Frontend already supports `hedera-mainnet`.
- [ ] **Deploy day:** run `DRY_RUN=1` first, then deploy on `hederaMainnet`
  with your treasury address, verify both contracts (Registry, Tips)
  on HashScan, wire the addresses into the frontend env.
- [ ] **Hosting:** follow `DEPLOY_FREE.md` — frontend on Vercel (free), x402
  service on Render (free), self-hosted facilitator on Vercel (free). Set the
  production env vars per the tables there, INCLUDING the three new
  required-for-production ones: `APP_ORIGIN` (your public URL — phishing
  protection for wallet sign-in), `SESSION_SECRET` (`openssl rand -hex 32` —
  signs the 7-day session tokens), and the Upstash pair
  (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — shared quotas and
  replay protection across instances). Without the Upstash pair the app
  still runs, but limits reset on restart and don't apply across instances.
- [ ] **Smoke test:** run the post-deploy checklist in `DEPLOY_FREE.md`
  (wallet login, page publish, tip with 98/2 split, forum/chat, marketplace
  direct-sale purchase, agent directory, 402 handshake).

## AFTER LAUNCH

- Phase B: agent pages + storefronts, x402 pay-per-request rail, USDC payments.
- Phase C: the Yellow Pages (directory + proof-of-payment reputation + referrals).
- Multi-coin "tip me in any coin" panel (your address list is saved and spec'd).
