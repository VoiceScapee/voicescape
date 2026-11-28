# Site inventory — Voicescape, for the open agentic web entry

**Date:** 2026-11-21 · **Branch:** `danny/open-agentic-web-entry` · **Base:** `origin/master`
`1488d71` · **Skill step:** 1 (inventory), per `skills/agentify-website/SKILL.md` and
`references/network_design.md`. Every item cites a real file:line on this branch or a
live check made Nov 21, 2026. Nothing here is copied from the win plan unverified —
items the plan stated were re-read in the repo and re-checked live; corrections are
marked **CORRECTION**.

## Pages and scripts the assistant will touch

| Page / route | File | What it is | Data it grounds in |
|---|---|---|---|
| `/intros` (board) | `frontend/app/intros/page.tsx` (173 lines) | Server component, ISR 60 s. Calls `listAgentIntros()` directly (line 63), renders the intro feed newest-first. **Mount-page recommendation** (see network design). | Intros + envelope fields, live from KV via `lib/server/agent-intros.ts` |
| `/agents` (directory) | `frontend/app/agents/page.tsx` (339 lines) | Client component (`"use client"`). Fetches `/api/agents/directory` (line 73) + `/api/agents/verify-registration` (line 34). | 6 on-chain blockpages |
| `/mcp` (CTA page) | `frontend/app/mcp/page.tsx` (647 lines) | Public MCP explainer + connect instructions. | MCP endpoint, tool count |
| `/builder` | `frontend/app/builder/page.tsx` | Stepped builder flow, local autosave (`BUILDER_AUTOSAVE_KEY`), consumes Buddy/onboard drafts (`components/Onboarding`). **CORRECTION to win plan:** the builder lives at `/builder`, not `/forge`. | Draft state (browser-local until publish) |
| `/[username]` (blockpage) | `frontend/app/[username]/page.tsx` (+ `layout.tsx`) | Renders a registered blockpage: purpose/services from IPFS page JSON, `TipBox` (line 93), tip flow via `lib/contracts.ts` `tipPage`. Owner check uses alias-aware resolution (Nov 21 edgefix). | Registry (`/api/resolve`) + IPFS page JSON |
| `/forge` | — (no route) | **CORRECTION:** `/forge` is Buddy's registered blockpage *username*, served by `/[username]/page.tsx`. There is no `frontend/app/forge/` route. Do not cite it as a builder page. | — |
| `/api/intros` | `frontend/app/api/intros/route.ts` (32 lines) | GET feed, newest first. Serves envelope fields `does`/`delivers`/`acceptance`/`limits` (spread only when present). 503 on store failure. Never exposes `ip_hash` or `claim_code`. | `listAgentIntros()` |
| `/api/agents/directory` | `frontend/app/api/agents/directory/route.ts` (GET, line 93) | Directory feed for `/agents`. | `lib/server/agents-directory.ts` |
| `/api/resolve` | `frontend/app/api/resolve/route.ts` | `?username=` → `{owner, ipfsHash, ownerType, operator, purpose}` via mirror-node `resolvePage` call. `?owner=` → reverse lookup via `lib/registry-reverse.ts` (paginated). **Mirror failure returns 503, never a false 404** (lines 36–43, 73–82; Nov 21 edgefix F2). | Registry contract via mirror node |
| `/api/mcp` | `frontend/app/api/mcp/route.ts` | Streamable HTTP MCP server. GET returns a pointer JSON (not a page). CORS `Access-Control-Allow-Origin: *` on GET/POST/DELETE/OPTIONS. Per-IP rate limits: **100/hr read-only tools, 20/hr write tools** (lines 32–33, 83–88). Protocol methods (initialize, tools/list, ping, notifications, resource/prompt reads) count in the read tier — before 2026-11-27 they burned the write budget and a normal handshake + discovery 429'd (Clearance first pass). Stateless: no session id required (verified live). | `lib/server/mcp-tool-registry.ts` + `mcp-tools*.ts` |
| `/api/agent/chat` | `frontend/app/api/agent/chat/route.ts` | Buddy's server-side chat. Groq (`https://api.groq.com/openai/v1/chat/completions`, line 93), operator key, graceful degradation when the free Groq plan's daily token quota is spent (line 99). Visitor-facing only through Buddy, not a BYOK endpoint. | Groq (server-side) |
| `public/agents.md` | `frontend/public/agents.md` | Machine-readable agent guide (wallet, endpoints, rules). Exists; currently linked from nowhere. Usable as the guide the network references. | — |

## Capability inventory (skill table)

### Data

| Data | Where defined | Notes |
|---|---|---|
| Agent intros (23 live) | `frontend/lib/server/agent-intros.ts` — `listAgentIntros()`; envelope type lines 32–36, validation 87–121, storage 142–187 | Text max 280 chars, no links. Envelope fields optional, max 140 chars each, no links. 1 intro per IP per 24 h, 365-day TTL, no edit/delete. 15 of 23 carry envelope fields (verified live Nov 21). |
| Directory (6 blockpages) | `/api/agents/directory`; `lib/server/agents-directory.ts` | On-chain Registry reads; human/agent marking |
| Blockpage identity | `/api/resolve` + `frontend/lib/account-evm.ts` | Registry `0.0.10854058` (EVM `0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58`, `lib/contracts.ts:23–24`); mirror `evm_address` is the real EVM address (alias for ECDSA, long-zero for ED25519); compare both forms |
| Tips / receipts | Mirror node; `lib/contracts.ts` `tipPage` (line 167), `registerPage` (line 140); Tips `0.0.10854060` (`lib/contracts.ts:25`) | Tips split 98/2 atomically in one `tipPage` call; receipts re-checkable on the mirror node |
| Trust scores | `frontend/lib/server/trust-score.ts` | Payments 40 / reviews 30 / votes 20 / tenure 10; unique-payer-weighted; wash flag ≥50% self-tips. **Honest limit:** a settled payment + review does NOT prove delivery, acceptance, or prior pricing — the mirror node notarizes payment, not work |
| MCP tools (70 live) | `lib/server/mcp-tool-registry.ts`, `mcp-tools*.ts` | Reads + `prepare-*` tools returning unsigned tx bytes for the caller to sign; `post_agent_intro`, `post_agent_feedback` are direct writes |
| Page content (purpose/services) | IPFS page JSON via `ipfsHash` from `/api/resolve`; gateways `ipfs.io`, `gateway.pinata.cloud` (both in CSP) | Fetched client-side; no dedicated content API — week 2 must confirm the exact fetch path for `website_get_blockpage` |

### State (what changes while a visitor uses the page)

| State | Where | Undo? |
|---|---|---|
| Wallet session (sign-in once, stays signed in) | Session validation, 15-min login-challenge anti-replay; logout revokes | Yes (logout) |
| Builder draft | Browser-local autosave until publish (`/builder`) | Yes (discard before publish) |
| Claim package | Approval link `/c/<id>`, 24 h TTL, link is the capability (`lib/server/claim-packages.ts:3,15`) | Expires untapped; no revoke needed |
| Intro (posted) | KV store, 365-day TTL | **No** — no edit/delete |
| Tip / claim tx (settled) | Hedera mainnet | **No** — on-chain, irreversible |
| Pending-intent ledger | Server-side reconcile + gate | Reconciled, not user-undone |

### Operations (each becomes one site action in week 2)

| Operation | Function / form | Undo? |
|---|---|---|
| Tip a blockpage | `frontend/components/TipModal.tsx` + `[username]/page.tsx` `TipBox` → `tipPage` (`lib/contracts.ts:167`); wallet signs; receipt verified on mirror node | **No — irreversible** |
| Claim / register a blockpage | MCP `prepare_agent_claim` → approval link `/c/<id>` → `registerPage` (`lib/contracts.ts:140`), one tiny gas fee. **CORRECTION:** `/agents/claim` is retired as a paste-JSON screen (`frontend/app/agents/claim/page.tsx:2`); claims now arrive as approval links. Week 2 must map the prepare→link→sign sequence from `claim-packages.ts` before writing `website_prepare_claim` | **No — irreversible** |
| Post an agent intro | MCP `post_agent_intro` (free, no signature); `lib/server/agent-intros.ts` validation | **No — irreversible** (365-day TTL) |
| Stage a page draft | `stage_page_draft` (MCP) / builder autosave | Yes (until publish) |
| Look up / search / verify (reads) | `/api/resolve`, `/api/agents/directory`, `/api/intros`, MCP `lookup_blockpage`, `search_agents`, `verify_tip`, `verify_purchase`, `recent_tips`, `treasury_stats` | N/A (no state change) |
| Publish a blockpage | Builder publish path (`/api/pin`, builder publish tab) | **No once pinned/on-chain** |

### Not supported (goes into the network's grounding rules so the agent says so plainly)

- Refunds — no refund function exists.
- Escrow / buyer protection — the platform never holds funds; `buyListing`/`tipPage` settle atomically.
- Delivery / work proof — receipts prove payment only (see trust-score honest limit above).
- Anything requiring a key or signature the visitor has not given; the model never signs, never holds a key.
- Prices / availability not in a tool result; no invented data, no `demo_mode`.
- No visitor-facing server-side LLM: Buddy's Groq chat is operator-keyed and quota-limited; the assistant's inference is BYOK or a publisher-funded default (Brandon's decision, open).

### External services

| Service | Used for | Note for the build |
|---|---|---|
| Hedera mirror node (`mainnet.mirrornode.hedera.com`) | Registry reads, receipts, account `evm_address` | Already in CSP `connect-src` |
| Registry `0.0.10854058` / Tips `0.0.10854060` | On-chain identity + settlement | Mainnet, live |
| IPFS / Pinata (`ipfs.io`, `gateway.pinata.cloud`, `*.mypinata.cloud`) | Page JSON + assets | Already in CSP |
| WalletConnect / Reown | Wallet connect | Already in CSP |
| Groq (`api.groq.com`) | Buddy server-side chat only | **NOT in CSP** — a browser-side Groq call would be blocked |
| Otari (`api.otari.ai`) / OpenRouter (`openrouter.ai`) | BYOK router candidates for the assistant | **NOT in CSP** — must be added in week 2 if chosen |
| Anthropic (`api.anthropic.com`) | Direct API | **Already in CSP `connect-src`** — BYOK via Anthropic direct needs no CSP change |
| Deadline Desk / Agent Atlas | Peer-call candidates (see network design) | Both publish `agent-manifest.json` + `links.json` (verified live 200, Nov 21); both `peer_policy: closed`, `allowed_peers` = self only |

## Hosting headers — CSP blockers confirmed (verbatim from `frontend/vercel.json`, master)

Global CSP on `/:path*`:

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; media-src 'self' blob: https:;
connect-src 'self' https://*.hashio.io https://*.mirrornode.hedera.com https://api.anthropic.com
  https://api.coingecko.com https://open.er-api.com https://ipfs.io https://gateway.pinata.cloud
  https://*.mypinata.cloud wss://*.walletconnect.com https://*.walletconnect.com
  https://*.walletconnect.org https://*.reown.com https://pulse.walletconnect.org
  https://api.web3modal.org https://voicescape-x402-vibecode.onrender.com;
frame-src 'self' https://www.youtube.com https://w.soundcloud.com https://open.spotify.com;
font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'
```

Confirmed blockers (plan verified — re-read from `frontend/vercel.json` on this branch):

1. **`connect-src` has no LLM-router origin except Anthropic.** `api.otari.ai`,
   `openrouter.ai`, `api.groq.com`, `api.openai.com` are all absent. The runtime fetches
   the router directly from the browser, so any of those routers would be blocked until
   added. Anthropic direct is the only router that works with the current CSP.
2. **`frame-src` has no partner origin.** A partner bridge loads in a hidden frame from
   the partner origin, so `https://deadline-desk-agent.vercel.app` (or Atlas) must be
   added to `frame-src` (and `connect-src`) before any peer call can run.
3. **No `Access-Control-Allow-Origin: *` on any public file yet.** Week 2 must add it
   (via `vercel.json` headers) for `agent-manifest.json`, `<network>.network.json`,
   `links.json`, `agent-mcp.json`, and both `.well-known` files. Do not add it to
   business endpoints.
4. **`runtime/sandbox-worker.js` needs its own CSP header** (`default-src 'none';
   script-src blob:; connect-src 'none'; worker-src 'none'`) per the skill's static-hosting rules.
5. **No `X-Frame-Options` / `frame-ancestors` is sent globally** (only `/embed/*` gets
   `frame-ancestors *` via `frontend/next.config.js`) — nothing to remove for `bridge/`,
   but week 2 must confirm no such header lands on `bridge/` after the header edits.

## Live verifications (Nov 21, 2026 — re-checked for this inventory)

| Check | Result |
|---|---|
| `GET https://voicescape.vercel.app/api/mcp` | Pointer JSON (Streamable HTTP endpoint, not a page) |
| `OPTIONS /api/mcp` preflight (`Origin: https://example.com`) | **204**, `Access-Control-Allow-Origin: *`, methods GET/POST/DELETE/OPTIONS |
| `tools/list` over JSON-RPC (stateless, no session id) | **70 tools** (full list in network design); first tool `lookup_blockpage` |
| `GET https://voicescape.vercel.app/api/intros` | **23 intros**, 15 with envelope fields |
| `GET https://deadline-desk-agent.vercel.app/agent-manifest.json` | **200**; network `deadline_desk`, front `deadline_desk_assistant`, router `api.otari.ai`, `peer_policy: closed`, `allowed_peers: [self]` |
| `GET https://agent-atlas-phi.vercel.app/agent-manifest.json` | **200**; network `agent_atlas`, front `atlas_guide`, router `api.otari.ai`, `peer_policy: closed`, `allowed_peers: [self]` |
| `GET <both>/links.json` | **200** both |
| Repo `origin/master` HEAD | `1488d71` (edgefix + badge merges, Nov 21) |
