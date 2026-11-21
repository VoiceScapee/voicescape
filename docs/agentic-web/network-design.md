# Network design — Voicescape assistant (open agentic web entry)

**Date:** 2026-11-21 · **Branch:** `danny/open-agentic-web-entry` · **Skill step:** 2 (design),
per `skills/agentify-website/SKILL.md` and `references/network_design.md`.
**Design source:** the win plan §5, validated or corrected here against the inventory
(`docs/agentic-web/inventory.md`). Anything marked **CORRECTION** differs from the plan
for a reason grounded in the repo or a live check. Nothing in this doc is built yet —
week 2 writes the `.hocon`, manifest, runtime copy, and site actions from it.

## Design decisions (skill defaults applied)

- **One front agent owning the tools; specialists only where they pass the skill's tests.**
  Three specialists survive the test (see below). Plain delegation with a `request`
  parameter — no AAOSA (it roughly doubles model calls per turn).
- **No `demo_mode`; facts only from tool results; a "cannot do" list in the grounding rules.**
- Shared rules in `commondefs.replacement_strings`; CRUSE rules on the front agent only.
- **Runtime limit carried forward:** the patched runtime offers **every** `website_*` tool
  to **every** agent (`runtime/runner.js`, `buildToolTable`) — a specialist is scoped only
  by its instructions. The tool-to-agent table below is therefore an *instructions*
  assignment, not an enforcement boundary.
- **CORRECTION — writes stay with the front agent.** The win plan's table gave the
  specialists `website_prepare_tip`, `website_prepare_claim`, and `website_stage_draft`.
  The skill says to "keep write and irreversible tools with the front agent unless there
  is a clear reason not to", and there is no such reason here: the front agent already
  owns the confirmation dialogs and the wallet-signature flow. Specialists get **reads
  only**; all writes and irreversible actions belong to `front_desk_coordinator`.

## Network

| Field | Value |
|---|---|
| Network name | `voicescape_assistant` (file `voicescape_assistant.hocon` → `voicescape_assistant.network.json`) |
| `front_man` | `front_desk_coordinator` |
| Mount page | **`/intros`** (confirmed — see below) |
| Runtime | Pinned skill runtime at `docs/agentic-web/pinned-spec/agentify-website/runtime/` (nsdeploy `23df164` lineage — see spec-pin.md; do NOT use the HEAD runtime) |
| Theme | Voicescape teal (`theme.primary`); assistant section per skill `templates/assistant-section.html` + `assistant.css` |

## Agents

| Agent | Why it exists (skill test passed) | Job | Tools (by instruction) |
|---|---|---|---|
| `front_desk_coordinator` (front_man) | — (owns everything) | Routes every request; owns all `website_*` tools; consolidates specialist answers; never invents; owns the confirmation dialogs and every irreversible action | All `website_*` tools; MCP descriptor (subset); `directory_specialist`, `payments_specialist`, `builder_specialist` |
| `directory_specialist` | **Separate knowledge** — intros envelope fields + 6-blockpage directory + Registry reads are a large reference body the front agent does not need for most turns | Who is here, what they do, what they charge/accept. Grounded in `/agents` directory, `/api/intros` (envelope fields), Registry reads | `website_lookup_blockpage`, `website_search_agents`, `website_get_directory`, `website_get_intros`, `website_get_blockpage`; MCP `search_agents` |
| `payments_specialist` | **Separate workflow** — tip/verify is a multi-step process with its own rules (propose → confirm → wallet signs → mirror receipt before reporting success) that would confuse the front agent's instructions | Tips, purchases, receipts. **Proposes**; never claims a payment happened until the mirror node says so | `website_get_blockpage`, `website_verify_tip`, `website_recent_tips`; MCP `verify_tip`, `verify_purchase`, `recent_tips`, `treasury_stats` |
| `builder_specialist` | **Separate workflow** — claim is an approval-link flow with its own rules (prepare → `/c/<id>` link → wallet signs `registerPage` → link) | Claim a blockpage / start a build. Grounded in the claim flow + `/builder`. Proposes; the wallet signs | `website_get_blockpage`; MCP `prepare_agent_claim`, `get_started`, `list_templates` |

## `website_*` tools (each wraps a real site function; bad input returns `{ok:false, reason}`)

### Reads (run without a dialog)

| Tool | Grounded in | Notes |
|---|---|---|
| `website_lookup_blockpage(username)` | `GET /api/resolve?username=` (`frontend/app/api/resolve/route.ts`); alias-aware via `lib/account-evm.ts` | Returns owner, ipfsHash, ownerType, operator, purpose. 503 = mirror unknown, not "not registered" |
| `website_search_agents(query)` | `GET /api/agents/directory` + client-side filter over the 6 entries | No text-search endpoint exists; filtering the directory list *is* the implementation — say so in the description, do not pretend a search index exists |
| `website_get_directory()` | `GET /api/agents/directory` | The 6 on-chain blockpages |
| `website_get_intros()` | `listAgentIntros()` via `GET /api/intros` (envelope fields served) | 23 intros, 15 with envelope fields (live Nov 21) |
| `website_get_blockpage(username)` | `/api/resolve` (purpose + ipfsHash) + IPFS fetch of the page JSON (`ipfs.io` / `gateway.pinata.cloud`) | **Week-2 verification item:** confirm the exact client fetch path for page JSON before writing this action; no dedicated content API exists |
| `website_verify_tip(tx)` | MCP `verify_tip` / mirror-node receipt check | Receipt only — never report success before the mirror node confirms |
| `website_recent_tips()` | MCP `recent_tips` | — |

### Writes — front agent only, all `irreversible`, all gated by the runtime confirmation dialog (visitor reviews destination + arguments), all ending in the visitor's wallet signature

| Tool | Grounded in | Dialog must show |
|---|---|---|
| `website_prepare_tip(username, amount)` | `TipModal.tsx` + `[username]/page.tsx` `TipBox` → `tipPage` (`lib/contracts.ts:167`); 98/2 split in one call | Recipient, amount, the 98/2 split, that the visitor's wallet will sign |
| `website_prepare_claim(username)` | MCP `prepare_agent_claim` → approval link `/c/<id>` (24 h TTL) → `registerPage` (`lib/contracts.ts:140`) | Name, tiny gas fee, that the link expires in 24 h. **CORRECTION:** the claim flow is the approval-link flow (`lib/server/claim-packages.ts`), not the retired `/agents/claim` paste-JSON screen. Week 2 must map the exact prepare→link→sign sequence before writing this action |
| `website_post_intro(handle, text, envelope)` | MCP `post_agent_intro` (free, no signature) | That it publishes under the visitor's name, 280-char text, no links, no edit/delete, 365-day TTL |
| `website_stage_draft(...)` | `stage_page_draft` (MCP) / `/builder` autosave | That the draft is browser-local until published |

## MCP descriptor (grounded capability)

The front agent references Voicescape's own MCP server, restricted read-only subset.
**All 7 verified present in the live 70-tool `tools/list` (Nov 21):**

```json
{"url": "https://voicescape.vercel.app/api/mcp",
 "tools": ["lookup_blockpage", "verify_tip", "search_agents", "recent_tips",
           "treasury_stats", "list_marketplace", "get_started"]}
```

CORS is already `*` on the endpoint; read rate limit is 100/hr per IP (fine for judging).
The runtime asks for user approval before discovering/calling a third-party MCP service;
same-origin MCP still goes through the runtime's tool path. Do **not** add write tools to
this descriptor in the entry — writes go through the `website_*` dialog path, where the
visitor sees them first.

## Mount page — `/intros` confirmed

| Candidate | Verdict | Reason |
|---|---|---|
| **`/intros`** | **Recommended** | Server component (ISR 60 s, `listAgentIntros()` direct) — the assistant mounts as a client island without disturbing the board; the board is where agents arrive and the assistant greets them there; the envelope data on this page is exactly what `directory_specialist` grounds in; the page still works if the assistant fails to boot (skill step 6 rule) |
| `/agents` | Second choice | Client component with wallet/session-dependent state; heavier host page; the directory data is equally groundable from `/intros` via `website_get_directory` |
| `/` (landing) | Rejected | Marketing surface, not where agents act; mounting there would put the assistant in front of humans who came to browse, not to talk to an agent |

## Peer link — shortlist (one, real, verified in week 3)

| Peer | Network / front | Why it fits | What week 3 must verify with `check_partner.mjs` |
|---|---|---|---|
| **Deadline Desk (primary)** | `deadline_desk` / `deadline_desk_assistant` — https://deadline-desk-agent.vercel.app/deadline_desk | Read-only hackathon board callable by peers; thematically perfect (it lists hackathons you can still enter, including this one); bridge shares three read actions | Network loads with `--origin https://voicescape.vercel.app`; consent card names it; a live cross-site call runs in the browser; nothing reaches the peer before the visitor agrees |
| **Agent Atlas (alternative)** | `agent_atlas` / `atlas_guide` — https://agent-atlas-phi.vercel.app/agent_atlas | Directory + spec-conformance checker + MCP server; running Voicescape's own conformance check through it in the video is meta and memorable | Same checks as above |

**Both verified live Nov 21:** `agent-manifest.json` 200, `links.json` 200, router
`https://api.otari.ai/api/v1` (BYOK). **Open risk on both:** each publishes
`peer_policy: {mode: "closed"}` with `allowed_peers` containing **only its own origin**.
Under a closed policy the runtime refuses other origins, so Voicescape's origin may be
refused until the peer's publisher adds `https://voicescape.vercel.app` to `allowed_peers`.
That would be a contact attempt to an outside publisher — **needs Brandon's go** and is
not assumed in this plan. If `check_partner.mjs` refuses our origin, the fallback is:
run the peer call from the video's demo path only if the peer allows it, otherwise
record the refusal honestly and keep the entry single-site (the peer call strengthens
the entry; it is not a Stage One requirement).

Partner-call rules carried from the skill: a partner call costs the visitor's key, max 4
per message / 1 per partner; the consent card shows only the first 140 characters of the
request while the partner gets all of it; never put a visitor's name, email, phone, or
booking code in a partner request.

## What the network must decline (in instructions)

Refunds (no refund function exists); escrow / buyer protection (platform never holds
funds); any claim about delivery or work beyond what a receipt proves (mirror node
notarizes payment, not work); anything requiring a key or signature the visitor has not
given; prices or availability not in a tool result; any feature the site does not have
(see inventory "Not supported").

## Sample queries (draft — from the inventory; final wording in week 2)

1. "Who on Voicescape builds blockpages for musicians, and what do they charge?"
   (directory + intros grounding)
2. "Show me the newest agent intros and what each one actually delivers."
   (envelope fields)
3. "Tip thechomps 1 HBAR for the build help." (irreversible — confirmation dialog,
   wallet signature, mirror receipt)
4. "Has tip 0.0.10854060-… settled, and who got what?" (receipt verification)
5. "How do I claim the username `myname`?" (claim approval-link flow)
6. "Can you refund my tip / hold my payment in escrow until the work is done?"
   (must decline honestly)

## Week-2 handoff (what the build must do first)

1. Build from the **pinned** skill + runtime in `docs/agentic-web/pinned-spec/` (see
   spec-pin.md) — not from spec `main`.
2. Fix the CSP in `frontend/vercel.json` before any browser test: add the chosen router
   origin to `connect-src` (Otari/OpenRouter/Groq as decided; Anthropic direct needs no
   change), add the peer origin to `connect-src` + `frame-src`, add
   `Access-Control-Allow-Origin: *` on the six public files, set the sandbox-worker CSP.
3. Map the claim approval-link sequence (`claim-packages.ts` → `/c/<id>` →
   `registerPage`) and the IPFS page-JSON fetch path before writing
   `website_prepare_claim` and `website_get_blockpage`.
4. `build_network.mjs --check` must pass with zero errors; fix warnings or record why
   one stays. Validate independently with the Agent Atlas conformance check and a
   NandaSeal audit before calling Stage One done.
5. Keep the page working when the assistant fails to boot; keep the mount to ONE page
   (`/intros`).

## Open decisions — only Brandon can make these (not decided here)

1. **Inference path:** BYOK-only (visitor's key, $0-safe) or a capped default path — and
   if default, what funds it (Otari credits if still available? Groq free tier — note
   Buddy already degrades on the free Groq quota)? Shapes what judges can run. Note:
   Anthropic-direct BYOK needs no CSP change; Otari/OpenRouter/Groq need a `connect-src` edit.
2. **Otari:** has he registered for the hackathon / claimed credits (first 100 registrants only)?
3. **Devpost:** does he have a Devpost account, or will he create one to register + join?
4. **Video:** will he record himself explaining the project on his phone (required — his
   voice, not TTS)? Needs a quiet window + the site final (week 5).
5. **Demo tip:** is he comfortable with the video showing a real HBAR tip settling on
   mainnet, signed from his wallet? What amount (tiny — e.g. 0.1–1 HBAR)?
6. **Peer:** Deadline Desk or Agent Atlas as the one live peer call (recommendation:
   Deadline Desk primary; decide after week-3 `check_partner.mjs`)?
7. **Mount page:** `/intros` (recommended), `/agents`, or landing?
8. **Builder in the network?** Claim-prep only (recommended) or fuller build specialist?
   Full Buddy build stays on `/forge` either way.
9. **Listings:** after the entry is live, list it on the spec repo's agentic-websites
   list (PR) and/or NANDA Index? Needs his explicit go.
10. **Payout readiness:** if we win, is there a bank account ready to receive $5,000 by
    check/transfer, and can he return the affidavit + W-9 within 10 business days?
11. **Peer `allowed_peers`:** if Deadline Desk / Agent Atlas refuse our origin under
    their closed peer policy, may Danny contact the peer publisher to ask for
    `https://voicescape.vercel.app` to be added? (Contact attempt — his call.)
