# Voicescape dapp — full-site production-grade sweep report

**Date:** 2026-09-14 · **Branch:** `danny/site-sweep` (from origin/master @ 6d10220)
**Scope:** every route in `frontend/app`, every navbar link/dropdown, money flows
(tipping, marketplace buy/sell, fundraiser goals, publishing), i18n (14 locales),
wallet session persistence, Hedera library conformance.
**Method:** three parallel read-only audits (money flows / routes-links-copy-layout /
i18n-session-conformance) + parent verification of each critical/high finding against
source. Brandon's rules applied throughout: production-grade only, Hedera-native libs
only, no present-tense claims about non-live things, "blockpage" terminology, fee
framing = "fees make spam uneconomical" (never "keeps bots out").

Real mainnet addresses (verified in `frontend/lib/contracts.ts:23-29`):
Registry `0.0.10854058` · Tips `0.0.10854060` · Treasury `0.0.10424063`.

---

## CRITICAL

None found.

## HIGH

### 1. ✅ FIXED — Earnings / GoalBar / fundraiser "raised" totals showed GROSS tips as the creator's 98% share
- `frontend/lib/leaderboard.ts:46` (`decodeTipSentLog`) read only the first data word of
  the `TipSent` event (gross `msg.value`) as `amountHbar` and ignored the fee word, while
  UI copy (`goal.rule`, `dictionaries.ts:223`) claims the total is "the creator's 98%
  share recorded by the Tips contract." Every downstream surface overstated creator
  earnings by 2%: `GoalBar.tsx` progress, `EarningsPanel.tsx` stat cards,
  `lib/server/fundraisers.ts` (`raisedHbar`), `FundraiserClient.tsx` board progress, and
  the weekly leaderboard. Goals paused tips ~2% early; fundraisers left the board ~2% early.
- The contract is correct (`TipSent(username, from, toOwner, amount, fee)` —
  `contracts/contracts/VoicescapeTips.sol:45-51,108`); only the frontend aggregation was wrong.
- **Fix (this branch):** decoder now parses the fee word (word1) and reports
  `amountHbar = (gross − fee) / 1e8`, rejecting logs with a missing fee word or
  fee > gross. All consumers (earnings API, fundraisers, leaderboard) funnel through this
  one decoder, so every surface is corrected at once. Added 3 tests
  (`lib/leaderboard.test.ts`): net-98% with a 2% fee, missing-fee-word rejection,
  fee-exceeds-gross rejection. The stricter decoder also required updating the
  liaison tip fixtures (`lib/liaison.test.ts`, `lib/server/liaison/handlers.test.ts`)
  to build realistic two-word logs (gross + 2% fee, exactly as the contract emits);
  the liaison price check (`>= price × 0.97`) already tolerates the fee, so the
  paid-liaison verification flow is unaffected — verified by its 58 tests passing.

### 2. ⏳ NEEDS BRANDON'S DECISION — `/agents/hire` + `/agents/join` advertise x402 hiring in present tense
- `app/agents/hire/HireAgentsClient.tsx:104-138,408-415`, `hire/page.tsx:11`,
  `app/agents/join/page.tsx` (hero + steps): "hire them per API call", "Sell via x402",
  "Get listed. Get hired. Get paid.", "per-call crypto payments. Three steps, no human required."
- The x402 payment rail is parked/gone: the Render facilitator service is gone (account holds
  zero services, old URL 404s) and the liaison paid endpoint was parked 2026-09-14 per your
  "only production-grade" rule. No live end-to-end hire flow exists that a human buyer can
  complete today. One honest disclaimer exists on the hire page ("No 'pay now' button…
  settled through the x402 flow with your own client, outside the browser"), but the overall
  framing still presents x402 hiring as a working capability — in tension with your
  no-present-tense-claims-about-non-live-things rule.
- **Not changed** — needs your yes/no: keep the copy, soften it to "coming when funded,"
  or pull the hire flow until the rail is live.

### 3. ✅ FIXED — Sitemap advertised a route that 404s
- `frontend/public/sitemap.xml` listed `https://voicescape.vercel.app/townhall`, but
  `app/(townhall)` is a Next.js route group, not a URL — crawlers got a 404.
- **Fix (this branch):** removed the entry. (Town-hall pages live at `/forum`, `/chat`,
  `/events`, `/polls`, `/leaderboard`, `/marketplace`.)

## MEDIUM

4. **Unconfirmed ("submitted") purchases recorded as "paid" in the device-local list.**
   `app/(townhall)/marketplace/[id]/ListingDetailClient.tsx:~313-325` calls
   `recordPurchase()` in the mirror-lag "submitted" branch before on-chain confirmation;
   `PurchasesClient.tsx` presents the list as completed with a "paid" badge. A later
   on-chain revert still shows as paid until manually removed. Main end states
   (`done`/`error`) are correctly gated on `verifyPurchaseOnChain`. Left as-is (medium);
   honest fix would be a "confirming…" badge instead of "paid".
5. **Tip/buy flows check wallet connection, not the signed 7-day session.**
   `app/[username]/page.tsx` (TipBox) and `ListingDetailClient.tsx` (`startBuy`) require
   `useWallet().account` only. Likely by design — a direct wallet→contract tx is authorized
   by the wallet signature itself, and every server-side write (`/api/goals`, listing
   changes, town-hall writes) IS session-gated — but it differs from the "every write is
   checked against the signed session" posture. Flagged for awareness, not changed.
6. **Hardcoded English strings bypass the 14-locale dictionary** (i18n parity itself is
   perfect — see below — but these components don't use it):
   - `components/Navbar.tsx:71` — "Explore" hardcoded (`<>Explore</>`) while every sibling
     nav item uses `<T k="nav.X"/>`; `nav.explore` exists in 0/14 locales.
   - `components/DannyLiaisonPanel.tsx` — ~15 hardcoded English error messages
     (e.g. `:181` "No unused payment found on-chain.", `:335` `` `Tip failed: …` ``).
   - `components/Onboarding.tsx` — whole onboarding flow hardcoded English (step labels,
     human/agent picker, four "how it works" cards).
   - `lib/session.tsx` — `SignInButton`/`RequireSession` hardcode "Sign in with wallet" etc.
     despite `wallet.signIn*` keys already existing in the dictionary.
   - Lows: `TxConfirm.tsx` hardcoded prop defaults; `app/explore/page.tsx:56` hardcoded
     "Explore Blockpages" heading; `Navbar.tsx:97` hardcoded Discord tooltip.
   Left as-is (medium/low, translation quality risk doing 13 locales without native review).
7. **NavDropdown menu can clip the right edge on narrow phones.**
   `components/NavDropdown.tsx:74-88` — left-anchored 210px menu; triggers sit in the
   wrapped right nav cluster. Touch behavior is good (click toggle, Escape, outside-tap).
   Fix = right-anchored/viewport-clamped variant; left as-is.

## LOW

8. Hardcoded "Network fee ≈ 0.08 HBAR" in tip UI (`app/[username]/page.tsx:353`) —
   Hedera contract-call fees vary; figure is unverifiable from code and can drift.
9. `allTimeTruncated` caveat from `/api/earnings` is dropped before reaching the user
   (`EarningsPanel.tsx` has no such field) — all-time totals shown without the caveat.
10. Buy-flow "verifying the 98/2 split on-chain" copy overstates `verifyContractResult`
    (`lib/verify-tx.ts:44-87`), which checks success + event topic + nonzero amount, not
    the actual amounts. The split is contract-enforced, so harmless in practice.
11. `ForumClient.tsx:33` — "No boards yet — check back soon." (only renders on empty
    boards list; the single placeholder-ish line in the app).
12. `/mining-depin` metadata claims "Every listing checked live" — URLs are all real
    project sites and all `referralUrl` are null (consistent with pending referral links);
    could not re-verify "checked live" from code alone.

---

## VERIFIED CLEAN

- **Dead links:** every internal `href`/`<Link>` across all 29 routes resolves to a real
  route (`/`, `/builder`, `/explore`, `/forum`, `/chat`, `/events`, `/polls`,
  `/leaderboard`, `/marketplace` + subroutes, `/fundraiser`, `/agents` + subroutes,
  `/new-to-web3`, `/mining-depin`, `/messages`, `/following`, `/mod`, `/analytics`,
  `/admin/errors`, `/tx/[hash]`, `/[username]`, `/terms`, `/privacy`,
  `/.well-known/agent.json`). 404 page for unregistered usernames has proper copy + CTA.
- **Addresses:** no placeholder/dead `0.0.x` in any user flow; zero-address guardrails at
  both layers (`lib/tx.ts:132-148`, `lib/contracts.ts:79-103` — env placeholder can never
  silently build to Contract 0.0.0).
- **Hedera conformance:** zero hits for thirdweb/wagmi/web3.js/solana in code or
  `package.json`. `ethers@^6.17.0` imported in 13 non-test files — every use verified
  decode-only (`Interface` calldata encode/decode, `verifyMessage`, keccak/`AbiCoder`,
  `parseUnits`); no `JsonRpcProvider`/`BrowserProvider`/`Wallet`/`sendTransaction`.
  Chain path is `@hashgraph/hedera-wallet-connect` DAppConnector + `@hiero-ledger/sdk`,
  verification via official mirror-node REST (37 references). `@x402/hedera` is
  Hedera-native payment-protocol code (client-side 402 handshake), not a chain violation.
- **Session persistence (standing rule honored):** single root
  `WalletProvider → SessionProvider → LanguageProvider` (`app/providers.tsx`); 7-day
  HMAC bearer token in localStorage re-restored on every route change (never wiped);
  silent WalletConnect re-pair; no page forces re-connect or drops the session.
- **Fee framing:** "the fee just keeps spam uneconomical" / "Humans and AI agents are both
  welcome here" in all 14 locales; zero "keeps bots out"/"bot-proof" hits.
- **Terminology:** "blockpage" 386× in dictionaries; zero "MySpace-style"/spaced
  "block page" in user-facing code; zero "corner of cyberspace".
- **i18n parity:** all 11 nav keys present and non-empty in all 14 locales
  (type-enforced `Record<I18nKey, string>` + `dictionaries.test.ts`); banned-phrase sweep
  across all locales: zero hits.
- **Money flows:** tip error handling thorough (wallet rejection → friendly message,
  registry pre-check before signing, timeout → on-chain confirm, honest
  submitted/failed states, never claims failure when money may have moved); 98/2 shown
  accurately with ≈ labels; marketplace buy is atomic single `buyListing` with
  client+server seller verification and mismatch blocking; honest "no escrow / no buyer
  protection" copy on marketplace, purchases, and fundraiser pages; fundraiser completion
  derived at read time (no cron/state machine); goal setting session-checked and
  owner-gated; sell flow pins payout to the connected wallet with on-chain ownership
  verification. No mock/fake data on any data page (all from mirror node / real APIs).
- **Mobile layout:** no tables, no >400px fixed widths (except contained decorative orbs),
  grids collapse ≤760px, builder/hire/townhall CSS all have mobile breakpoints.
- **Misc:** Discord invite `https://discord.gg/2KGzPduUN5` identical in all 4 spots;
  Clarity countdown targets 2026-09-15 (matches the stated Senate vote date);
  `/tx/[hash]` is a real on-chain tip-proof verifier.

## NOT FIXED / OUT OF SCOPE

- 5 pre-existing failures in `frontend/lib/server/badges.test.ts` (backend, unrelated —
  were red before this sweep; see full-suite results below).
- x402 hire-page copy (HIGH #2) — needs Brandon's yes/no (see above).
- Mediums #4–#7 and Lows #8–#12 — noted for the backlog; no redesigns or translation
  rewrites per sweep scope.
- Untouched: `telegram-bot/`, `branding/` videos, `MOCKUP_VS_PRODUCTION.md`
  (other agents' work). No heavy edits inside liaison interview-flow files.

## GATES (this branch)

- `npx tsc --noEmit`: clean
- `npx vitest run`: full suite (5 pre-existing badge failures noted above; all other
  tests pass, including the 3 new decoder tests)
- `npm run build`: success
- Dependency/import sweep: no new non-Hedera chain libs (ethers remains decode-only)

**NOT DEPLOYED** — production deploy needs Brandon's explicit "go". No mainnet state
touched; no value moved.
