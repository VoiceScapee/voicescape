/**
 * Pending-intent ledger — the durable record of the *question*, not the answer.
 *
 * Every wallet write in lib/tx.ts generates its transaction ID client-side
 * BEFORE the wallet signs. If the tab closes (or the wallet goes silent)
 * between broadcast and confirmation, that handle lived only in memory —
 * the client could no longer re-ask the mirror node for the outcome.
 *
 * This module persists each intent to localStorage before broadcast and
 * clears it once the mirror node reports a definitive outcome. Anything
 * left behind is re-checked (reconciled) the next time the app performs a
 * write, so an interrupted payment is never silently forgotten: the next
 * session re-asks instead of replaying.
 *
 * SSR-safe: every function degrades to a no-op outside the browser.
 * Storage failures (private mode, quota) never throw — a missing ledger
 * is strictly worse than a best-effort one.
 */

export interface PendingIntent {
  /** SDK "@" form, e.g. "0.0.1234@1700000000.000000000" — generated client-side. */
  txId: string;
  /** Short machine kind: tip | buy | register | update | approve | swap */
  kind: string;
  /** Human-readable label, e.g. "Tip to bacon-the-dino" */
  label: string;
  /** Payer account id string */
  account: string;
  /** Date.now() at broadcast */
  createdAt: number;
}

const STORAGE_KEY = "vs.pendingIntents.v1";
const MAX_STORED = 20;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidIntent(v: unknown): v is PendingIntent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.txId === "string" &&
    o.txId.length > 0 &&
    typeof o.kind === "string" &&
    typeof o.label === "string" &&
    typeof o.account === "string" &&
    typeof o.createdAt === "number"
  );
}

/** All stored intents, newest first. Never throws. */
export function listPendingIntents(): PendingIntent[] {
  try {
    const s = storage();
    if (!s) return [];
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidIntent);
  } catch {
    return [];
  }
}

/** Persist an intent before broadcast. Never throws. */
export function savePendingIntent(intent: PendingIntent): void {
  try {
    const s = storage();
    if (!s) return;
    const rest = listPendingIntents().filter((i) => i.txId !== intent.txId);
    rest.unshift(intent);
    s.setItem(STORAGE_KEY, JSON.stringify(rest.slice(0, MAX_STORED)));
  } catch {
    /* best-effort only */
  }
}

/** Clear an intent once its outcome is definitive. Never throws. */
export function removePendingIntent(txId: string): void {
  try {
    const s = storage();
    if (!s) return;
    const rest = listPendingIntents().filter((i) => i.txId !== txId);
    s.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    /* best-effort only */
  }
}

export type LandedStatus = "success" | "failed" | "unknown" | "expired";

export interface ReconcileSummary {
  /** Intents the mirror node answered definitively (now cleared). */
  resolved: number;
  /** Intents still awaiting an answer. */
  stillPending: number;
}

/**
 * Re-ask the mirror node about every stored intent. Intents with a
 * definitive outcome are cleared; unanswered ones are kept for next time.
 * A failed status check is NOT a failed transaction — the intent stays.
 * Never throws.
 */
export async function reconcilePendingIntents(
  checkLanded: (txId: string) => Promise<LandedStatus>,
): Promise<ReconcileSummary> {
  let resolved = 0;
  try {
    const intents = listPendingIntents();
    for (const intent of intents) {
      let status: LandedStatus;
      try {
        status = await checkLanded(intent.txId);
      } catch {
        status = "unknown";
      }
      // "expired" is also terminal: the mirror has indexed past the tx's
      // validity window without seeing it, so it can never land. "unknown"
      // stays stored — the mirror may just be behind.
      if (status === "success" || status === "failed" || status === "expired") {
        removePendingIntent(intent.txId);
        resolved++;
      }
    }
  } catch {
    /* never let reconciliation break the caller */
  }
  return { resolved, stillPending: listPendingIntents().length };
}

/**
 * Thrown when a new write is refused because a previous intent from the
 * same account still has no definitive on-chain outcome. Carries the
 * unresolved intents so the UI can point the user at exactly what to
 * check (e.g. on HashScan) before retrying.
 */
export class UnresolvedIntentError extends Error {
  readonly intents: PendingIntent[];
  constructor(intents: PendingIntent[]) {
    super(
      "A previous transaction's outcome is still unknown — the network " +
        "couldn't confirm whether it went through. Check its status on " +
        "HashScan before trying again, so you don't send the same payment " +
        "twice. Unresolved: " +
        intents.map((i) => i.txId).join(", "),
    );
    this.name = "UnresolvedIntentError";
    this.intents = intents;
  }
}

/**
 * Reconcile-then-gate: re-ask the mirror node about every stored intent,
 * then refuse to proceed while any of THIS account's intents are still
 * unanswered.
 *
 * "Unknown" is never permission to retry. A missing transaction is not
 * proof of failure (the mirror may just be behind), and it is not proof
 * of success either — so a new write from the same account is only safe
 * once every prior intent has a definitive outcome. When the mirror can't
 * answer, the write is blocked with an UnresolvedIntentError instead of
 * risking a duplicate.
 *
 * Storage or network failures degrade to "still pending", which trips the
 * gate — the safe direction. Never throws for infrastructure problems;
 * only UnresolvedIntentError escapes, and only when intents genuinely
 * remain unanswered.
 */
export async function reconcileAndGate(
  checkLanded: (txId: string) => Promise<LandedStatus>,
  account: string,
): Promise<void> {
  await reconcilePendingIntents(checkLanded);
  const blocked = listPendingIntents().filter((i) => i.account === account);
  if (blocked.length > 0) throw new UnresolvedIntentError(blocked);
}
