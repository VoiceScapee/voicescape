# Contributing to Voicescape

One person built this from a phone; the bar for joining in is care, not
credentials. Read this whole file before your first commit — several rules
exist because real money moves here.

## The one rule above all

**Nothing with outward effects ships without the founder's explicit go in
chat:** merges to `master` (= production deploy), chain transactions, HBAR
spending, contract redeploys, posts, DMs. Committing and pushing **branches**
is fully automated — never wait for approval on those. Build to the stopping
point (branch pushed / read-only verified), then report and stop.

## Branch workflow

- Branch from `origin/master`: `danny/<short-name>` for Danny's work,
  `<you>/<short-name>` for anyone else. Never commit directly to `master`.
- One concern per branch. Keep it rebased on fresh `origin/master` before
  requesting review.
- The autonomous engine may merge a branch to `master` **only** when every
  gate below passes. The gates ARE the approval. Any gate failure parks the
  branch — never weaken a gate to ship.

## Production-grade gates (all must pass)

1. `npx tsc --noEmit` clean (in `frontend/`)
2. Full vitest suite green (`npx vitest run` in `frontend/`)
3. Production `next build` succeeds
4. Hedera-native dependency sweep — official Hedera libraries only:
   `@hashgraph/hedera-wallet-connect`, `@hiero-ledger/sdk`, official
   mirror-node REST, HCS / HCS-10 / HTS. **No custom chain plumbing, no
   non-Hedera chain libs** (thirdweb, wagmi, web3.js, solana). `ethers` is
   allowed only as an EVM calldata decoder, never as a chain connection.
   (Cross-chain work additionally requires the official/proven pathway —
   Axelar GMP, LayerZero V2, Chainlink CCIP — and explicit per-chain approval.)
5. Merge hygiene: the branch merges onto fresh `origin/master` with no
   unrelated files.

Money-moving code paths additionally require **on-chain or real-device
proof** — never "verified" from a code audit alone. Safeguards must protect
real money on **mainnet**; testnet-only guards are dead code, not safety.

## Shared-repo safety (multiple agents work in this tree)

- **Always** run `git branch --show-current` immediately before `git commit`.
  A concurrent checkout by another worker can silently redirect your commit
  onto their branch. If the branch is wrong, stop and re-route.
- **Never `git add -A`.** Other workers leave uncommitted work in the same
  tree. Run `git status --short` first and `git add` only your own paths.
- Never let a worktree `node_modules` symlink get committed. Never commit
  another worker's files (`__pycache__`, someone else's drafts) — a stray
  `telegram-bot/__pycache__/` in your add list is the tell.
- Manual merge worktrees go under `~/workspace/tmp/gates/` with a unique
  path (never a generic `ship-*` the engine might reuse). Re-verify
  `git rev-parse HEAD` before every gate step and before pushing.
- Never pipe a git command into `tail`/`head` before `&&` — the pipeline's
  exit code is the last command's, so the second command runs even when git
  failed. Same trap in shell conditionals: use `grep -q`, not `grep | head`.

## Code standards

- TypeScript strict; no `any` without a comment explaining why.
- Every user-facing element must be backed by **live Hedera mainnet data**
  via official paths — never simulated, placeholder, or decorative.
  Honest quiet states ("nothing happening") are fine; decorative nodes come
  off the page until they earn their way back with a real source.
- Every on-chain event shown must be independently verifiable: surface the
  tx ID / block / contract with a HashScan link. "Trust me" copy is a defect.
- Telemetry is anonymous by design: counts only, never wallets, IPs, or
  pages. If your feature needs a new metric, keep it that way.
- Keep custom code minimal — only the smart-contract connection stays
  custom; everything else uses open-source tools, not custom implementations.
- User-facing copy: call pages **blockpages**, never "MySpace-style".
  Never describe anything as "$0"/"free" end-to-end — claiming costs real
  Hedera gas; the intro call and preview are free, the claim signature costs
  a tiny fee. Say exactly that.

## Docs

- If you change behavior, update `CHANGELOG.md` (Unreleased section) in the
  same branch. A behavior change without a changelog entry is incomplete.
- If you add an MCP tool, update: the registry, `/mcp` page copy (never
  hardcode the tool count — it drifts), `SERVER_INSTRUCTIONS` if limits or
  guarantees changed, and the route's read/write tier set (the parity test
  enforces this — run it).
- If you touch a cron in `frontend/vercel.json`, it must be **daily-or-slower**
  (Vercel Hobby limit — an hourly cron once froze all deployments).

## Getting help

- Agent contributors: start with `AGENT_ONBOARDING.md`.
- Human contributors: the first-run wizard (`frontend/components/Onboarding.tsx`)
  and `/new-to-web3` are the product tour; this file is the process tour.
- Security issues: see `SECURITY.md` — never open a public issue for a
  vulnerability.
