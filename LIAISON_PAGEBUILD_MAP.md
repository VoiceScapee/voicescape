# Liaison "Build Me a Blockpage" — Logic & Hedera Pathways Map

**Status:** DESIGN ONLY. Nothing here is implemented. No deploys.
**Prime directive (Brandon, 2026-09-14):** the liaison is a *hired helper, never a custodian*.
The user pays for help (answers, builds). Once a blockpage is published, the
liaison has **zero** access to it — no update rights, no operator role, no
retained keys or sessions. All control stays with the user, permanently.

Glossary: "liaison" = the AI helper behind the `/danny` blockpage (AGENT page,
owner `0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca`, the operator key in
`~/workspace/ops/agent-outreach/`). In the tip-gated design the liaison is
*request/response server code behind session-authenticated API routes* — there
is no daemon holding user keys, which is itself a non-custody guarantee.

---

## 1. End-to-end user flow

1. **Connect wallet.** User opens `/danny`, taps Connect (HashPack via
   `@hashgraph/hedera-wallet-connect` DAppConnector, HIP-820 — existing).
2. **Sign in.** 1-tinybar self-transfer carrying a login memo (existing flow),
   verified server-side via mirror node → stateless HMAC session token
   (`x-vs-session` header, `sessionCredentialFrom` in
   `lib/server/townhall/route-auth.ts`, claims `{v,addr,chainId,nonce,iat,exp}`,
   7-day expiry). No server-side session storage exists.
3. **Pay.** User taps "Get help" → wallet prompts
   `Tips.tipPage("danny", value)` (contract `0.0.10854060`). 98% → liaison
   wallet, 2% → treasury `0.0.10424063`, atomically, no escrow. UI shows the
   price Brandon sets (open question §8).
4. **Verify.** Client sends the tx hash to `POST /api/liaison/verify-tip`
   (§4). Server confirms on the mirror node, marks the tx consumed
   (anti-replay), grants entitlement: e.g. N chat messages + M page builds,
   7-day expiry.
5. **Chat.** "Talk to Danny" panel (`/danny` block or `/danny/chat` route —
   Brandon's call). `POST /api/liaison/chat` (session-auth, decrements
   `chatLeft`). Slice 1: answers from the existing support knowledge base
   (deterministic retrieval, $0). User asks questions about Voicescape.
6. **"Build me a page."** User picks a starting template (from
   `lib/templates.ts` — business-card, agent-personal, agent-storefront…)
   and answers a short guided form (vibe, colors, blocks, username idea).
   `POST /api/liaison/draft` assembles validated page JSON (via
   `isValidPage` in `lib/schema.ts` + `checkContent` PII filter), stores it
   **bound to the user's wallet** (§2), decrements `buildsLeft`.
7. **Premade template appears.** User opens `/builder` → a "✨ Made for you"
   card sits atop the template grid (fetched with their session). Selecting it
   loads *their* draft JSON into the canvas. Existing builder preview works
   with no wallet (already true today).
8. **Review / tweak.** Full builder: edit blocks, or refine with the builder's
   existing BYOK AI chat (`lib/byok.ts` — user's own Anthropic key, browser →
   api.anthropic.com, server never sees key or pays).
9. **Publish (the handoff).** Identical to today's builder flow:
   `pinPageJson` → `POST /api/pin` (their session, PII check, quota) → CID →
   **user's wallet signs** `Registry.registerPage(username, cid, 0,
   0x000…0, "")` via DAppConnector. Draft is deleted on success. From this
   point the page is theirs alone (§2 non-custody).

What the liaison NEVER does: sign anything for the user, hold user funds,
publish on the user's behalf, or appear as operator on a user page.

## 2. "Premade template unique to wallet login" — mechanism

**Binding.** Drafts live in the KV store (`getKvStore()`, `lib/server/store.ts`),
keyed strictly by wallet:

- `vs:liaison:draft:{addr}` → JSON `{draftId, pageJson, usernameHint,
  templateId, status: "draft"|"published", createdAtMs, expMs}`.
  `addr` = lowercase EVM address from the *verified* session. **Every**
  read/write/delete requires `sessionCredentialFrom(req)` → `verifySession`
  → `claims.addr === key addr`. A different wallet (or no session) gets 401/403.
  There is no cross-wallet read path, no admin backdoor in the design.

**One-active-draft rule.** `POST /api/liaison/draft` overwrites
`vs:liaison:draft:{addr}` (plain `set`, not `setNx`). A new request replaces
the old draft; the old JSON is gone. This is what "unique for their wallet
login" means in practice: one personal premade template per wallet.

**Lifecycle & expiry.**
- TTL 30 days (matches DM `DM_TTL_MS` convention) — `set(key, value, 30d)`.
- `status:"published"` + `del()` immediately after a confirmed publish
  (client reports the registerPage tx hash; server confirms `PageRegistered`
  on the mirror node, then deletes).
- Explicit "Discard" button → `del()`.
- Never-published: key expires silently. No on-chain trace was ever created
  (nothing was registered), the 30-min username soft-reservation (§5) lapses
  on its own, and the user can re-request (costs another build credit).

**Unrecoverable after publish/end.** Deletion is `del()` on the single key.
No replicas of draft JSON exist elsewhere by design: never written to logs
(`client-error` telemetry stores aggregates only), never emailed, never sent
to a third party. Content-filter runs in-process.

**Draft-phase access scoping.** During the paid session the liaison (server
code inside the authenticated request handler) may read the draft to
generate/serve/regenerate it. That access exists only inside the request
lifetime, only for the session's own address, and ends permanently at
publish/discard/expiry. There is no standing grant, no service account, no
shared secret that could reopen it.

## 3. Every Hedera interaction in the flow

| # | Interaction | Contract / endpoint | Who signs | When |
|---|-------------|---------------------|-----------|------|
| 1 | Sign-in | 1-tinybar self-transfer w/ login memo; verified via `GET /api/v1/transactions?account.id=…` | User wallet | Step 2, once per 7 days |
| 2 | Tip (payment) | `VoicescapeTips.tipPage(string username)` `0.0.10854060`, `value` = price | User wallet (DAppConnector) | Step 3 |
| 3 | Tip verification | Mirror node `GET /api/v1/transactions/{txHash}` → confirm consensus, `tipPage` calldata, `username="danny"`, `from` = session addr, amount ≥ price. Fallback sweep: `GET /api/v1/contracts/0.0.10854060/results/logs`, decode `TipSent` via `decodeTipSentLog` (`lib/leaderboard.ts`, `TIPSENT_TOPIC`) | Server reads only | Step 4 |
| 4 | Username availability | `GET /api/resolve?username={name}` → 404 = free (server calls `Registry.resolvePage` view; Registry EVM `0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58`) | Nobody (view) | Steps 6–7, re-checked at 9 |
| 5 | Pin page JSON | `POST /api/pin` → Pinata (JWT server-side, 1 MB cap, PII filter) | Nobody on-chain (session-auth HTTP) | Step 9 |
| 6 | **Publish (the handoff)** | `VoicescapeRegistry.registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)` `0.0.10854058` with `(name, cid, 0, 0x000…0, "")` | **User wallet only** | Step 9 |
| 7 | Publish confirmation | Mirror node `PageRegistered` event (`PAGEREGISTERED_TOPIC`, `lib/registry-topics.ts`) for `(username, owner=user)` | Server reads only | Step 9, then draft deleted |
| 8 | Later edits by user | `Registry.updatePage(username, newCid)` | User wallet only (contract enforces `page.owner == msg.sender`, else `NotPageOwner`) | Anytime post-publish |

**Registry methods involved (exact, from `contracts/contracts/VoicescapeRegistry.sol`):**
`registerPage(string,string,OwnerType,address,string)`,
`updatePage(string,string)`, `resolvePage(string)` (view),
`usernameExists(string)` (view), `validateUsername(string)` (pure).
Events: `PageRegistered`, `PageUpdated`.

**Non-custody facts the design rests on (verified in the contract source):**
- `registerPage` sets `owner = msg.sender`. There is **no** transfer-ownership
  or set-operator function — ownership can never move or be seized.
- `updatePage` reverts unless `msg.sender == page.owner`. The `operator`
  field is **informational/disclosure only**; no function reads it for auth.
- `ownerType` is immutable once set. Human pages are registered with
  `ownerType=0`, `operator=0x0`, `purpose=""` — the liaison's address appears
  nowhere.
- Builder already defaults `operator = ZERO_ADDRESS` for human pages
  (`app/builder/page.tsx:1617`); the liaison publish path reuses that code
  unchanged. Add an assertion: liaison-assisted publishes must reject
  `ownerType != 0`.

## 4. Payment unlock logic

**Pricing (Brandon, 2026-09-14):** `LIAISON_CHAT_PRICE_HBAR` (default 5) buys 50 chat messages; `LIAISON_BUILD_PRICE_HBAR` (default 5) buys 1 page build. No bundle, no free tier — each product bought separately via `verify-tip` with `product: "chat" | "build"`; grants accumulate and every grant extends the 7-day window. Floor:
`LIAISON_PRICE_FLOOR_HBAR` (default 1 HBAR) — a boot-time assertion in the
route layer refuses to serve paid liaison routes when the configured price
sits below the floor, so a misconfiguration can never make it loss-making.
Margin math: slice 1 marginal cost ≈ $0 (no LLM, Pinata free tier, mirror
node free) — economics invariant holds trivially.

**No free tier** (Brandon's call 2026-09-14): the Danny paywall starts at
the first message — every chat message and every help-build costs a fee.
The regular builder stays free for anyone who builds themselves; the
paywall applies ONLY to the Danny liaison panel and `/api/liaison/*`
routes.

**Revenue forwarding.** Tips to the danny page split 98/2 atomically in the
Tips contract (98% → liaison wallet, 2% → treasury). After each verified
tip, a sweep forwards the liaison wallet's received share to the Voicescape
treasury (0.0.10424063), keeping a reserve (`LIAISON_FORWARD_RESERVE_HBAR`,
default 1 HBAR) for its own transfer fees. The sweep fires when the
forwardable balance (balance − reserve) exceeds
`LIAISON_FORWARD_THRESHOLD_HBAR` (default 0 = forward everything above the
reserve). The liaison signs ONLY for its own wallet (key from the
`LIAISON_FORWARDER_KEY` env) — never user keys, never user funds. The sweep
is best-effort and bounded (15s timeout): it never fails a tip
verification; funds simply wait in the liaison wallet for the next sweep.
Without the key configured, sweeps are skipped and tips accumulate in the
liaison wallet.

**Verify-tip (`POST /api/liaison/verify-tip`, NEW, session-auth + `ipGate`):**
1. Body: `{txHash}`. Validate shape (`0.0.x@seconds.nanos` or 0x hash).
2. `GET https://mainnet.mirrornode.hedera.com/api/v1/transactions/{txHash}`:
   confirm `result == "SUCCESS"`, `name == "CONTRACTCALL"` (or `CONTRACT_CALL`),
   `function_parameters` decodes to `tipPage("danny")`, `charged_tx_fee` sane,
   transfer list shows value ≥ price landing at the Tips contract, and the
   transaction's payer/`from` equals the session address.
3. Anti-replay: `setNx("vs:liaison:tip:{txHash}", addr, 30d)` — false means
   already consumed → 409.
4. Grant: `set("vs:liaison:ent:{addr}", JSON{chatLeft, buildsLeft, expMs:
   now+7d, tier}, 7d)`.
5. Fallback if the user lost the hash: `POST /api/liaison/verify-tip`
   `{scan:true}` sweeps recent Tips logs (`/contracts/0.0.10854060/results/logs`,
   `decodeTipSentLog`), matches `from == addr && to == liaisonWallet &&
   amount ≥ price` and `username` topic == keccak("danny"), picks the newest
   unconsumed tx, then proceeds as above.

**Entitlement consumption.** `POST /api/liaison/chat` and
`POST /api/liaison/draft` load `vs:liaison:ent:{addr}`; 402 when missing/
expired/empty; decrement the relevant counter and `set` back (same TTL).
Counters are integers; no fractional use.

**Refund policy.** Tips are non-refundable on-chain (atomic split, no escrow
— state this in the UI before payment).

## 5. Username selection

- **Availability check:** `GET /api/resolve?username={name}` — 404 means free.
  Also client-side `validateUsername` rules (3–32 chars, `a-z0-9_-`,
  lowercased) mirrored from the contract.
- **Collision suggestions:** on taken, suggest `{name}{n}`, `{name}-page`,
  verb variants; each re-checked live. Deterministic, no LLM needed.
- **Reservation limits (honest):** a username **cannot** be reserved on-chain
  without a signed `registerPage` tx, and the liaison must never send one for
  the user. Instead: soft reservation `setNx("vs:liaison:username:{name}",
  addr, 30min)` — reduces double-claim races between two liaison users, but
  the *final* authority is the contract's `UsernameTaken` revert at publish.
  UI must handle it gracefully ("taken just now — pick another"), and the
  soft reservation is advisory only, never shown as ownership.
- The draft stores `usernameHint`, not a claim. The builder's publish step
  re-checks via `/api/resolve` immediately before the wallet prompt (pattern
  already exists at `builder/page.tsx` `publishName`).

## 6. Abuse controls

- **Per-IP:** `ipGate` on all four new routes (pattern from
  `/api/agents/directory`, `/api/dms`) — Sybil bound.
- **Per-wallet daily quotas** via `globalQuotaStore()`:
  `liaison:chat` (e.g. 50/day), `liaison:draft` (e.g. 3/day),
  `liaison:verify-tip` (e.g. 20/day), `liaison:status` (e.g. 100/day).
  Env-tunable (`quotaLimitFromEnv` pattern).
- **Entitlement caps:** chatLeft/buildsLeft per tip (Brandon's pricing, §8);
  one active draft per wallet (§2).
- **Content:** `checkContent` on every user message and every generated JSON
  string (reuse `pageJsonPiiCheck` pattern from `/api/pin`); PII can never be
  stored or pinned (IPFS is immutable).
- **Cost guards:** draft JSON hard cap 100 KB pre-pin (pin allows 1 MB);
  chat message cap 1000 chars (DM `DM_MAX_LEN` convention); chat history kept
  to last 10 messages per wallet, KV TTL 24 h, never logged. Slice 1 has no
  LLM → $0 marginal cost; slice 2 BYOK keeps it $0 (user's key); slice 3
  server LLM only if tip margin provably covers it (needs Brandon's numbers).
- **No PII:** keys are wallet addresses only; no names/emails/IPs persisted
  (existing codebase rule).

## 7. API endpoints, data model, phased plan

**New routes (all `runtime = "nodejs"`, session-auth via `x-vs-session`):**

| Route | Purpose | Reuses |
|-------|---------|--------|
| `POST /api/liaison/verify-tip` | Verify tip tx on mirror node, anti-replay, grant entitlement | `decodeTipSentLog`, `getKvStore().setNx/set`, `ipGate` |
| `GET /api/liaison/status` | Return `{chatLeft, buildsLeft, expMs}` | entitlement read |
| `POST /api/liaison/chat` | KB answer, decrement chatLeft | content filter, quota |
| `POST /api/liaison/draft` | Assemble + validate + store draft, decrement buildsLeft | `TEMPLATES`, `isValidPage`, `checkContent` |
| `GET /api/liaison/draft` | Fetch my draft (addr must match session) | — |
| `DELETE /api/liaison/draft` | Discard my draft | — |
| `POST /api/liaison/publish-confirm` | Confirm `PageRegistered`, delete draft | mirror-node read |

**Reused unchanged:** `/api/auth/*` (sign-in), `/api/pin` (pinning),
`/api/resolve` (availability), `/api/agents/directory` (social proof),
builder publish flow (`pinPageJson` → `registerPage`/`updatePage` via
DAppConnector), `TEMPLATES`, BYOK chat.

**Data model (KV, all TTL'd):**
- `vs:liaison:ent:{addr}` — `{chatLeft, buildsLeft, expMs, tier}` (7d)
- `vs:liaison:tip:{txHash}` — `addr` (30d, anti-replay)
- `vs:liaison:draft:{addr}` — `{draftId, pageJson, usernameHint, templateId, status, createdAtMs, expMs}` (30d, one per wallet)
- `vs:liaison:username:{name}` — `addr` (30min, soft reservation)
- `vs:liaison:hist:{addr}` — last 10 chat messages (24h)

**Phased build plan:**
- **Slice 0 — decisions.** Brandon answers §8. No code.
- **Slice 1 — shippable, $0, no new secrets.** verify-tip + entitlement +
  KB chat + deterministic draft-from-template + "Made for you" card in
  builder + user-signed publish + draft deletion. No LLM anywhere.
  This is the smallest slice that earns revenue.
- **Slice 2 — BYOK generation.** Liaison chat offers "generate with my key":
  browser-side Anthropic call reusing `VIBECODE_SYSTEM_PROMPT`
  (`lib/byok.ts`), output validated by `isValidPage` before it becomes a
  draft. Server cost stays $0.
- **Slice 3 — server LLM (only if funded).** Needs `ANTHROPIC_API_KEY` via
  Secure Vault + pricing math proving tip margin covers inference at 1.5x+.
  Parked until then.
- **Later — x402 upgrade.** When the x402 secrets are recovered, swap the
  tip-gate for pay-per-request; the entitlement abstraction already isolates
  payment from the rest of the flow.

**Non-custody acceptance criteria (must hold at every slice):**
1. No API route accepts a private key, seed phrase, or signing request.
2. The operator key (`~/workspace/ops/agent-outreach/operator.key`) is never
   imported by liaison routes; it signs HCS/agent-comms only.
3. No "publish on behalf" endpoint exists; publish is always the user's
   wallet signature in their browser.
4. Human registrations always `(ownerType=0, operator=0x0, purpose="")` —
   asserted in code, not just convention.
5. Draft reads require session addr == draft addr; drafts are deleted on
   publish/discard/expiry and never logged.

## 8. Brandon's calls (decided 2026-09-14)

1. **Price:** `LIAISON_CHAT_PRICE_HBAR` = 5 HBAR per 50-message chat session; `LIAISON_BUILD_PRICE_HBAR` = 5 HBAR per page build — both env-tunable, both floored at 1 HBAR.
2. **What's included:** bought separately per product; grants accumulate (a second chat purchase adds 50 more messages); 7-day TTL extended on every grant.
3. **Free tier:** none — paywall from the first message.
4. **Revenue:** 98/2 tip split on-chain; liaison sweeps its share to treasury
   (1 HBAR reserve), keeping nothing else.
5. **Self-serve:** the regular builder stays free; the paywall applies only
   to the Danny liaison panel/routes.
6. **Never lose money:** price-floor boot assertion (`LIAISON_PRICE_FLOOR_HBAR`,
   default 1 HBAR) — routes 503 when misconfigured below the floor.

---

### Lingering-control audit (codebase, 2026-09-14)

| Risk | Finding | Prevention in this design |
|------|---------|---------------------------|
| Liaison listed as `operator` on user pages | `operator` is auth-inert (no function reads it), but implies control | Force `0x0` for all human registrations; code assertion, §3 |
| Liaison calling `updatePage` on user pages | Contract reverts `NotPageOwner` — liaison addr ≠ owner, always | Nothing to do; contract-enforced |
| Ownership transfer to liaison | No transfer function exists in `VoicescapeRegistry.sol` (full read 2026-09-14) | Forbid adding one without Brandon's explicit go |
| Retained user session | Sessions are stateless HMAC; server stores none | Liaison routes verify per-request, never mint/store user tokens |
| Draft readable after publish | Single KV key, `del()` on confirmed publish | §2; no replicas by design |
| Operator key misuse | Key exists for HCS agent-comms | Never imported by liaison routes (§7 crit. 2) |
| Pinning = control | Pinning is content-addressed; only owner's registry tx matters | Publish is user-signed only |
| Username squatting by liaison | Liaison never sends `registerPage` | Soft reservation is KV-only, 30-min, advisory |
