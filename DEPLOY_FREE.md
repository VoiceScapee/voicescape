# Voicescape Go-Live Deployment Plan — Free Hosting, Cheap Launch

**The deal, stated plainly:** hosting itself is **$0/month** (Vercel free tier for
the frontend, Render free tier for the x402 API). The chain costs are **not free
and never were**: budget **~$15–20 of HBAR one time** to deploy the 2 contracts +
create the HCS topics on mainnet, and **$0 ongoing** after that. Nothing on this
page deploys anything — this is plan + configs only. Every mainnet action below
still needs Brandon's explicit "go".

**Why this split:** the frontend is a standard Next.js app — a perfect fit for
Vercel's free tier. The x402 service is a long-running Express server that
**cannot** run on serverless (it holds the x402 payment handshake state in a
persistent process), so it gets its own always-on box — the cheapest one that
exists, which is Render's free tier.

---

## 0. Fit check — will Vercel Hobby actually run this frontend?

Checked against the code (read-only audit, `frontend/app/api/` + `lib/server/`).
Current public limits for the **Vercel Hobby (free) plan**, verified 2026-09-10:

| Limit (Hobby) | Value | Verdict for Voicescape |
|---|---|---|
| Bandwidth | 100 GB / month | ✅ Plenty for launch traffic |
| Build minutes | 6,000 / month | ✅ One Next.js build ≈ 1–3 min |
| Function invocations | 1,000,000 / month (4 CPU-hours, 360 GB-hours) | ✅ Town-hall reads are light |
| Function max duration | 60s legacy; up to 300s with Fluid Compute (now default) | ✅ Covered — see SSE note below |
| Node.js version | 20.x / 22.x | ✅ Repo targets Node ≥20 (`@types/node ^20`; x402 declares `engines: node >= 20`) |
| Cron jobs | Not needed | ✅ No cron used |
| Websockets | Not supported | ✅ Not used — chat is SSE **with a polling fallback** (see below) |
| Persistent filesystem | Not available | ✅ Not used — state lives on-chain (HCS topics, contracts) + IPFS (Pinata) |
| Commercial use | Hobby = personal/non-commercial only | ⚠️ See "The Hobby catch" below |

**SSE streaming on serverless — the one thing that looks scary and is fine:**
`GET /api/townhall/chat/[room]/stream` holds an SSE connection open and polls
the HCS mirror node every 5s. On Vercel serverless, streaming responses work,
but the function is killed at `maxDuration`. That is why `frontend/vercel.json`
(new file, created with this plan) sets `maxDuration: 60` for three routes:

- `app/api/townhall/chat/[room]/stream/route.ts` — 60s per SSE connection, then
  the connection closes and the client reconnects (the polling fallback in the
  chat UI already handles reconnects, so users see at most a sub-second blip).
- `app/api/vibecode/route.ts` — Anthropic calls can take 10–40s; 60s keeps them
  from hitting the 10s legacy default.
- `app/api/pin/route.ts` — Pinata audio uploads up to 25 MB need more than the
  10s default to finish.

Everything else (auth verify, forum/vote/marketplace/event routes, agent
directory, mirror-node GETs) completes in milliseconds-to-a-couple-seconds —
well inside limits.

### The Hobby catch (read this once)

Vercel's Hobby terms are **personal, non-commercial use**. Voicescape at launch
(a personal project page for Brandon + a town hall for early users) fits. The
moment it starts earning real money, move it to **Pro ($20/month)**. This is the
only hosting cost on the horizon, and it's $0 until monetization is real.

### Open items / caveats (not blockers, no code changes needed)

1. **25 MB audio uploads vs. request-body limits.** `/api/pin` accepts audio
   files up to 25 MB (`MAX_AUDIO_BYTES` in `lib/server/publish.js`). Vercel's
   Fluid Compute (default on new projects) allows request bodies up to 100 MB —
   fine. If Vercel ever served the route under the legacy 4.5 MB body limit,
   large uploads would fail; the mitigation (client-side direct-to-Pinata
   upload) would need a code change, which is out of scope for this plan.
2. **SSE reconnect cadence.** Every SSE connection lives at most 60s on Hobby,
   then reconnects. Harmless, but don't be alarmed by short connections in logs.
3. **Render free cold starts** (~30–60s after 15 min idle) — handled by the free
   keepalive in Part B. First-time agent buyers may otherwise see a slow first
   call; the x402 handshake itself retries cleanly.

---

## Part A — Frontend → Vercel (free tier), click by click

**Prereq:** the repo (or at least `frontend/`) is pushed to GitHub. Brandon's
only phone-side step here is confirming the GitHub repo URL.

1. Go to **vercel.com** → sign up / log in (GitHub account is fastest).
2. Dashboard → **Add New… → Project** → **Import** the Voicescape repo.
3. On the "Configure Project" screen, set:
   - **Framework Preset:** Next.js (auto-detected)
   - **Root Directory:** `frontend` ← click "Edit" and type `frontend`. This is
     the important one: the Next.js app lives in `frontend/`, and Vercel reads
     `frontend/vercel.json` (created with this plan) from there.
   - **Build Command:** leave default (`next build` — Vercel runs it inside
     `frontend/` automatically; `package.json` script is `next build`).
   - **Output Directory:** leave default (`.next`).
   - **Node.js Version:** 20.x or newer (repo requires Node ≥ 20).
4. **Environment Variables — add these BEFORE the first deploy**
   (`NEXT_PUBLIC_*` values are baked into the build; adding them later requires
   a redeploy). Values marked 🔑 come from Brandon (see §Brandon's phone-side
   todo); contract addresses get filled after the mainnet deploy.

   **Server-only (never sent to the browser):**
   | Variable | Value / source |
   |---|---|
   | `APP_ORIGIN` | 🔑 **REQUIRED** — your public URL, e.g. `https://voicescape.app`. Wallet sign-in messages are bound to it (phishing protection). Without it, production refuses to verify sign-ins. Fill this in AFTER step 6/7 when you know the final URL, then redeploy. |
   | `SESSION_SECRET` | 🔑 **REQUIRED** — `openssl rand -hex 32` (any phone terminal app can run this, or ask me and I'll generate the command). Signs the 7-day session tokens. Without it, production refuses to issue/verify tokens. |
   | `UPSTASH_REDIS_REST_URL` | 🔑 **REQUIRED for production** — free Upstash Redis REST URL (upstash.com → free database). Without it quotas, replay protection and sign-in nonces are per-instance memory: they reset on restart and don't apply across Vercel's instances. Free tier: 500k commands/month, 256 MB, no credit card. |
   | `UPSTASH_REDIS_REST_TOKEN` | 🔑 **REQUIRED for production** — the matching Upstash REST token. |
   | `TOWNHALL_HCS_NETWORK` | `mainnet` |
   | `TOWNHALL_OPERATOR_ID` | 🔑 server operator account, e.g. `0.0.x` |
   | `TOWNHALL_OPERATOR_KEY` | 🔑 its private key (paste via Vercel's secret field) |
   | `TOWNHALL_TOPIC_CHAT` | `0.0.x` — from `townhall:init` output |
   | `TOWNHALL_TOPIC_FORUM` | `0.0.x` — from `townhall:init` output |
   | `TOWNHALL_TOPIC_GOV` | `0.0.x` — from `townhall:init` output |
   | `TOWNHALL_TOPIC_MARKET` | `0.0.x` — from `townhall:init` output |
   | `TOWNHALL_TOPIC_VOTES` | `0.0.x` — from `townhall:init` output |
   | `TOWNHALL_MODS` | (optional) comma-separated mod account ids |
   | `PINATA_JWT` | 🔑 Pinata JWT |
   | *(AI builder is BYOK)* | No server key needed — users bring their own Anthropic key, stored only in their browser, billed by Anthropic to them |
   | `DUST_FEE_TINYBARS` | (optional, has a default) |
   | `HCS_SUBMIT_FEE_TINYBARS` | (optional, default 100000) — operator's assumed HCS submit cost; the server refuses town-hall writes if the dust fee is 0 or below this |
   | `PIN_MAX_PAGE_JSON_BYTES` | (optional, default 1048576) — max page-JSON bytes pinned per request |
   | `PIN_DAILY_QUOTA` / `AUDIO_DAILY_QUOTA` | (optional, defaults 20 / 3) — per-wallet daily pin quotas protecting the Pinata free tier |
   | `TOWNHALL_WRITE_DAILY_QUOTA` | (optional, default 50) — per-wallet daily cap on free town-hall writes (each costs the operator an HCS submit); 429 past this |
   | `IP_RATE_LIMIT_WINDOW_MS` | (optional, default 3600000 = 1h) — per-IP rate-limit window |
   | `IP_RATE_LIMIT_VIBECODE` / `IP_RATE_LIMIT_PIN` / `IP_RATE_LIMIT_TOWNHALL` | (optional, defaults 60 / 120 / 300) — per-IP request caps per window, stopping one IP from multiplying per-wallet quotas across many wallets |

   **Public (`NEXT_PUBLIC_*`, baked at build time):**
   | Variable | Value / source |
   |---|---|
   | `NEXT_PUBLIC_CHAIN` | `mainnet` |
   | `NEXT_PUBLIC_REGISTRY_ADDRESS` | `0x…` — contract deploy output |
   | `NEXT_PUBLIC_TIPS_ADDRESS` | `0x…` — contract deploy output |

   | `NEXT_PUBLIC_TREASURY_ADDRESS` | 🔑 Brandon's treasury decision |
   | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | 🔑 from walletconnect.com |
   | `NEXT_PUBLIC_X402_VIBECODE_URL` | `https://voicescape-x402-vibecode.onrender.com` (Part B; can be added later + redeploy, the builder works without it) |
   | `NEXT_PUBLIC_IPFS_GATEWAY` | (optional, has a default) |
   | `NEXT_PUBLIC_HEDERA_MAINNET_RPC` | (optional, has a default) |
   | `NEXT_PUBLIC_HBAR_USD_PRICE` | (optional, has a default) |

5. Click **Deploy**. First build takes ~2–5 minutes.
6. You get `https://<project>.vercel.app`. Share it.
7. Optional later: **Settings → Domains** to attach a custom domain (free on Hobby).

**Deploy order note:** the frontend can go live *before* the mainnet contracts
exist — pages render, wallet connect works, town hall reads from whatever topics
are configured. Fill in contract addresses → redeploy when the chain deploy is
done.

---
## Part B — x402 service → Render free tier, click by click

**Why Render (one line):** Render's free tier is the only host that is $0/month,
runs a persistent Node process with blueprint deploys (`render.yaml`, already
created with this plan) and a dashboard secrets UI — Fly.io killed its free tier
for new accounts in Oct 2024 (Hobby now $5/mo minimum + credit card required),
and a cheap VPS needs SSH/ops work Brandon can't do from his phone.

What Render free gives you: **750 hours/month** (enough for one 24/7 service),
auto-HTTPS, secret env vars, auto-deploy on git push. The catch: the service
**sleeps after ~15 minutes of inactivity** and takes **~30–60s to wake** on the
next request. For a "later mainnet rail" that agents will hit occasionally,
that's acceptable — and the free keepalive below removes the wake-up delay.

**Is the x402 service required at launch?** No. Per the project plan it's a
*later* mainnet rail — the frontend launches fine without it
(`NEXT_PUBLIC_X402_VIBECODE_URL` is optional). Deploy it now anyway if you want:
it's free, and agents get a paying API on day one.

1. Push `~/workspace/x402-vibecode/` to GitHub (its own repo, e.g.
   `voicescape-x402-vibecode`). **Do not commit any `.env` file** — the
   blueprint only contains placeholders.
2. Go to **render.com** → sign up / log in (GitHub account is fastest).
3. Dashboard → **New + → Blueprint** → connect the `voicescape-x402-vibecode`
   repo. Render auto-detects `render.yaml` at the repo root → click **Apply**.
4. Render creates the web service **`voicescape-x402-vibecode`** (plan: Free)
   with:
   - Build command: `npm ci && npm run build` (TypeScript → `dist/server.js`)
   - Start command: `npm start` (`node dist/server.js`, `main` entry; Node ≥ 20
     per `engines`)
   - Health check: `GET /health`
   - Port: Render injects `$PORT`; the server reads `process.env.PORT`
     (`src/server.ts:52`) and binds all interfaces — no config needed.
5. After the blueprint applies, open the service → **Environment** tab and fill
   in the secrets (left as `sync: false` placeholders in `render.yaml` — paste
   the values in the dashboard, never into the repo):

   | Variable | Required? | Source / notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Recommended | 🔑 Anthropic console. Without it the service boots but `/vibecode` returns mock responses |
   | `SELLER_ACCOUNT_ID` | ✅ Yes (for real payments) | e.g. `0.0.x` — receives settled x402 payments |
   | `SELLER_PRIVATE_KEY` | ✅ Yes (for real payments) | operator key — signs the 2% treasury forward on-chain (`src/treasury.ts:72`) |
   | `TREASURY_ACCOUNT_ID` | Optional | 🔑 Brandon's treasury decision; empty = 2% forward skipped (`src/payment.ts:195`) |
   | `FACILITATOR_URL` | ✅ Yes on mainnet | **Your self-hosted facilitator's Vercel URL** (Part C below), e.g. `https://voicescape-facilitator.vercel.app` — the contract paths `/verify`, `/settle`, `/supported` live at its root |
   | `FEE_PAYER_ACCOUNT` | ✅ Yes on mainnet | **Must equal the facilitator's `HEDERA_FACILITATOR_ID`** — the same account the facilitator co-signs with |
   | `FACILITATOR_API_KEY` | **Leave empty** | Self-hosted facilitator needs no key. Only set for the Blocky402 fallback |
   | `HEDERA_NETWORK` | Set in blueprint | `mainnet` (code validates it loudly at startup, `src/network.ts:43`) |
   | `HCS_TOPIC_ID` | Optional | audit-feed topic id; empty = audit logging skipped with a warning (`src/audit.ts:106`) |
   | `AUDIT_OPERATOR_ID` / `AUDIT_OPERATOR_KEY` | Optional | account that submits audit messages (`src/audit.ts:63-64`) |
   | `PUBLIC_URL` | Set in blueprint | `https://voicescape-x402-vibecode.onrender.com` — advertised in the 402 and re-checked against buyer payloads (`src/server.ts:56`); update if the service is renamed |
   | `PRICE_USD_CENTS` / `HBAR_USD_PRICE` | Set in blueprint | defaults `25` / `0.20`. The server **refuses to boot** below the computed price floor (~20¢ at sonnet defaults: worst-case AI cost × 1.5 margin + operator overhead) — the legacy `1` default can never go live (`src/economics.ts`) |
   | `MAX_INPUT_TOKENS` / `MAX_OUTPUT_TOKENS` | Set in blueprint | defaults `20000` / `4096` — worst-case token budgets feeding the price-floor math |
   | `OPERATOR_OVERHEAD_TINYBARS` | Set in blueprint | default `1000000` (0.01 HBAR) — settle + treasury-forward + HCS-audit fees per request, added to the price floor |
   | `FORWARD_FEE_TINYBARS` | Set in blueprint | default `500000` — a 2% share worth less than 2× this is never forwarded (fee would exceed the share) |
   | `ANTHROPIC_MODEL` | Set in blueprint | default `claude-sonnet-4-5-20250929` (`src/anthropic.ts:48`) |

   Changing any env var triggers a redeploy automatically. The full server env
   list was enumerated from `src/*.ts` (`server.ts`, `payment.ts`, `treasury.ts`,
   `audit.ts`, `anthropic.ts`, `network.ts`); demo-only vars (`VIBECODE_URL`,
   `BUYER_ACCOUNT_ID`, `BUYER_PRIVATE_KEY`) are not needed on the server.
6. Wait for the first deploy (~3–5 min), then open
   `https://voicescape-x402-vibecode.onrender.com/health` — expect a JSON status
   payload with network, treasury, and audit-topic fields (`src/server.ts:142+`).

**Free keepalive (kills the cold start):** create a free account at
**uptimerobot.com** → Add Monitor → HTTP(s) → URL
`https://voicescape-x402-vibecode.onrender.com/health`, interval **5 minutes**.
The ping keeps the service awake; 50 monitors / 5-min interval is free. (This is
the standard, Render-tolerated trick for the free tier — it does not violate
their terms.)

**Upgrade path if it ever earns:** Render Starter ($7/mo) removes sleep. Only
do this when the x402 rail has real paying traffic.

---

## Part C — x402 facilitator → Vercel Hobby (free), click by click

**Why Vercel, not Render (one line):** Render's free tier gives 750
instance-hours/month *per account* — the x402 service with its keepalive
already uses ~730. A second always-on Render service would blow the cap and
get suspended. The facilitator is stateless (verify/settle are pure HTTP →
sign → submit), the repo ships a working Vercel serverless entrypoint
(`api/index.ts`), and its own live demo runs on Vercel — so it goes on
Vercel Hobby ($0, no sleep, no keepalive, 1M function invocations/month is
plenty for verify/settle traffic).

1. **Fork** https://github.com/belgacemelbar/hedera-x402-facilitator (MIT) to
   Brandon's GitHub. In the fork, bump the four `@x402/*` deps from `2.19.0`
   to **`2.25.0`** (same pin as our x402 service — 2.19.0 had a signature-set
   regression that broke verify/settle; see `FACILITATOR_SHORTLIST.md`).
2. Vercel → **Add New… → Project** → import the fork. Root Directory = repo
   root. Framework preset: leave default (the repo's notes warn about Hono
   auto-detection — if the first deploy fails oddly, set `"framework": null`
   in a `vercel.json`; the repo already documents this).
3. **Environment variables** (only three needed — demo vars are not used):
   | Variable | Value |
   |---|---|
   | `HEDERA_FACILITATOR_ID` | 🔑 e.g. `0.0.x` — the facilitator's own mainnet account; pays ~$0.0001–0.0005 network fee per settlement |
   | `HEDERA_FACILITATOR_KEY` | 🔑 its private key (Vercel secret field). Hot key — keep the account lean (a few HBAR ≈ 10,000 settlements) |
   | `HEDERA_FACILITATOR_NETWORK` | `hedera:mainnet` |
4. **Test BEFORE mainnet:** set `HEDERA_FACILITATOR_NETWORK=hedera:testnet`
   with a testnet account first and run the repo's `npm run test:payment`
   against the Vercel URL — it must verify + settle for real on testnet.
   Then flip to mainnet. (Do not spend real HBAR on an untested facilitator.)
5. Deploy. You get `https://<project>.vercel.app`. Sanity check:
   `GET https://<project>.vercel.app/supported` must advertise
   `hedera:mainnet`. Copy this URL into the x402 service's `FACILITATOR_URL`
   (Part B) and the facilitator account id into `FEE_PAYER_ACCOUNT`.
6. **Fallback (documented, not deployed):** Blocky402 hosted mainnet
   (`https://api.blocky402.com`) — only if self-hosting ever breaks AND its
   currently-unpublished API-key pricing proves free. Switching the x402
   service is env-vars-only (`FACILITATOR_URL`, `FEE_PAYER_ACCOUNT`,
   `FACILITATOR_API_KEY`).

---

## Cost table — the whole launch

| Item | Cost |
|---|---|
| Frontend hosting (Vercel Hobby) | **$0 / month** |
| x402 API hosting (Render free) | **$0 / month** |
| x402 facilitator (Vercel Hobby, second project) | **$0 / month** |
| Keepalive (UptimeRobot free) | **$0 / month** |
| IPFS pinning (Pinata — free tier) | **$0 / month** (within Pinata's free allowance) |
| Mirror-node reads (Hedera public mirror) | **$0** |
| AI price lookups (CoinGecko, no key) | **$0** |
| WalletConnect project ID | **$0** (free tier) |
| Chain deploy, one time: 2 contracts + 5 town-hall HCS topics + 1 audit topic on **mainnet** | **~$15–20 of HBAR, one time** (~$0.20 cheaper than the old 3-contract plan — the escrow contract is gone) |
| Facilitator fee-payer float (one time, from the same HBAR) | **a few HBAR** — pays ~$0.0001–0.0005 network fee per x402 settlement; 5 HBAR ≈ 10,000 settlements |
| Operator account floats (one time, from the same HBAR) | **small HBAR buffer** — the town-hall operator submits HCS messages (~$0.0001 each); the x402 operator pays the 2%-forward tx fee (~$0.0001–0.0005 per settled request) |
| Ongoing chain costs | **$0** beyond the floats above (reads are free; user writes are paid by users' own wallets) |
| **Total** | **$0/mo hosting + ~$15–20 HBAR once** |

**The Anthropic rule (read this once):** AI calls cost real money per request
and have NO free tier — Anthropic bills prepaid credits, roughly **$0.02–$0.06
per vibecode request** on the default Sonnet model (input ~2–5k tokens +
output up to 4096 tokens at $3/$15 per million tokens, Sept 2026 rates).
Three guardrails are now in place (the last one structural, added 2026-09-10):
1. The frontend `/api/vibecode` route requires a signed-in wallet session —
   anonymous callers **cannot** burn Brandon's credits (this was an open hole;
   fixed 2026-09-10).
2. Per-wallet daily quota (`VIBECODE_DAILY_QUOTA`, default 5): even signed-in
   users get 429 past the limit — no one can burn meaningful credit.
3. The x402 service only runs the paid AI call **after** the buyer settles
   on-chain (`paymentFlow: "upfront"`) — and the 402 price must cover the AI
   cost **structurally**: the server **refuses to boot** if `PRICE_USD_CENTS`
   is below the computed floor (worst-case AI cost × 1.5 + operator overhead,
   ~20¢ at sonnet defaults). The blueprint default is now **25¢** — the old
   1¢ default can never go live. With no `ANTHROPIC_API_KEY` set, the service
   runs in labeled mock mode: $0 in, $0 out.

Fine print: Vercel Hobby is personal/non-commercial — moving to Pro ($20/mo)
happens only when Voicescape is actually earning. Render Starter ($7/mo) is
likewise only if the x402 rail gets real traffic. Nothing here is a surprise
bill: both free tiers simply stop/limit rather than charge.

---

## Brandon's phone-side todo (minimal — everything else is on me)

1. **Buy HBAR** (~$15–20 worth plus a small buffer). Start any exchange KYC
   **now** — it takes days and it's the longest pole in the tent.
2. **Create a separate HashPack account** for the deployer (never the main
   wallet). Fund it with the HBAR from step 1.
3. **Treasury address decision:** which account receives the 2% (tips +
   marketplace + x402)? Can be the deployer account or a separate wallet —
   just name it.
4. **GitHub repo URL:** confirm where the code should live (I can push; I just
   need the repo).
5. **Pinata JWT** + **WalletConnect project ID** — two copy-pastes from their
   sites.
6. **Deployer key via Secure Vault** — paste it on the Secure Vault capture
   page when I ask, never in chat.
7. **Explicit "go"** — nothing touches mainnet or moves value until you say go.

---
## Post-deploy smoke test checklist

Run these in order after both parts are live. Each is a real user action.

**Frontend (Vercel URL):**
- [ ] Page loads: landing + splash screen, no console errors
- [ ] **Wallet login:** connect HashPack/MetaMask → sign the login message → builder unlocks (7-day session)
- [ ] **Page publish:** build a test page → publish → JSON pins via `/api/pin` (returns a CID) → public page renders it
- [ ] **Tip:** send a tiny HBAR tip to the test page → 98/2 split visible (2% to treasury)
- [ ] **Forum post:** post in Town Hall → appears after HCS confirm (~seconds)
- [ ] **Chat:** send a message in a room → received live over SSE; then test the
      polling fallback (it kicks in automatically if the stream drops — verify
      messages still arrive)
- [ ] **Marketplace:** create a listing → buy it → atomic 98/2 settles in one tx
- [ ] **Reputation vote + proposal vote:** vote on something → vote counts on-chain topic
- [ ] **Agent directory:** `GET /api/agents` returns JSON (`{ v, network, count, agents[] }`)

**Facilitator (Vercel URL):**
- [ ] `GET /supported` → 200 advertising `hedera:mainnet` with your fee-payer account
- [ ] `POST /vibecode` **without** payment → HTTP **402** (handshake live)

**x402 service (Render URL):**
- [ ] `GET /health` → 200 with `network: "mainnet"` and configured treasury/audit fields
- [ ] `POST /vibecode` **without** payment → HTTP **402** with a valid payment
      challenge (this proves the x402 handshake is live)
- [ ] **Small real payment:** run the buyer demo against the Render URL
      (`VIBECODE_URL=https://voicescape-x402-vibecode.onrender.com npx tsx
      src/buyer-demo.ts` from a machine with `BUYER_ACCOUNT_ID`/`BUYER_PRIVATE_KEY`
      set) with real test funds → expect a 200, a valid page JSON, and the 2%
      treasury forward tx id in the response + HCS audit entry
- [ ] Cold-start check: wait 20 min idle → hit `/health` → first request may take
      ~30–60s (expected on free tier); with the UptimeRobot keepalive it should
      stay warm

**If anything fails:** Vercel → project → Deployments → failing deploy → build
logs. Render → service → Logs. Most failures at this stage are a missing env
var (see the tables in Parts A/B) — the code paths log which one.

---

## Files created by this plan (new files only — no existing code touched)

- `~/workspace/voicescape/DEPLOY_FREE.md` — this runbook
- `~/workspace/voicescape/frontend/vercel.json` — `maxDuration: 60` for the SSE
  stream, vibecode, and pin routes (placed in `frontend/` because that is the
  Vercel project's Root Directory — Vercel reads `vercel.json` from the root
  directory, not the repo root)
- `~/workspace/x402-vibecode/render.yaml` — Render Blueprint: free Node web
  service, exact build/start commands, `/health` check, env placeholders with
  secrets left empty for the dashboard

**Suggested GitHub layout:** one repo per deployable —
`voicescape` (root → Vercel imports with Root Directory `frontend/`) and
`voicescape-x402-vibecode` (root → Render Blueprint). A monorepo with both also
works: Vercel takes Root Directory `frontend/`, Render takes the x402 folder
as its own blueprint-connected repo — but two repos is simpler to reason about
from a phone.
