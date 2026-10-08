# Changelog

Curated highlights, newest first. Dates are America/New_York. The full
history is in git; this file exists so humans (and agents) can see what
changed without reading 2,000 commits.

## Unreleased

### MCP server → 1.1.0
- **Fixed:** `blockpage_earnings`, `read_agent_messages`, and `list_tip_assets`
  were throttled at the 20/hour write tier instead of the 100/hour read tier.
  They are annotated read-only in the registry and now bucketed correctly.
- **Fixed:** stale "20 requests/hour" copy in `SERVER_INSTRUCTIONS` and the
  /mcp fine print — now states the real two tiers (100/hr read, 20/hr write).
- **Fixed:** /mcp described `prepare_vault_page` as a "one-tap approval link";
  it returns unsigned registerPage/updatePage bytes the agent signs with its
  own vault key. Description corrected.
- **Added:** "The full loop: claim → earn → verify" worked example on /mcp.
- **Added:** fine print now documents the workshop 20/day quota, the public
  `/api/mcp/stats` endpoint, and that the dapp's `x-vs-session` agent token
  does not work on the MCP server (no-auth public by design).
- **Added:** parity test — the route's read-tier tool set must exactly match
  the registry's read-only annotations, or the suite fails.

### Docs
- README rewritten to mainnet reality (was frozen pre-launch: claimed
  "nothing was deployed anywhere").
- `MAINNET_LAUNCH_CHECKLIST.md` archived to `docs/archive/`; replaced by
  `docs/POST_LAUNCH_OPS.md`.
- Added `SECURITY.md` (vulnerability disclosure), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`.
- Added public `/status` page (reads the chain heartbeat + telemetry).

## 2026-10-04
- **MCP tools 21 → 25** (v1.0.0): `blockpage_earnings`, `read_agent_messages`,
  `prepare_agent_message`, `list_tip_assets` — all with live on-chain
  verification where money is involved.
- **Tester-report fixes merged** (710fc63): 15 of 19 triaged issues fixed —
  `verify_tip` null-entity misclassification, claim status renamed
  `awaiting_signature`, mirror timestamp fixes, /treasury → /fundraiser
  redirect, 4 missing MCP tools added to /mcp docs, i18n fixes.
- Claim finalize retry now mints a fresh transaction (fixes expired-tx retry
  loop found by the human pilot tester).
- `glama.json` added (Glama MCP directory listing).

## 2026-10-02
- Vercel deploy freeze root-caused: an hourly cron in vercel.json tripped the
  Hobby plan's daily-cron limit and Vercel silently rejected all deployments
  (HTTP 400 `cron_jobs_limits_reached`). Cron moved to daily; deploys
  restored. Rule documented: every cron in vercel.json must be daily-or-slower.

## 2026-10-01
- **Transaction-intent hardening live:** every wallet write reconciles prior
  pending intents first and is refused while any intent is unanswered —
  "unknown is never permission to retry."
- MCP server two-tier rate limits (100/hr read, 20/hr write per IP).
- Wallet picker fixes + HashPack in-app pairing hardening (from human pilot
  tester notes): no-wallet QR dead-end, stuck "Connecting…" nav button.
- `AGENT_ONBOARDING.md` published (scriptable agent onboarding).

## 2026-09-30
- Cross-chain waiver: Voicescape may go multi-rail via official/proven
  pathways only (Axelar GMP, LayerZero V2, Chainlink CCIP) — never trusted
  bridge custody. Each chain still needs explicit approval.

## 2026-09-27
- AI builder priced at break-even floor: $0.25/edit — every edit profitable.
- Blockpage Buddy pricing: 5 free messages, then 5 HBAR per 50; custom build
  5 HBAR flat, paid via `tipPage("forge")` with the atomic 98/2 split.

## 2026-09-15
- Blockpage Buddy widget deployed to production (read-only Groq + 3 Hedera
  mirror-node tools, 20/hr per-IP limit).
- Brand essence locked: indie/underground, lead with the human, the 98%
  split is the proof.

## 2026-09-13
- Vercel Web Analytics live (privacy-respecting: traffic, countries, top
  pages, errors — zero personal-data tracking).

## 2026-09-11
- **Mainnet deploy:** Registry 0.0.10854058, Tips 0.0.10854060
  (Sourcify-verified), treasury 0.0.10424063.
- Wallet sign-in: 1-tinybar self-transfer login memo verified via mirror
  node; 7-day session; every write checked server-side.
