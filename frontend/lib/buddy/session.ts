/**
 * Blockpage Buddy — wallet-scoped conversation memory (dapp port).
 *
 * Server-side history for the chat widget: the last 10 exchanges
 * (20 messages, ~6k chars max) live in the session blob (see metering.ts),
 * so Buddy remembers the conversation across page reloads. The widget also
 * sends its own client-side history; the route merges the two.
 *
 * SAFETY: only conversation text + the metering ledger is stored — never
 * keys, seeds, or mnemonics. Anything shaped like a private key is
 * redacted before storage.
 */
import { getKvStore, type KvStore } from "@/lib/server/store";
import {
  loadRecord,
  saveRecord,
  sanitizeSessionId,
  withSessionLock,
  type Turn,
} from "./metering";

export type { Turn };

const MAX_TURNS = 20; // keep the last 10 exchanges
const MAX_CHARS = 6000; // ...and never more than ~6k chars of history

/** Redact anything shaped like a private key before it touches storage. */
function redactSecrets(text: string): string {
  // 0x-prefixed 64-hex = private key shape. (The live message still goes
  // to the model unredacted — this only keeps secrets out of storage.)
  return text.replace(/\b0x[a-fA-F0-9]{64}\b/g, "[redacted-key]");
}

function trimTurns(turns: Turn[]): Turn[] {
  let kept = turns.slice(-MAX_TURNS);
  let chars = kept.reduce((n, t) => n + t.text.length, 0);
  while (kept.length > 2 && chars > MAX_CHARS) {
    kept = kept.slice(2);
    chars = kept.reduce((n, t) => n + t.text.length, 0);
  }
  return kept;
}

export async function loadHistory(
  sessionId: string,
  store: KvStore = getKvStore(),
): Promise<Turn[]> {
  return trimTurns((await loadRecord(sanitizeSessionId(sessionId), store)).turns);
}

export async function saveExchange(
  sessionId: string,
  humanText: string,
  aiText: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  const human = redactSecrets(humanText.slice(0, 2000));
  const ai = redactSecrets(aiText.slice(0, 4000));
  if (!human || !ai) return;
  const sid = sanitizeSessionId(sessionId);
  // Under the session lock: this turns-append must not clobber a
  // concurrent credit/spend/freeUsed save, and vice versa.
  await withSessionLock(
    sid,
    async () => {
      const rec = await loadRecord(sid, store);
      rec.turns.push({ role: "human", text: human }, { role: "ai", text: ai });
      rec.turns = trimTurns(rec.turns);
      await saveRecord(sid, rec, store);
    },
    store,
  );
}
