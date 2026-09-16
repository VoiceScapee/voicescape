# Dep-Security Watch

Recurring **read-only** dependency-security watch for Voicescape. The
production-grade merge gate sweeps dependencies at merge time; this job sweeps
**between** merges and raises an alert when something drifts.

## What it runs

`frontend/scripts/dep-security-watch.mjs` (also `npm run dep:watch` from
`frontend/`). Three checks, all read-only:

| Check | What it does |
|---|---|
| `hedera-native-import-sweep` | Scans tracked source for forbidden non-Hedera chain libs (`thirdweb`, `wagmi`, `web3`, `@solana/*`) and off-toolkit-map stacks (`xrpl`, `ripple-*`, `stablecoin-studio`, `guardian-service`) — same patterns as the merge gate (`ops/voice-engine/gate.sh`). HFS usage (`File*Transaction`) is advisory only. |
| `manifest-dep-sweep` | Scans `dependencies`/`devDependencies`/`peerDependencies` in the root, `frontend/`, and `contracts/` manifests for the same forbidden names. |
| `npm-audit` | Runs `npm audit --json --audit-level=high` (read-only) per lockfile and reports **high/critical** advisories with package, range, and advisory title. |

Output is JSON on stdout (`--out <path>` also writes a report file). Exit
codes: `0` clean · `2` alert (findings) · `1` incomplete (a check errored).

## Hard rules

- **Read-only.** The script spawns only `git grep` and `npm audit`. It never
  runs `npm install` / `update` / `ci` / `dedupe` / `audit fix`, and it aborts
  if any such token appears in its argv.
- **Never weakens the gate.** Findings are alerts for a human to triage; they
  do not change any merge-gate threshold and a clean watch does not bless a
  branch.
- **Hedera-native only.** No non-Hedera chain libraries, no custom chain
  plumbing — same allow-list posture as the deploy gate.
- **$0 operating cost.** No paid APIs, no keys. `npm audit` uses the free
  public npm registry.
- **No invented data.** Every finding cites a `file:line`, a manifest
  dependency, or an npm advisory.

## Proposed recurring schedule

Weekly, so drift is caught within days without noise:

- **Cadence:** weekly, Monday ~09:00 America/New_York
- **Job id:** `dep-security-watch-weekly`
- **Run:** fresh checkout of `origin/master` →
  `node frontend/scripts/dep-security-watch.mjs --out <run-log-dir>/dep-watch.json`
- **Alert routing:** on `verdict: alert` (or `incomplete`), the run reports to
  the main chat (Danny), who plays the findings back to Brandon per the chat
  confirmation protocol before any action. A clean run stays silent.
- **Verdict handling:** `alert` = human triages (upgrade, replace, or accept
  with a recorded decision); `incomplete` = rerun once, then escalate;
  never auto-fix, never auto-merge.

## Manual run

```bash
cd frontend && npm run dep:watch
# or
node frontend/scripts/dep-security-watch.mjs --out /tmp/dep-watch.json
```

Current baseline (2026-09-16, master `1282856`): **clean** — no forbidden
imports, no forbidden manifest deps, no high/critical advisories.
