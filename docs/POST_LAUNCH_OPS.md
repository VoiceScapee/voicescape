# Voicescape — Post-Launch Operations

Mainnet is live (Registry 0.0.10854058, Tips 0.0.10854060, since 2026-09-11).
The pre-launch checklist is archived at
`docs/archive/MAINNET_LAUNCH_CHECKLIST.md`. This file is the recurring
operational checklist — what "keeping it production-grade" means week to week.

## Standing automation (verify, don't assume)

- **Autonomous engine** — builds, gates, and merges to master when all gates
  pass (tsc, full vitest, prod build, Hedera dep sweep, merge hygiene).
  Kill switch: `~/workspace/ops/voice-engine/PAUSE`.
- **Watchers** — buddy-health-watch, discord-bot-watch, engine keeper,
  progress-refresh (6h), moltbook-night-watch, wallet-sweep-daily (~09:14 ET).
- **Vercel Hobby cron rule** — every cron in `frontend/vercel.json` must be
  **daily-or-slower**. An hourly cron silently froze all deployments
  2026-10-01 → 2026-10-02 (HTTP 400 `cron_jobs_limits_reached`). Check any
  PR touching the crons block against this.

## Weekly (human or agent review)

- [ ] Vercel Web Analytics: visitors/views trend, bounce, top pages, referrers.
      Flag anomalies (e.g. /ai-agent never appearing in top pages).
- [ ] `/api/mcp/stats`: which tools agents actually call; dead tools are
      candidates for docs or removal.
- [ ] `/api/client-error` aggregates: new error shapes = new bugs.
- [ ] Town-hall reports queue: clear it; escalate per `docs/MODERATION_POSTURE.md`.
- [ ] Wallet sweep log (`~/workspace/ops/wallet-sweep/sweeps.log`): floors
      held, excess forwarded to 0.0.10424063.
- [ ] Dependency drift: `npm audit` on frontend + contracts; Hedera SDK
      releases worth adopting.

## Monthly

- [ ] Review `COMPLIANCE_TODO_FOR_BRANDON.md` — anything Brandon can now close.
- [ ] Re-read `SECURITY.md` disclosure channel — still monitored?
- [ ] CHANGELOG.md — is it current? (If not, it rots; fix immediately.)
- [ ] MCP tool count vs `/mcp` page copy — the page hardcodes the count;
      update on every tool addition.

## Incident response (first 30 minutes)

1. Confirm scope: which surface (dapp, MCP, contracts, infra)?
2. Chain money at risk? If yes: pause the affected write path first, investigate
   second. The contracts have no pause switch by design — the mitigation is
   at the dapp/API layer (disable the route, rotate keys if exposed).
3. Post status to the `/status` page and Discord #dev-updates.
4. Write the postmortem into `CHANGELOG.md` (unreleased section) + a dated
   note in `~/workspace/ops/incidents/`.
5. If user funds were affected, disclose per `SECURITY.md` — no silent fixes
   on money paths.

## Open items (owner: Brandon — his call, not the team's)

- Legal entity formation (no LLC exists as of 2026-09-19).
- Registered DMCA agent (Discord-only intake likely does not satisfy
  §512(c) safe harbor).
- HashPack dapp-browser listing (application submitted, pending review).
- Grant applications in flight (see `~/workspace/goals/` — Hashgraph
  Association $250K applied).

## Never

- Never weaken a deploy gate to ship.
- Never ship testnet-only guards as the safety pattern — safeguards protect
  real money on mainnet.
- Never commit a `node_modules` symlink or another agent's files (see
  `CONTRIBUTING.md` shared-repo rules).
