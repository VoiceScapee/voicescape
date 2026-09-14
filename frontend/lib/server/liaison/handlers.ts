/**
 * Liaison slice-1 server handlers (framework-free — directly unit-testable).
 *
 * The liaison is a *hired helper, never a custodian*:
 * - No handler accepts a private key, seed phrase, or signing request.
 * - No handler imports the operator key (~/workspace/ops/agent-outreach/
 *   operator.key) — it signs HCS/agent-comms only, never liaison routes.
 * - The one exception is the revenue sweep (lib/server/liaison/forwarder.ts),
 *   which reads the liaison's OWN key from the LIAISON_FORWARDER_KEY env to
 *   sign a transfer from the liaison's OWN wallet (0.0.10857765) to
 *   treasury. It can never spend user funds — the key it holds only
 *   controls the liaison wallet. User keys are never accepted, seen, or
 *   needed anywhere.
 * - There is no publish-on-behalf path: publishing is always the user's
 *   own wallet signature in their browser (existing builder flow).
 * - Drafts are keyed strictly by the verified session wallet; every read
 *   requires session addr == draft addr. No cross-wallet reads, no admin
 *   backdoor.
 *
 * Routes (app/api/liaison/*) are thin: ipGate + session auth + quota, then
 * delegate here with real deps.
 */
import { checkContent } from "../townhall/content-filter";
import { TEMPLATES } from "../../templates";
import { isValidPage, type VoicescapePage } from "../../schema";
import type { KvStore } from "../store";
import {
  LIAISON_BUILDS_PER_PAYMENT,
  LIAISON_CHAT_PER_PAYMENT,
  LIAISON_DRAFT_TTL_MS,
  LIAISON_ENTITLEMENT_TTL_MS,
  LIAISON_HISTORY_LIMIT,
  LIAISON_HISTORY_TTL_MS,
  LIAISON_MAX_DRAFT_BYTES,
  LIAISON_MAX_MESSAGE_CHARS,
  LIAISON_TIPS_CONTRACT_ID,
  LIAISON_TIP_CLAIM_TTL_MS,
  decodeRegisterUsername,
  entitlementAlive,
  isLiaisonTipLog,
  isOwnPageRegisteredLog,
  isSuccessfulContractCall,
  liaisonDraftKey,
  liaisonEntKey,
  liaisonHistKey,
  liaisonTipKey,
  normalizeTxRef,
  parseEntitlement,
  type LiaisonEntitlement,
  type LiaisonProduct,
} from "../../liaison";
import {
  LIAISON_UNKNOWN_FALLBACK,
  findLiaisonAnswer,
} from "../../liaison-knowledge";

export interface MirrorGetResult {
  ok: boolean;
  status: number;
  json: unknown;
}

export interface LiaisonDeps {
  kv: KvStore;
  nowMs: () => number;
  /** Price of a 50-message chat session in HBAR. */
  chatPriceHbar: number;
  /** Price of one page build in HBAR. */
  buildPriceHbar: number;
  /** GET against the mirror node; path starts with "/api/v1/...". */
  mirrorGet: (path: string) => Promise<MirrorGetResult>;
  /**
   * Optional revenue-sweep hook, wired by routes: sweeps the liaison's own
   * tip share to treasury after a verified tip. Resolves the sweep tx id,
   * or null when no sweep happened. Best-effort — never fails verification.
   */
  afterTipVerified?: () => Promise<string | null>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const ok = (body: Record<string, unknown>): HandlerResult => ({ status: 200, body });
const err = (status: number, error: string, extra: Record<string, unknown> = {}): HandlerResult => ({
  status,
  body: { error, ...extra },
});

async function readEntitlement(deps: LiaisonDeps, addr: string): Promise<LiaisonEntitlement | null> {
  const raw = await deps.kv.get(liaisonEntKey(addr));
  if (!raw) return null;
  try {
    return parseEntitlement(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeEntitlement(
  deps: LiaisonDeps,
  addr: string,
  ent: LiaisonEntitlement,
): Promise<void> {
  const ttlMs = Math.max(60_000, ent.expMs - deps.nowMs());
  await deps.kv.set(liaisonEntKey(addr), JSON.stringify(ent), ttlMs);
}

/** Recursively run every string through the content filter (IPFS is immutable). */
function pageJsonBlocked(value: unknown, seen = new Set<object>()): string | null {
  if (typeof value === "string") {
    const c = checkContent(value, "page content");
    return c.allowed ? null : (c.reason ?? "content blocked");
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
    const vals = Array.isArray(value) ? value : Object.values(value);
    for (const v of vals) {
      const hit = pageJsonBlocked(v, seen);
      if (hit) return hit;
    }
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/* ------------------------------------------------------------------ */
/* POST /api/liaison/verify-tip                                        */
/* ------------------------------------------------------------------ */

/**
 * Verify a tip to the liaison on-chain and grant credits for ONE product.
 * Body: { txHash, product } | { scan: true, product }.
 * product is required: "chat" (5 HBAR → 50 messages) or "build" (5 HBAR →
 * 1 page build). Brandon's call: no bundle — each product is bought
 * separately, and grants accumulate (a second chat tip adds 50 more
 * messages on top of what the wallet already has).
 *
 * Verification is mirror-node truth: the transaction must be a successful
 * contract call, and its logs must contain a TipSent from the session
 * wallet to danny's owner for at least the product's price, with the
 * keccak256("danny") username topic. Anti-replay: the normalized tx ref is
 * claimed once via setNx.
 */
export async function handleVerifyTip(
  deps: LiaisonDeps,
  addr: string,
  body: unknown,
): Promise<HandlerResult> {
  const b = asRecord(body) ?? {};
  const nowMs = deps.nowMs();
  const product: LiaisonProduct | null =
    b.product === "chat" || b.product === "build" ? b.product : null;
  if (!product) {
    return err(400, "product is required — 'chat' (50 messages) or 'build' (1 page build)");
  }
  const price = product === "chat" ? deps.chatPriceHbar : deps.buildPriceHbar;
  const productNoun = product === "chat" ? "chat session" : "page build";

  let claimId: string | null = null;

  if (b.scan === true) {
    // Fallback: the user lost their tx hash — sweep recent Tips logs for
    // the newest unconsumed qualifying tip from this wallet.
    let res: MirrorGetResult;
    try {
      res = await deps.mirrorGet(
        `/api/v1/contracts/${LIAISON_TIPS_CONTRACT_ID}/results/logs?order=desc&limit=50`,
      );
    } catch {
      return err(502, "mirror node unreachable — try again in a moment");
    }
    if (!res.ok) return err(502, "mirror node unreachable — try again in a moment");
    const logs = asRecord(res.json)?.logs;
    if (!Array.isArray(logs)) return err(502, "unexpected mirror node response");
    for (const log of logs) {
      if (!isLiaisonTipLog(log, addr, price)) continue;
      const txHash = asRecord(log)?.transaction_hash;
      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) continue;
      const claimed = await deps.kv.setNx(liaisonTipKey(txHash.toLowerCase()), addr, LIAISON_TIP_CLAIM_TTL_MS);
      if (!claimed) continue; // already used — keep scanning for a fresh one
      claimId = txHash.toLowerCase();
      break;
    }
    if (!claimId) {
      return err(
        404,
        `no unused tip to danny of at least ${price} HBAR found for this wallet — tip first, then verify`,
      );
    }
  } else {
    const ref = normalizeTxRef(b.txHash);
    if (!ref) {
      return err(400, "txHash must be a Hedera transaction id (0.0.x@seconds.nanos) or 0x hash");
    }
    let txRes: MirrorGetResult;
    let resultRes: MirrorGetResult;
    try {
      txRes = await deps.mirrorGet(`/api/v1/transactions/${ref}`);
      resultRes = await deps.mirrorGet(`/api/v1/contracts/results/${ref}`);
    } catch {
      return err(502, "mirror node unreachable — try again in a moment");
    }
    if (!txRes.ok || !resultRes.ok) {
      return err(502, "mirror node unreachable — try again in a moment");
    }
    const txs = asRecord(txRes.json)?.transactions;
    const tx = Array.isArray(txs) ? txs[0] : undefined;
    if (!isSuccessfulContractCall(tx)) {
      return err(400, "that transaction is not a successful contract call");
    }
    const logs = asRecord(resultRes.json)?.logs;
    const matched =
      Array.isArray(logs) && logs.some((l) => isLiaisonTipLog(l, addr, price));
    if (!matched) {
      return err(
        404,
        `no qualifying tip found in that transaction — it must tip danny at least ${price} HBAR for a ${productNoun} from your connected wallet`,
      );
    }
    const claimed = await deps.kv.setNx(liaisonTipKey(ref), addr, LIAISON_TIP_CLAIM_TTL_MS);
    if (!claimed) return err(409, "this tip was already used — each tip unlocks one product");
    claimId = ref;
  }

  // Accumulate: a new grant adds to whatever the wallet already has (each
  // product bought separately, no bundle). Every grant extends the 7-day
  // window from now.
  const prev = await readEntitlement(deps, addr);
  const live = prev && entitlementAlive(prev, nowMs) ? prev : { chatLeft: 0, buildsLeft: 0, expMs: 0 };
  const ent: LiaisonEntitlement = {
    chatLeft: live.chatLeft + (product === "chat" ? LIAISON_CHAT_PER_PAYMENT : 0),
    buildsLeft: live.buildsLeft + (product === "build" ? LIAISON_BUILDS_PER_PAYMENT : 0),
    expMs: nowMs + LIAISON_ENTITLEMENT_TTL_MS,
  };
  await writeEntitlement(deps, addr, ent);

  // Revenue sweep: forward the liaison's own received share to treasury.
  // Best-effort and bounded — a slow/failed sweep must never fail the
  // verification response, so it runs with a short timeout and any miss
  // simply leaves the funds in the liaison wallet for the next sweep.
  let sweepTxId: string | null = null;
  if (deps.afterTipVerified) {
    try {
      sweepTxId = await withTimeout(deps.afterTipVerified(), 15_000);
    } catch {
      sweepTxId = null;
    }
  }
  return ok({
    ok: true,
    claimId,
    product,
    chatLeft: ent.chatLeft,
    buildsLeft: ent.buildsLeft,
    expMs: ent.expMs,
    priceHbar: price,
    forwarded: sweepTxId !== null,
    ...(sweepTxId ? { sweepTxId } : {}),
  });
}

/** Resolve a promise, or null when it rejects or exceeds `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<T | null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/* ------------------------------------------------------------------ */
/* GET /api/liaison/status                                             */
/* ------------------------------------------------------------------ */

/** Public price + (when authed) the wallet's entitlement. addr may be null. */
export async function handleStatus(
  deps: LiaisonDeps,
  addr: string | null,
): Promise<HandlerResult> {
  // No free tier (Brandon's call): the Danny paywall starts at the first
  // message. The regular builder stays free — that path never calls here.
  const base: Record<string, unknown> = {
    chatPriceHbar: deps.chatPriceHbar,
    buildPriceHbar: deps.buildPriceHbar,
    chatPerPayment: LIAISON_CHAT_PER_PAYMENT,
    buildsPerPayment: LIAISON_BUILDS_PER_PAYMENT,
  };
  if (!addr) return ok(base);
  const nowMs = deps.nowMs();
  const ent = await readEntitlement(deps, addr);
  const alive = ent && entitlementAlive(ent, nowMs) ? ent : null;
  // One-time congratulations: set by publish-confirm when a Danny-built
  // page goes live. The panel shows it once, then it's cleared.
  let celebratedUsername: string | null = null;
  try {
    const raw = await deps.kv.get(`liaison:celebrate:${addr.toLowerCase()}`);
    if (raw) {
      const c = JSON.parse(raw) as { username?: string };
      if (typeof c.username === "string" && c.username) {
        celebratedUsername = c.username;
        await deps.kv.del(`liaison:celebrate:${addr.toLowerCase()}`);
      }
    }
  } catch {
    /* celebration is best-effort */
  }
  return ok({
    ...base,
    chatLeft: alive ? alive.chatLeft : 0,
    buildsLeft: alive ? alive.buildsLeft : 0,
    expMs: alive ? alive.expMs : null,
    ...(celebratedUsername ? { celebratedUsername } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/liaison/chat                                              */
/* ------------------------------------------------------------------ */

/**
 * Deterministic KB answers ($0, no LLM in slice 1). Every message costs
 * one paid chat credit — there is no free tier. 402 when the session has
 * no messages left.
 */
export async function handleChat(
  deps: LiaisonDeps,
  addr: string,
  body: unknown,
): Promise<HandlerResult> {
  const b = asRecord(body) ?? {};
  const message = typeof b.message === "string" ? b.message : "";
  if (!message.trim()) return err(400, "message is required");
  if (message.length > LIAISON_MAX_MESSAGE_CHARS) {
    return err(400, `message is too long (max ${LIAISON_MAX_MESSAGE_CHARS} chars)`);
  }
  const contentCheck = checkContent(message, "chat message");
  if (!contentCheck.allowed) {
    return err(400, contentCheck.reason ?? "message blocked");
  }

  const nowMs = deps.nowMs();
  let ent = await readEntitlement(deps, addr);
  if (ent && !entitlementAlive(ent, nowMs)) ent = null;
  if (!ent || ent.chatLeft <= 0) {
    return err(
      402,
      `chat with Danny is paid — ${deps.chatPriceHbar} HBAR unlocks ${LIAISON_CHAT_PER_PAYMENT} messages`,
      { chatPriceHbar: deps.chatPriceHbar },
    );
  }
  ent = { ...ent, chatLeft: ent.chatLeft - 1 };
  await writeEntitlement(deps, addr, ent);

  const found = findLiaisonAnswer(message, deps.chatPriceHbar, deps.buildPriceHbar);
  const answer = found ? found.answer : LIAISON_UNKNOWN_FALLBACK;
  const entryId = found ? found.entryId : "unknown";

  // Short rolling history (last 10, 24h) — lets follow-ups read naturally.
  try {
    const raw = await deps.kv.get(liaisonHistKey(addr));
    const hist = raw ? (JSON.parse(raw) as unknown[]) : [];
    const next = [
      ...(Array.isArray(hist) ? hist : []),
      { role: "user", text: message.slice(0, LIAISON_MAX_MESSAGE_CHARS), ts: nowMs },
      { role: "assistant", text: answer.slice(0, 2000), ts: nowMs },
    ].slice(-LIAISON_HISTORY_LIMIT);
    await deps.kv.set(liaisonHistKey(addr), JSON.stringify(next), LIAISON_HISTORY_TTL_MS);
  } catch {
    // History is a nicety — never fail the chat over it.
  }

  return ok({
    answer,
    entryId,
    chatLeft: ent.chatLeft,
    buildsLeft: ent.buildsLeft,
  });
}

/* ------------------------------------------------------------------ */
/* /api/liaison/draft (GET / POST / DELETE)                            */
/* ------------------------------------------------------------------ */

export interface LiaisonDraft {
  draftId: string;
  pageJson: VoicescapePage;
  usernameHint: string | null;
  templateId: string;
  status: "draft";
  createdAtMs: number;
  expMs: number;
}

function parseDraft(raw: string | null): LiaisonDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<LiaisonDraft>;
    if (typeof d.draftId !== "string" || typeof d.templateId !== "string") return null;
    if (!d.pageJson || typeof d.pageJson !== "object") return null;
    return d as LiaisonDraft;
  } catch {
    return null;
  }
}

export async function handleDraftGet(deps: LiaisonDeps, addr: string): Promise<HandlerResult> {
  const draft = parseDraft(await deps.kv.get(liaisonDraftKey(addr)));
  if (!draft) return err(404, "no draft for this wallet");
  return ok({ draft });
}

export async function handleDraftDelete(deps: LiaisonDeps, addr: string): Promise<HandlerResult> {
  await deps.kv.del(liaisonDraftKey(addr));
  return ok({ ok: true });
}

/**
 * Assemble a deterministic premade blockpage from a human template plus
 * the guided form. Costs one paid build credit (no free tier for builds).
 * The draft is bound to the session wallet: one active draft per wallet,
 * overwritten on each new request, deleted on publish/discard/expiry.
 */
export async function handleDraftPost(
  deps: LiaisonDeps,
  addr: string,
  body: unknown,
): Promise<HandlerResult> {
  const b = asRecord(body) ?? {};
  const nowMs = deps.nowMs();

  let ent = await readEntitlement(deps, addr);
  if (!ent || !entitlementAlive(ent, nowMs) || ent.buildsLeft <= 0) {
    return err(
      402,
      `page builds are paid — ${deps.buildPriceHbar} HBAR per build`,
      { buildPriceHbar: deps.buildPriceHbar },
    );
  }

  const templateId = typeof b.templateId === "string" ? b.templateId : "";
  const template = TEMPLATES.find((t) => t.id === templateId);
  if (!template) return err(400, "unknown templateId");
  if (template.page.ownerType === "agent") {
    // The liaison builds for humans; agent templates carry operator
    // disclosure blocks that must never ship on a human page.
    return err(400, "agent templates aren't offered by the liaison");
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const displayName = str(b.displayName).trim().slice(0, 60);
  const heroTitle = str(b.heroTitle).trim().slice(0, 120);
  const bio = str(b.bio).trim().slice(0, 500);
  const accent = str(b.accent).trim();
  const hintRaw = str(b.usernameHint).trim().toLowerCase();
  const usernameHint = /^[a-z0-9_-]{3,32}$/.test(hintRaw) ? hintRaw : null;

  // Deep-clone so template definitions are never mutated.
  const page = JSON.parse(JSON.stringify(template.page)) as VoicescapePage;
  // Non-custody: liaison drafts are ALWAYS human pages. The publish path
  // asserts this again, but the draft itself must never carry agent fields.
  page.ownerType = "human";
  delete page.purpose;
  page.blocks = page.blocks.filter((blk) => blk.type !== "operator");

  for (const blk of page.blocks) {
    if (blk.type === "hero") {
      if (displayName) blk.title = displayName;
      if (heroTitle) blk.subtitle = heroTitle;
    } else if (blk.type === "bio") {
      if (bio) blk.text = bio;
    }
  }
  if (/^#[0-9a-fA-F]{6}$/.test(accent)) {
    page.theme = { ...page.theme, accent };
  }

  const blocked = pageJsonBlocked(page);
  if (blocked) return err(400, blocked);
  if (!isValidPage(page)) return err(400, "assembled page failed schema validation");
  const bytes = JSON.stringify(page).length;
  if (bytes > LIAISON_MAX_DRAFT_BYTES) {
    return err(400, "draft is too large");
  }

  const draftId = `d_${nowMs.toString(36)}_${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  const draft: LiaisonDraft = {
    draftId,
    pageJson: page,
    usernameHint,
    templateId: template.id,
    status: "draft",
    createdAtMs: nowMs,
    expMs: nowMs + LIAISON_DRAFT_TTL_MS,
  };
  // One active draft per wallet: plain set overwrites any previous draft.
  await deps.kv.set(liaisonDraftKey(addr), JSON.stringify(draft), LIAISON_DRAFT_TTL_MS);

  ent = { ...ent, buildsLeft: ent.buildsLeft - 1 };
  await writeEntitlement(deps, addr, ent);

  return ok({
    ok: true,
    draftId,
    templateId: template.id,
    usernameHint,
    buildsLeft: ent.buildsLeft,
  });
}

/* ------------------------------------------------------------------ */
/* POST /api/liaison/publish-confirm                                    */
/* ------------------------------------------------------------------ */

/**
 * Confirm the user's own registerPage transaction on the mirror node, then
 * delete their draft. The liaison never publishes — this only verifies the
 * wallet-signed handoff happened: the tx must be a successful contract
 * call whose calldata registers `username`, with a PageRegistered log
 * naming this wallet as owner.
 */
export async function handlePublishConfirm(
  deps: LiaisonDeps,
  addr: string,
  body: unknown,
): Promise<HandlerResult> {
  const b = asRecord(body) ?? {};
  const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    return err(400, "username must be 3–32 chars: lowercase letters, numbers, hyphens");
  }
  const ref = normalizeTxRef(b.txHash);
  if (!ref) {
    return err(400, "txHash must be a Hedera transaction id (0.0.x@seconds.nanos) or 0x hash");
  }

  let txRes: MirrorGetResult;
  let resultRes: MirrorGetResult;
  try {
    txRes = await deps.mirrorGet(`/api/v1/transactions/${ref}`);
    resultRes = await deps.mirrorGet(`/api/v1/contracts/results/${ref}`);
  } catch {
    return err(502, "mirror node unreachable — try again in a moment");
  }
  if (!txRes.ok || !resultRes.ok) {
    return err(502, "mirror node unreachable — try again in a moment");
  }
  const txs = asRecord(txRes.json)?.transactions;
  const tx = Array.isArray(txs) ? txs[0] : undefined;
  if (!isSuccessfulContractCall(tx)) {
    return err(400, "that transaction is not a successful contract call");
  }
  const result = asRecord(resultRes.json);
  const registeredName = decodeRegisterUsername(result?.function_parameters);
  if (registeredName !== username) {
    return err(400, "that transaction does not register this username");
  }
  const logs = result?.logs;
  const owned =
    Array.isArray(logs) && logs.some((l) => isOwnPageRegisteredLog(l, username, addr));
  if (!owned) {
    return err(400, "no on-chain registration found for your wallet and this username");
  }

  // Publish confirmed — the draft's job is done. Delete it: the page is
  // now the user's alone, and the liaison keeps no copy. Record the
  // completion so the panel can congratulate the user on their next visit.
  await deps.kv.del(liaisonDraftKey(addr));
  try {
    await deps.kv.set(
      `liaison:celebrate:${addr.toLowerCase()}`,
      JSON.stringify({ username, atMs: deps.nowMs() }),
      7 * 24 * 3600_000, // 7 days — plenty of time for the user to come back
    );
  } catch {
    /* celebration is a nicety — never fail the confirm over it */
  }
  return ok({ ok: true, username });
}
