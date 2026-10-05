# Security Policy

Voicescape moves real money on Hedera mainnet. If you find a vulnerability,
we want to hear about it — and we will not punish good-faith research.

## How to report

**Preferred:** open a private vulnerability report via
[GitHub Security Advisories](https://github.com/VoiceScapee/voicescape/security/advisories/new)
on this repo. It stays private until we agree on disclosure.

**Alternative:** post in the Voicescape Discord `#customer-support` channel
with the word **SECURITY** at the start and ask for a private thread. Do not
post exploit details in a public channel.

A dedicated `security@` contact address is planned; until it exists, the two
channels above are the official intake. (Track: `docs/POST_LAUNCH_OPS.md`.)

## What to include

- What you found, in plain words — which contract, route, or tool, and what
  an attacker could do with it.
- Steps to reproduce (a transaction, a request sequence, a script).
- What you think the impact is: whose funds, how much, how likely.
- Your contact, so we can ask follow-ups and credit you.

## Scope

In scope: the on-chain contracts (`contracts/`), every dapp route that
touches wallets, sessions, tips, or payouts (`frontend/app/api/`,
`frontend/lib/server/`), the MCP server (`frontend/app/api/mcp/`), the
wallet sign-in flow, and the town-hall spam-fee / moderation-bypass surface.

Out of scope: the Vercel/Hedera/Pinata infrastructure itself (report those
to the vendor), social-engineering of team members, and denial-of-service
volume testing against production.

## Ground rules

- **Do not** exploit beyond the minimum needed to demonstrate the issue.
  Do not touch other users' funds, pages, or data — ever.
- **Do not** publicly disclose before we have shipped a fix and agreed on
  timing. We commit to responding within 72 hours and to keeping you
  updated until resolution.
- Testnet-style probing against mainnet contracts is acceptable for
  read-only verification. Anything that writes, moves funds, or degrades
  service for others needs prior written agreement.

## What happens next

1. We acknowledge within 72 hours.
2. We assess impact and build the fix on a private branch if needed.
3. We ship the fix through the normal deploy gates (no gate is ever
   weakened to ship faster).
4. We disclose — in `CHANGELOG.md` and, for fund-impacting issues, a
   public postmortem. Researchers are credited by name/handle unless they
   prefer anonymity.

There is no paid bug-bounty program today. Responsible disclosures are
recognized in the changelog and the reporter is credited publicly. A
scoped testnet bounty (following the material-loss-of-funds rule) is on
the roadmap — see `docs/POST_LAUNCH_OPS.md`.
