/**
 * Creator funding goals.
 *
 * A page owner can set one public funding goal (target HBAR + optional
 * title). It is shown publicly on their blockpage with a progress bar
 * counting the tips raised *for this campaign*: the creator's all-time
 * 98% share recorded by the Tips contract, minus the `baselineHbar`
 * snapshot taken when the campaign started. A new campaign (first goal,
 * or a goal set after the previous one completed) snapshots the current
 * all-time total as its baseline, so progress starts at zero and a
 * replacement goal can never look instantly completed. Editing a live
 * (unreached) campaign keeps its baseline, so a title/target tweak never
 * wipes visible progress. Goals never touch funds — Voicescape holds
 * nothing; tipping stays direct wallet-to-wallet through the on-chain
 * Tips contract.
 *
 * Storage: KV `goals:<username>` → JSON, 1-year TTL (refreshed on every
 * write). Owner-only writes: the session wallet must own the username on
 * the on-chain registry. Reads are public.
 */
import type { KvStore } from "./store";
import { getKvStore } from "./store";
import { normalizeUsername } from "./analytics";
import { checkContent } from "./townhall/content-filter";
import { isPageOwner } from "./owner-check";

/** KV key prefix for funding goals. */
export const GOAL_KEY_PREFIX = "goals:";
/** KV key for the fundraiser board index: JSON array of usernames with goals. */
export const FUNDRAISER_INDEX_KEY = "fundraisers:index";
/** 365 days — a goal survives long past the 30-day analytics window. */
export const GOAL_TTL_MS = 365 * 24 * 3600 * 1000;
/** Sanity ceiling: 1M HBAR is far above any realistic creator goal. */
export const GOAL_MAX_HBAR = 1_000_000;
/** Goal titles are short labels — never a place for personal details. */
export const GOAL_TITLE_MAX_LEN = 80;

export interface FundingGoal {
  username: string;
  /** Owner wallet (lowercased) that set the goal — audit trail only. */
  owner: string;
  targetHbar: number;
  title: string | null;
  /**
   * All-time creator tip proceeds (HBAR) at the moment this campaign
   * started. Campaign progress = current all-time − baselineHbar.
   * Legacy records predate the field and read as 0 (old behavior).
   */
  baselineHbar: number;
  createdAt: string;
  updatedAt: string;
}

export function goalKey(username: string): string {
  return `${GOAL_KEY_PREFIX}${username}`;
}

/** Validate a goal payload. Returns the normalized record fields or an error. */
export function validateGoalInput(body: unknown): {
  ok: true;
  targetHbar: number;
  title: string | null;
} | { ok: false; error: string } {
  const b = (body ?? {}) as { targetHbar?: unknown; title?: unknown };
  const n = typeof b.targetHbar === "string" ? Number(b.targetHbar) : b.targetHbar;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > GOAL_MAX_HBAR) {
    return { ok: false, error: `target must be between 0 and ${GOAL_MAX_HBAR.toLocaleString("en-US")} HBAR` };
  }
  let title: string | null = null;
  if (b.title !== undefined && b.title !== null) {
    if (typeof b.title !== "string") return { ok: false, error: "title must be a string" };
    const clean = b.title.trim().replace(/\s+/g, " ").slice(0, GOAL_TITLE_MAX_LEN + 1);
    if (clean.length > GOAL_TITLE_MAX_LEN) {
      return { ok: false, error: `title must be under ${GOAL_TITLE_MAX_LEN} characters` };
    }
    if (clean) {
      const check = checkContent(clean, "goal title");
      if (!check.allowed) return { ok: false, error: check.reason ?? "title blocked" };
      title = clean;
    }
  }
  return { ok: true, targetHbar: n, title };
}

/** Parse a stored goal value; null when missing or corrupt. */
export function parseGoalValue(raw: string | null): FundingGoal | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as Partial<FundingGoal>;
    if (
      typeof g.username !== "string" ||
      typeof g.owner !== "string" ||
      typeof g.targetHbar !== "number" ||
      !Number.isFinite(g.targetHbar) ||
      g.targetHbar <= 0 ||
      (g.title !== null && typeof g.title !== "string") ||
      typeof g.createdAt !== "string" ||
      typeof g.updatedAt !== "string"
    ) {
      return null;
    }
    // Legacy records predate baselineHbar — read as 0 (old all-time behavior).
    const baselineHbar =
      typeof g.baselineHbar === "number" && Number.isFinite(g.baselineHbar) && g.baselineHbar >= 0
        ? g.baselineHbar
        : 0;
    return { ...g, baselineHbar } as FundingGoal;
  } catch {
    return null;
  }
}

/**
 * Campaign progress: the slice of the creator's all-time tipped total
 * that belongs to this campaign. Never negative.
 */
export function campaignRaised(
  goal: Pick<FundingGoal, "baselineHbar" | "targetHbar">,
  allTimeHbar: number | null,
): number {
  const base =
    typeof goal.baselineHbar === "number" && Number.isFinite(goal.baselineHbar) && goal.baselineHbar >= 0
      ? goal.baselineHbar
      : 0;
  const all = typeof allTimeHbar === "number" && Number.isFinite(allTimeHbar) ? allTimeHbar : 0;
  return Math.max(0, all - base);
}

/** True once this campaign's raised total meets its target. */
export function isCampaignReached(
  goal: Pick<FundingGoal, "baselineHbar" | "targetHbar">,
  allTimeHbar: number | null,
): boolean {
  return goal.targetHbar > 0 && campaignRaised(goal, allTimeHbar) >= goal.targetHbar;
}

/** Public read: the goal for a username, or null. */
export async function readGoal(store: KvStore, usernameRaw: unknown): Promise<FundingGoal | null> {
  const username = normalizeUsername(usernameRaw);
  if (!username) return null;
  try {
    return parseGoalValue(await store.get(goalKey(username)));
  } catch {
    return null;
  }
}

/**
 * Read the fundraiser board index: usernames that have (or had) funding
 * goals. The index is best-effort — readers always re-read the goal record
 * and skip stale entries, so a goal cleared without index cleanup simply
 * disappears from the board.
 */
export async function readFundraiserUsernames(store: KvStore): Promise<string[]> {
  let raw: string | null = null;
  try {
    raw = await store.get(FUNDRAISER_INDEX_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((u): u is string => typeof u === "string" && u.length > 0);
  } catch {
    return [];
  }
}

async function writeFundraiserIndex(store: KvStore, usernames: string[]): Promise<void> {
  await store.set(FUNDRAISER_INDEX_KEY, JSON.stringify(usernames), GOAL_TTL_MS);
}

/**
 * Best-effort: add a username to the fundraiser board index. Never throws —
 * the goal itself is already saved by the time this runs.
 */
export async function indexFundraiser(store: KvStore, username: string): Promise<void> {
  try {
    const list = await readFundraiserUsernames(store);
    if (!list.includes(username)) list.push(username);
    // Always rewrite: refreshes the index TTL on every goal save.
    await writeFundraiserIndex(store, list);
  } catch {
    /* index is best-effort */
  }
}

/**
 * Best-effort: remove a username from the fundraiser board index. Never
 * throws.
 */
export async function unindexFundraiser(store: KvStore, username: string): Promise<void> {
  try {
    const list = await readFundraiserUsernames(store);
    const next = list.filter((u) => u !== username);
    if (next.length !== list.length) await writeFundraiserIndex(store, next);
  } catch {
    /* index is best-effort */
  }
}

export interface GoalDeps {
  store: KvStore;
  verifySession: (cred: unknown) => Promise<{ ok: true; address: string } | { ok: false; error: string }>;
  resolveOwner: (username: string) => Promise<string | null>;
  /**
   * All-time tipped HBAR (creator's 98% share) for an owner EVM address;
   * null when unreadable. Optional in tests — writeGoal falls back to the
   * mirror-node reader. Used to snapshot the campaign baseline.
   */
  readAllTimeHbar?: (ownerAddress: string) => Promise<number | null>;
}

async function mirrorAllTimeHbar(ownerAddress: string): Promise<number | null> {
  try {
    const { fetchEarningsSummary } = await import("./earnings");
    const res = await fetchEarningsSummary(ownerAddress.toLowerCase());
    if (!res.ok) return null;
    const n = res.summary.hbarAllTime;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function defaultGoalDeps(): GoalDeps {
  return {
    store: getKvStore(),
    verifySession: async (cred: unknown) => {
      const { defaultAuthPort } = await import("./townhall/auth");
      const res = await defaultAuthPort().verifySession(cred);
      return res.ok ? { ok: true as const, address: res.session.address } : { ok: false as const, error: res.error };
    },
    resolveOwner: async (username: string) => {
      const { resolveUsernameWallet } = await import("./townhall/badges");
      return resolveUsernameWallet(username);
    },
    readAllTimeHbar: mirrorAllTimeHbar,
  };
}

export interface GoalResult {
  status: number;
  json: unknown;
}

function ok(json: unknown, status = 200): GoalResult {
  return { status, json };
}

function err(status: number, error: string): GoalResult {
  return { status, json: { error } };
}

async function requireOwner(deps: GoalDeps, usernameRaw: unknown, cred: unknown): Promise<
  | { ok: true; username: string; owner: string }
  | { ok: false; result: GoalResult }
> {
  const username = normalizeUsername(usernameRaw);
  if (!username) return { ok: false, result: err(400, "username is required") };
  if (cred == null) return { ok: false, result: err(401, "sign in with your wallet to manage your funding goal") };
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return { ok: false, result: err(401, verified.error) };
  let owner: string | null;
  try {
    owner = await deps.resolveOwner(username);
  } catch {
    return { ok: false, result: err(503, "could not resolve page ownership — try again in a moment") };
  }
  if (!owner) return { ok: false, result: err(404, "page not found") };
  // Owner identity must survive Hedera's dual address forms: the registry
  // may store the ECDSA-derived alias while the session holds long-zero.
  if (!(await isPageOwner(owner, verified.address))) {
    return { ok: false, result: err(403, "only the page owner can manage the funding goal") };
  }
  return { ok: true, username, owner: owner.toLowerCase() };
}

/**
 * Set (create or replace) the funding goal for a username.
 * Owner-only: 401 bad/missing session · 400 bad input · 404 page not found
 * · 403 not the owner · 503 store/ownership-resolution failure.
 */
export async function writeGoal(deps: GoalDeps, usernameRaw: unknown, body: unknown, cred: unknown): Promise<GoalResult> {
  const gate = await requireOwner(deps, usernameRaw, cred);
  if (!gate.ok) return gate.result;
  const validated = validateGoalInput(body);
  if (!validated.ok) return err(400, validated.error);
  const now = new Date().toISOString();
  let existing: FundingGoal | null = null;
  try {
    existing = await readGoal(deps.store, gate.username);
  } catch {
    /* treat as new campaign */
  }
  // Snapshot the current all-time total (best-effort; 0 when unreadable).
  let allTime: number | null = null;
  try {
    allTime = await (deps.readAllTimeHbar ?? mirrorAllTimeHbar)(gate.owner);
  } catch {
    /* best-effort */
  }
  // A save after the previous campaign completed starts a NEW campaign:
  // fresh baseline (progress restarts at zero) and fresh createdAt, so the
  // board and the blockpage treat it as a new fundraiser. Editing a live
  // (unreached) campaign keeps its baseline and createdAt — a title or
  // target tweak must never wipe visible progress.
  const prevReached = existing ? isCampaignReached(existing, allTime) : false;
  const isNewCampaign = !existing || prevReached;
  const baselineHbar = isNewCampaign ? (allTime ?? 0) : (existing?.baselineHbar ?? 0);
  const createdAt = isNewCampaign ? now : (existing?.createdAt ?? now);
  const goal: FundingGoal = {
    username: gate.username,
    owner: gate.owner,
    targetHbar: validated.targetHbar,
    title: validated.title,
    baselineHbar,
    createdAt,
    updatedAt: now,
  };
  try {
    await deps.store.set(goalKey(gate.username), JSON.stringify(goal), GOAL_TTL_MS);
  } catch {
    return err(503, "temporarily unavailable — please retry in a moment");
  }
  // Show it on the fundraiser board (best-effort; never fails the save).
  await indexFundraiser(deps.store, gate.username);
  return ok({ ok: true, goal });
}

/** Clear the funding goal for a username. Owner-only (same gates as set). */
export async function clearGoal(deps: GoalDeps, usernameRaw: unknown, cred: unknown): Promise<GoalResult> {
  const gate = await requireOwner(deps, usernameRaw, cred);
  if (!gate.ok) return gate.result;
  try {
    await deps.store.del(goalKey(gate.username));
  } catch {
    return err(503, "temporarily unavailable — please retry in a moment");
  }
  // Drop it from the fundraiser board (best-effort; never fails the clear).
  await unindexFundraiser(deps.store, gate.username);
  return ok({ ok: true, goal: null });
}
