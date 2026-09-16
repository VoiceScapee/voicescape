#!/usr/bin/env node
/**
 * dep-security-watch.mjs — recurring READ-ONLY dependency-security watch.
 *
 * Runs the production-grade gate's dependency checks on a schedule, between
 * merges, and reports findings. It is an ALERT job, not a gate: findings never
 * block a merge and never change any gate threshold — a human triages them.
 *
 * HARD RULES (never weaken these):
 *   1. READ-ONLY. The only child processes this script may spawn are `git`
 *      (read-only grep) and `npm audit` (read-only vulnerability report).
 *      It NEVER runs `npm install`, `npm update`, `npm ci`, `npm dedupe`,
 *      `npm uninstall`, or `npm audit fix` — and it refuses to start if any
 *      such token appears in its own argv.
 *   2. Hedera-native scope. It flags forbidden non-Hedera chain libraries and
 *      off-toolkit-map stacks per docs/HEDERA_TOOLKIT_BRIEF.md. It does not
 *      bless, install, or upgrade anything.
 *   3. $0 operating cost. No paid APIs, no API keys, no network writes.
 *      `npm audit` uses the free public npm registry.
 *   4. No invented data. Every finding cites a file:line, a manifest
 *      dependency name, or an npm advisory id.
 *
 * Usage:
 *   node frontend/scripts/dep-security-watch.mjs [--out <report.json>]
 *                                                 [--audit-timeout-ms <n>]
 *
 * Exit codes:
 *   0 = clean (all checks ran, no findings)
 *   2 = alert  (one or more findings — a human should triage)
 *   1 = incomplete (a check errored, e.g. audit timed out)
 *
 * The full report is JSON on stdout; --out also writes it to a file.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- argv guard
// The script accepts only its own read-only flags. Any token that could turn
// this into a mutating job aborts the run before anything executes.
const FORBIDDEN_ARGV = /\b(fix|install|update|dedupe|uninstall|audit\s+fix|^ci$)\b/i;
const args = process.argv.slice(2);
for (const a of args) {
  if (FORBIDDEN_ARGV.test(a)) {
    console.error(`dep-security-watch: refusing to run — mutating token in argv: ${a}`);
    process.exit(1);
  }
}

let outPath = null;
let auditTimeoutMs = 120_000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
  else if (args[i] === '--audit-timeout-ms' && args[i + 1]) {
    auditTimeoutMs = Number(args[++i]);
    if (!Number.isFinite(auditTimeoutMs) || auditTimeoutMs <= 0) {
      console.error('dep-security-watch: --audit-timeout-ms must be a positive number');
      process.exit(1);
    }
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: node frontend/scripts/dep-security-watch.mjs [--out <report.json>] [--audit-timeout-ms <n>]');
    process.exit(0);
  } else {
    console.error(`dep-security-watch: unknown flag: ${args[i]}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------- repo location
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'voicescape') return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
if (!repoRoot) {
  console.error('dep-security-watch: could not locate the voicescape repo root');
  process.exit(1);
}

// ------------------------------------------------------------------ patterns
// Mirrors the autonomous engine's merge gate (ops/voice-engine/gate.sh checks
// "dep-sweep" and "toolkit-map") so the watch and the gate speak the same
// language. Patterns are anchored to module specifiers (quotes) to avoid prose
// false-positives in docs.
const CODE_DIRS = [
  'frontend/app', 'frontend/components', 'frontend/hooks', 'frontend/lib',
  'frontend/data', 'frontend/scripts',
  'packages',
  'contracts/contracts', 'contracts/scripts', 'contracts/test',
  'services', 'apps', 'deploy-page', 'ipfs',
].filter((d) => existsSync(join(repoRoot, d)));

const SRC_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts', '*.sol'];

const PAT_FORBIDDEN_CHAIN =
  String.raw`\bfrom[ \t]+['"](thirdweb|wagmi|web3|@solana/[^'"]*)['"]` +
  String.raw`|require\([ \t]*['"](thirdweb|wagmi|web3|@solana/[^'"]*)['"]` +
  String.raw`|\bimport\([ \t]*['"](thirdweb|wagmi|web3|@solana/[^'"]*)['"]`;

const PAT_TOOLKIT_HARD =
  String.raw`['"](xrpl|ripple-[^'"]*|stablecoin-studio|@hashgraph/stablecoin|@guardian[^'"]*|guardian-service)['"]`;

// Advisory only (warn, never alert): HFS is fine for small metadata/config
// blobs, never for media — a human confirms intent.
const PAT_TOOLKIT_SOFT =
  String.raw`File(Create|Append|Update)Transaction|FileContentsQuery`;

const RE_FORBIDDEN_CHAIN = new RegExp(PAT_FORBIDDEN_CHAIN);
const RE_TOOLKIT_HARD = new RegExp(PAT_TOOLKIT_HARD);
const RE_TOOLKIT_SOFT = new RegExp(PAT_TOOLKIT_SOFT);

// Manifest dependency names that are never allowed (exact or prefix match).
const FORBIDDEN_DEP_EXACT = new Set([
  'thirdweb', 'wagmi', 'web3', 'xrpl',
  'stablecoin-studio', 'guardian-service', '@hashgraph/stablecoin',
]);
const FORBIDDEN_DEP_PREFIX = ['@solana/', 'ripple-', '@guardian'];

const MANIFESTS = [
  { label: 'root (packages/*)', dir: repoRoot },
  { label: 'frontend', dir: join(repoRoot, 'frontend') },
  { label: 'contracts', dir: join(repoRoot, 'contracts') },
];

// ------------------------------------------------------------------- helpers
function run(cmd, cmdArgs, { cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    execFile(cmd, cmdArgs, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => resolvePromise({ err, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

function headSha() {
  try {
    const { execFileSync } = process.getBuiltinModule('node:child_process');
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ------------------------------------------------- check 1: import sweep
async function checkImportSweep() {
  const findings = [];
  const advisories = [];
  const ere = [PAT_FORBIDDEN_CHAIN, PAT_TOOLKIT_HARD, PAT_TOOLKIT_SOFT].join('|');
  const gitArgs = ['grep', '-n', '-E', '-e', ere, '--', ...CODE_DIRS, ...SRC_GLOBS];
  const { err, stdout, stderr } = await run('git', gitArgs, { cwd: repoRoot, timeoutMs: 60_000 });

  if (err && err.code !== 1) {
    // git grep exits 1 on no matches; anything else is a real error.
    return { name: 'hedera-native-import-sweep', status: 'error', detail: `git grep failed: ${(stderr || err.message).trim().slice(0, 300)}`, findings, advisories };
  }
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (RE_FORBIDDEN_CHAIN.test(line)) findings.push({ kind: 'forbidden-chain-lib', where: line.slice(0, 400) });
    else if (RE_TOOLKIT_HARD.test(line)) findings.push({ kind: 'toolkit-map-hard-block', where: line.slice(0, 400) });
    else if (RE_TOOLKIT_SOFT.test(line)) advisories.push({ kind: 'hfs-usage-advisory', where: line.slice(0, 400) });
  }
  const status = findings.length > 0 ? 'fail' : 'pass';
  const detail = findings.length > 0
    ? `${findings.length} forbidden import(s): non-Hedera chain lib or off-toolkit-map stack`
    : advisories.length > 0
      ? `clean; ${advisories.length} HFS advisory note(s) for human review`
      : 'clean — no forbidden chain libs, no off-map stacks';
  return { name: 'hedera-native-import-sweep', status, detail, findings, advisories };
}

// ------------------------------------------------- check 2: manifest deps
function checkManifestDeps() {
  const findings = [];
  for (const m of MANIFESTS) {
    const pkgPath = join(m.dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      return { name: 'manifest-dep-sweep', status: 'error', detail: `unreadable ${m.label}/package.json: ${e.message}`, findings, advisories: [] };
    }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        const banned = FORBIDDEN_DEP_EXACT.has(name) || FORBIDDEN_DEP_PREFIX.some((p) => name.startsWith(p));
        if (banned) findings.push({ kind: 'forbidden-manifest-dep', where: `${m.label}: ${section}.${name}@${pkg[section][name]}` });
      }
    }
  }
  const status = findings.length > 0 ? 'fail' : 'pass';
  return {
    name: 'manifest-dep-sweep',
    status,
    detail: findings.length > 0
      ? `${findings.length} forbidden dependenc(ies) in package manifests`
      : 'clean — manifests contain no forbidden chain libs',
    findings,
    advisories: [],
  };
}

// ------------------------------------------------- check 3: npm audit
// Read-only: `npm audit` never modifies the tree. `--fix` is never passed.
function extractAuditFindings(data) {
  const findings = [];
  // npm >= 7 format
  const vulns = data?.vulnerabilities ?? {};
  for (const [name, v] of Object.entries(vulns)) {
    const sev = String(v?.severity ?? '').toLowerCase();
    if (sev === 'high' || sev === 'critical') {
      const via = Array.isArray(v?.via)
        ? v.via.map((x) => (typeof x === 'string' ? x : x?.title ?? x?.url ?? '')).filter(Boolean).slice(0, 3)
        : [];
      findings.push({
        kind: 'npm-advisory',
        severity: sev,
        where: name,
        detail: `${name} ${v?.range ?? ''} — ${(via[0] ?? 'see npm advisory').slice(0, 200)}`.trim(),
        fixAvailable: v?.fixAvailable === true || (v?.fixAvailable && v.fixAvailable !== false),
      });
    }
  }
  // npm 6 legacy format
  for (const adv of Object.values(data?.advisories ?? {})) {
    const sev = String(adv?.severity ?? '').toLowerCase();
    if (sev === 'high' || sev === 'critical') {
      findings.push({
        kind: 'npm-advisory',
        severity: sev,
        where: adv?.module_name ?? '?',
        detail: `${adv?.module_name ?? '?'} — ${(adv?.title ?? '').slice(0, 200)}`.trim(),
        fixAvailable: false,
      });
    }
  }
  return findings;
}

async function checkNpmAudit() {
  const findings = [];
  const perManifest = [];
  for (const m of MANIFESTS) {
    if (!existsSync(join(m.dir, 'package-lock.json'))) {
      perManifest.push({ manifest: m.label, status: 'skipped', detail: 'no package-lock.json' });
      continue;
    }
    // HARD READ-ONLY GUARD: the only npm invocation allowed is `npm audit`.
    const { err, stdout } = await run('npm', ['audit', '--json', '--audit-level=high'],
      { cwd: m.dir, timeoutMs: auditTimeoutMs });
    let data = null;
    try {
      data = JSON.parse(stdout);
    } catch {
      const killed = err && (err.killed || /timed out/i.test(err.message));
      perManifest.push({
        manifest: m.label,
        status: 'error',
        detail: killed ? `npm audit timed out after ${auditTimeoutMs}ms` : `npm audit output unparsable (${(err?.message ?? 'unknown').slice(0, 120)})`,
      });
      continue;
    }
    // npm audit exits non-zero when vulns are found — that is data, not failure.
    const f = extractAuditFindings(data).map((x) => ({ ...x, where: `${m.label}: ${x.where}` }));
    findings.push(...f);
    perManifest.push({
      manifest: m.label,
      status: f.length > 0 ? 'fail' : 'pass',
      detail: f.length > 0 ? `${f.length} high/critical advisorie(s)` : 'no high/critical advisories',
    });
  }
  const errored = perManifest.some((p) => p.status === 'error');
  const status = errored ? 'error' : findings.length > 0 ? 'fail' : 'pass';
  return {
    name: 'npm-audit',
    status,
    detail: errored
      ? 'audit incomplete — at least one manifest could not be audited (see per_manifest)'
      : findings.length > 0
        ? `${findings.length} high/critical advisorie(s) across manifests`
        : 'clean — no high/critical advisories',
    findings,
    advisories: [],
    per_manifest: perManifest,
  };
}

// --------------------------------------------------------------------- main
async function main() {
  const startedAt = new Date().toISOString();
  const checks = [
    await checkImportSweep(),
    checkManifestDeps(),
    await checkNpmAudit(),
  ];

  const hasFindings = checks.some((c) => c.status === 'fail');
  const hasErrors = checks.some((c) => c.status === 'error');
  const verdict = hasFindings ? 'alert' : hasErrors ? 'incomplete' : 'clean';

  const report = {
    job: 'dep-security-watch',
    generated_at: startedAt,
    repo: repoRoot,
    head: headSha(),
    read_only: true,
    verdict,
    checks,
  };

  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (outPath) {
    const abs = resolve(outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, json + '\n', 'utf8');
    console.error(`dep-security-watch: report written to ${abs}`);
  }

  const nFindings = checks.reduce((n, c) => n + (c.findings?.length ?? 0), 0);
  const nAdvisories = checks.reduce((n, c) => n + (c.advisories?.length ?? 0), 0);
  console.error(`dep-security-watch: verdict=${verdict} findings=${nFindings} advisories=${nAdvisories}`);

  process.exit(verdict === 'clean' ? 0 : verdict === 'alert' ? 2 : 1);
}

main().catch((e) => {
  console.error(`dep-security-watch: fatal: ${e?.message ?? e}`);
  process.exit(1);
});
