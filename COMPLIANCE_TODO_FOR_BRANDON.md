# Compliance TODO — needs Brandon or counsel

Companion to the compliance brief (`workspace/your_files/voicescape-compliance-brief/`).
The brief is a lawyer-conversation map, not a verdict. This file lists exactly
what still needs a human decision or a lawyer — and what code is already in
place for each item. **Nothing here is legal advice.**

Status as of 2026-09-18, branch `danny/compliance-alignment` (not yet merged).

---

## 1. Form the entity (LLC or chosen entity) — OWNER: Brandon
- The ToS operator is still just "Voicescape" (`frontend/lib/legal/legal.ts`
  carries a note for future edits). No LLC exists.
- Why first: DMCA-agent registration, any licensing memo, and the ToS
  operator name all depend on it.
- **Prepared:** nothing to code until the entity exists; when formed, replace
  the operator name/details in `lib/legal/legal.ts` and regenerate the review
  copies (`node frontend/scripts/generate-legal-docs.mjs`).

## 2. Register a DMCA designated agent with the U.S. Copyright Office — OWNER: Brandon (+ counsel)
- Until this happens, Discord-channel-only intake very likely does **not**
  satisfy §512(c) safe harbor.
- **Prepared:**
  - On-site notice/counter-notice intake: `/dmca` page + `POST /api/dmca`
    (records notices with receipt timestamps — the expeditious-removal clock).
  - Admin queue: `GET/POST /api/dmca/admin` (founder-only) to review notices;
    "takedown" marks actioned and records a copyright strike.
  - Designated-agent contact reads `DMCA_AGENT_CONTACT` env; defaults to
    "Discord #customer-support (Voicescape server)" until the official agent
    is registered — **then set the env var** to the registered contact.
  - Repeat-infringer pipeline actually runs: per-wallet strike tracking
    (`DMCA_MAX_STRIKES`, default 3), suspension from town-hall writes at the
    threshold, wired into the existing enforcement guard; full test coverage.
  - ToS §12 now points at the `/dmca` form as well as Discord; ToS/Privacy
    effective dates bumped to September 18, 2026 — **counsel should review
    the updated legal text before it ships.**

## 3. OFAC sanctions program scoping — OWNER: counsel
- Largest operational gap in the brief: no geofencing, no IP blocking, no
  SDN-address screening today. "Small and non-custodial" is not a shield.
- **Prepared (plumbing only, default OFF — nothing blocks today):**
  `lib/server/sanctions.ts` with `SANCTIONS_SCREENING_ENABLED` (default off)
  and `SANCTIONS_BLOCKLIST_ADDRESSES` (comma-separated wallet addresses).
  When counsel scopes the program, flip the flag, supply the address list,
  and wire `screenAddress()` into the tip/purchase write paths — no code
  changes needed for the config. IP geoblocking decisions (jurisdictions,
  geolocation source, edge vs. app layer) are deliberately left to counsel.

## 4. Money-transmission / BitLicense memo — OWNER: counsel (NY counsel for BitLicense)
- Confirm the non-custodial analysis in writing; pay specific attention to
  the x402 settle-then-forward rail (operator as payee — the closest thing
  on the platform to "accept and transmit") and the NY "venue, not a party"
  characterization of the marketplace given the in-contract 2% fee.
- **Prepared:** the non-custodial invariant is now asserted in tests —
  tips and marketplace purchases route the full value to the Tips contract
  in one transaction, no escrow, no client-side skim
  (`lib/contracts.test.ts`, plus the existing `sales.test.ts` atomic-98/2
  check). No payment/wallet/fee/contract code paths were touched.
- ⚠️ **Needs-human-review flag:** if counsel's memo requires changing the
  x402 rail, that work touches payment code paths — it was deliberately not
  started here.

## 5. EU / MiCA strategy — OWNER: Brandon + counsel (explicit decision)
- Options: (a) treat the platform as in-scope and assess CASP authorisation,
  (b) geofence the EU, or (c) build a genuine decentralisation case. Reverse
  solicitation will not cover an actively marketed dapp. Do not drift.
- **Prepared:** privacy-policy groundwork (lawful basis, minimization,
  data-rights path) so the GDPR side of EU operation is documented; no
  geofencing or authorisation work started — the decision comes first.

## 6. GDPR posture review for EU users — OWNER: counsel
- **Prepared:** Privacy Policy now states the lawful basis (consent /
  legitimate interests / legal obligation), data-minimization posture,
  DMCA-notice retention, and an on-site data-rights request path
  (`/privacy-request` + API, wallet-keyed, no new PII collected). Analytics
  named as Vercel Web Analytics (cookieless). CCPA thresholds are unmet
  today — re-check if the business scales.
- Counsel should bless the policy, especially the EDPB "don't record
  personal data on-chain" advice against the reality of public wallet
  addresses, and the on-chain immutability disclosure.

## 7. Creator tax notice — OWNER: none (shipped in code, monitor IRS rulemaking)
- **Done:** plain-language `<TaxNotice>` on the tip box, the marketplace buy
  button, and the creator earnings panel: tips/sale proceeds are generally
  taxable income the creator must report; not tax advice.
- Watch: the IRS's promised future DeFi-broker rules may change the
  1099-DA exclusion — revisit when they land.

## 8. Marketing discipline — OWNER: Brandon (ongoing habit)
- **Done:** full app/site copy scrub for investment/safety/guarantee/
  insurance-like claims. One fix: a payment-timeout error that implied a
  safety guarantee ("your payment is safe") → factual support path. No
  other claims found; ToS §§5/7/13 already disclaim investment status.
- Keep it that way: no "safe," "guaranteed," "insured," "risk-free," or
  profit-promising language in any future copy.

## 9. Repeat-infringer workflow — OWNER: none (implemented; operate it)
- **Done (code):** see item 2. The policy is now "reasonably implemented,"
  not just written.
- **Needs Brandon:** actually use the `/api/dmca/admin` queue when notices
  arrive; a successful counter-notice/appeal clears strikes via
  `clearStrikes` (admin-only).

## 10. Revisit on every new rail — OWNER: Brandon (process)
- Each addition (XRPL EVM sidechain, USDC Phase B, new paid features)
  re-opens the money-transmission and MiCA analysis — make it a checklist
  item before shipping. Nothing to code; it's a habit.

---

## What was deliberately NOT done
- No changes to payment/wallet/fee/contract code paths.
- No OFAC blocking enabled (flag exists, default off).
- No EU geofence, no MiCA authorisation work — strategy decision comes first.
- No new PII collection (DMCA notices are the legal exception: the law
  requires the reporter's identity/contact, kept in a private log).
- No merge, no deploy, no chain transactions, no HBAR moved.
