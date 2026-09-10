# Voicescape Safety & Content Policy

Voicescape is built on Hedera Consensus Service (HCS), which is **append-only
and immutable**: once a message is submitted to a topic, it cannot be edited
or deleted by anyone — not users, not moderators, not the platform operator.
This document explains how we keep the town hall safe anyway.

## What's prohibited

The following are never allowed anywhere on Voicescape (block pages,
town hall forum/chat, marketplace, chatrooms):

1. **Child sexual abuse material (CSAM)** — any sexual content involving
   minors, or facilitation/trading of such material. Zero tolerance.
2. **Terrorism** — recruitment, propaganda, or coordination for designated
   terrorist organizations.
3. **Violent threats** — credible threats of violence against people or
   places (including bomb threats and mass-violence threats).
4. **Doxxing** — posting someone else's non-public personal data:
   Social Security numbers, payment card numbers, private addresses,
   non-public phone numbers.
5. **Illegal activity** — fraud, scams, sale of stolen goods, or anything
   illegal under US law.

Gray-area content (harassment, spam, low-quality listings, disputes) is
handled through **user reporting + moderator review**, not automatic
blocking.

## How enforcement works (three layers)

### 1. Pre-publish filter — blocked content never reaches the chain

Every town-hall write (forum post, chat message, marketplace listing,
chatroom title/description) passes through a synchronous content filter
(`frontend/lib/server/townhall/content-filter.ts`) **before** any HCS
submit:

- CSAM phrases, terrorist organization names, explicit violent-threat
  patterns, SSN shapes, and Luhn-valid payment card numbers are blocked
  with HTTP 400 and a categorical reason (e.g. "threats of violence are
  prohibited"). Reasons never echo the matched text.
- The filter runs in under 1ms — it never slows down posting.
- It is intentionally biased toward **false positives** for illegal
  content: a wrongly blocked message is a support ticket; a published
  illegal message is a platform risk. If your legitimate message was
  blocked, contact a moderator.
- Blocked attempts are logged with the category only — never the text,
  never the author.

Because HCS is immutable, this gate is the critical one: **what the
filter blocks never exists on-chain.**

### 2. User reporting — free and frictionless

Any signed-in user can report a forum post, chat message, or marketplace
listing:

- `POST /api/townhall/reports` — requires a wallet session only. **No
  page ownership required, no dust fee.** Reporting must never cost the
  reporter.
- Reports are stored as `kind: "report"` messages on the **same HCS
  topic** as their target, so moderators see reports next to what was
  reported.
- Report reasons are **not** run through the content filter — quoting
  violating content to describe it must not get the reporter blocked.
  Reports are only visible to moderators.

### 3. Moderator hide actions — server-side filtering

Moderators (usernames in `TOWNHALL_MODS` or wallets in
`TOWNHALL_MOD_WALLETS`) review the report queue
(`GET /api/townhall/reports`, mod-only) and can hide content:

- Hides are `kind: "mod-action"` messages; the existing read paths
  (`getPosts`, `queryChatMessages`) filter hidden seqs server-side, so
  hidden content disappears from the app for everyone.
- Hiding does **not** delete from HCS (nothing can) — it removes the
  content from what Voicescape serves. The underlying message remains
  on the public ledger, which is also what makes moderation actions
  themselves auditable.
- Page owners can hide posts on their own wall without being global mods.

## Other protections already in place

- **Wallet-signed sessions**: every write requires a signed login message;
  authorship is cryptographically verified, so bans and reports stick to
  real identities.
- **Dust fee**: every town-hall write costs a small HBAR fee to the
  treasury, making spam floods uneconomical.
- **Rate limits**: per-IP flood bounds plus per-wallet daily quotas on
  free write paths (reports included — 50/day default).
- **The 98/2 marketplace split** is enforced by the Tips smart contract,
  not by trust.

## For moderators

- Review the report queue regularly. Reports are newest-first and show
  the target, the reason, the reporter, and the timestamp.
- When hiding, target the exact `targetSeq` (posts/chat) or use the
  listing id. Double-check before hiding — the hide is itself a
  permanent, public on-chain record.
- CSAM: hide immediately, preserve evidence, and report to NCMEC
  (report.cybertip.org). Do not download or redistribute the material.
- You cannot delete from HCS. If illegal content reached the chain
  (filter bypass), hide it in-app immediately and escalate to Brandon —
  the topic operator can rotate to a fresh topic if needed.

## Limits of this system

- The pre-publish filter is keyword/pattern-based. It catches known-bad
  shapes reliably but cannot understand context or novel evasion. The
  reporting + moderation layers exist for exactly that reason.
- HCS immutability cuts both ways: it guarantees censorship-resistance
  for legitimate speech and makes true deletion impossible. The safety
  model is **prevent (filter) → report → hide from the app**, in that
  order.
