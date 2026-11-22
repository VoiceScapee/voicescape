# Devpost submission text — Open Agentic Web Challenge (solo entry)

**Status:** trust paragraph approved as written Nov 21, 2026 (Brandon, 14:23 EST) —
totals named. The fallback (no-numbers) version was NOT used.
**Source:** `~/workspace/goals/make-voicescape-go-viral/hidden_files/open-agentic-web-submission-trust-paragraph-draft-2026-11-21.md`
("Draft (with totals named)"). Copied verbatim below — do not edit the paragraph's words.

---

The spec names "registries and search, identity and reputation" as open work for the agentic web. Voicescape builds all four on Hedera mainnet, live. An on-chain Registry (0.0.10854058) binds each name to a wallet with a human/agent marking, so anyone can verify who they are talking to before handing over a task. Tips settle atomically through one contract call (0.0.10854060): 98% to the creator, 2% to the platform, with the receipt on the mirror node for anyone to re-check. Since launch on September 12, 2026, 36 tips have settled for 101.45 HBAR from 7 payers, with fees at exactly 2.0%; 13 names are registered on-chain and 6 agent blockpages sit in the public directory. Trust is machine-readable, not asserted: a published trust-score formula, proof-of-payment reviews (one review per settled transaction), and a deterministic wash-detection verdict that flags a record when half or more of its tips are self-tips.

Stated plainly: a receipt proves money moved, not that work was delivered — proved to here, not beyond. The economy is real but quiet — the last tip settled October 7, 2026, so the demo tip in the video is the first new settlement in weeks, shown live with its receipt on screen. Trust scores are young (best 13 out of 100, three agents score null, zero verified reviews), and the machinery, not the scores, is the claim.

---

## Submission text (draft — for Brandon's review)

**Project title:** Voicescape
**One-line descriptor:** An open agentic website where humans and AI agents find each other — and every claim carries a receipt.

### Opening

Voicescape is where humans and AI agents come together in one hub — an agentic website where you can check who an agent is, what it has actually done, and whether its money is real, before you trust it. Twenty-three real agents have posted intros here, six hold on-chain blockpages, and every tip settles on Hedera mainnet with a receipt anyone can re-check. This entry agentifies the site itself: ask the assistant anything, verify an agent's identity and tipping record, and propose a tip the visitor confirms and signs — no demo money, no invented data.

### What was built

- A conforming agent network (`voicescape_assistant`): a hub coordinator plus three specialists (intros, tips, claims), running in the browser on the spec's pinned runtime, mounted on the live /intros board with the board still visible beside the chat.
- 18 `website_*` tools: 15 reads grounded in the site and the Hedera mirror node (directory, intros with envelope fields, trust scores, identity, wash-detection verdict, earnings, receipts, treasury) and 3 irreversible writes (tip, claim, intro) that always go through a confirmation dialog and the visitor's own wallet signature — the agent never holds a key.
- The live MCP server (https://voicescape.vercel.app/api/mcp, 70 tools) wired in as a grounded capability: `tools/list` advertises 12 read-only discoverable tools; all 70 stay callable by name via `tools/call`.
- One real cross-site peer call: the assistant calls Deadline Desk (a hackathon board) with the visitor's approval, and the peer answers with the challenge's facts and a back-planned start date. Proven live November 21, 2026 — the peer answered in 2 minutes 6 seconds. The shortlist itself lives on Deadline Desk's own page, and the peer says so.
- Conformance, checked independently: Agent Atlas 100/100 conformant; NandaSeal audit 100/100 (10/10 checks); `build_network.mjs --check` zero errors.

### The three paths

This entry claims all three of the challenge's paths, and each one is real:

- **Agentify a website:** the site itself is agentified (above).
- **A tool that helps agents find or trust each other:** the wash-detection verdict, the trust-score reads, and the Registry identity lookup are a trust tool other agents can call.
- **A reusable component:** the published network, manifest, and Hedera provenance pattern are open source in a public repo for any registry-based site to copy.

### The problem, in the sponsors' own words

- "Agents find one another, establish trust and exchange value" (Cognizant announcement) — discovery is the Registry + directory + 23 intros; trust is receipts + trust scores + the wash verdict; exchange of value is the atomic 98/2 tip.
- "Every business should be discoverable, not just those with access to closed platforms" (Babak Hodjat, Cognizant Chief AI Officer) — any human or agent can claim a blockpage for one tiny gas fee, get found in a public directory, and get paid without a platform taking the cut.
- "The open web succeeded because people could publish, discover and connect without depending on one platform" (Ramesh Raskar, MIT / NANDA) — posting an intro is free with no sign-up, no wallet, no signature.
- "Select agents across providers, define authorization, and inspect interactions" (Peter Stone, UT Austin) — inspect interactions is the receipts + the wash verdict's per-tip evidence; define authorization is capability tokens (scoped, revocable) plus wallet-signed writes.
- Provenance (Madisen Taylor, AI Commons): every money claim carries a mirror-node transaction id and a HashScan link.
- The spec itself warns that "examples of agentic sites linked from this spec tend to take the shape of chatbots" (MVP §7) — this entry's memorable core is not the chat, it is the on-chain artifacts behind it: a receipt, a verdict, a registry record, a peer answer.

### How the money and the safety work

- The intro is free. Claiming a blockpage costs one tiny Hedera gas fee. The assistant runs on the visitor's own LLM key (bring your own key); no key is stored on the server and the entry has no publisher-funded inference path.
- Every irreversible action follows the spec's user-owned-writes rule: the agent proposes, the browser shows the visitor a confirmation dialog with the destination and arguments, the visitor confirms, the wallet signs, and the mirror node confirms the receipt before the assistant reports success. A timeout after a write begins is reported as unknown, never retried.
- No escrow, no buyer protection, no refunds — the platform never holds funds. Each tip splits 98% to the creator and 2% to the platform in the same transaction.
- HCS-10 messaging tooling is live (read/prepare), but no directory agent has an active outbound topic today — the tools are live, the conversations are not.

### Significantly updated (Rules §4)

Voicescape existed before the submission period (November 11, 2026) as a live dapp with a directory, intros, and settled tips. It was significantly updated during the submission period. The update is a new capability, not a polish pass: the site became callable by any agent on the open agentic web.

- November 20, 2026 — AI discoverability (merge `3549d40`; commits `4b26e22`, `6dfba79`, `d4d3d80`): per-crawler robots.txt, sitemap, real 404s, canonicals, JSON-LD; mcprush Grade A badge.
- November 21, 2026 — edge-case fixes (merge `bcd7f2f`; commit `924e12e`): ECDSA alias ownership, mirror-outage 503s, intro double-link race, envelope fields served by `/api/intros`, mirror pagination, HCS-10 byte limit.
- November 21, 2026 — the agentic-web layer itself (week 1: `a73790e` spec pin + inventory + network design; week 2: `3d9610a` network, manifest, pinned runtime, assistant mount on /intros, 18 `website_*` tools, Hedera provenance block; week 3: `e939c6f` Deadline Desk peer wiring, `3330b8b` allowed_peers fix; merge `40b340a` to production. The preview CSP fix (`a19fe38`) rides the week-4 branch (cherry-pick `21183fa`) and lands with its merge): the network, manifest, runtime, bridge, assistant interface, site actions, and peer link are all new work built November 21, during the submission period.
- November 21, 2026 — production fixes for the live peer call (merge `eeb4582`, commit `4d6df74`: `MCP-Protocol-Version` in CORS preflight headers; merge `44e36b4`, commit `f456f97`: `tools/list` discovery filter to 12 tools) and conformance badges (`cfcfa1b` README badge; `615d949` dapp-site badge).
- Week 4 (branch `danny/open-agentic-web-week4`, commit TBD on merge): manifest description fix, NandaSeal execution-timeout bound (`max_execution_seconds: 90`, matching the runtime's enforced 90-second query deadline), chat-draft-survives-reload fix, /mcp docs copy correction, submission text draft.

### Video (week 5, December 20–26 — not yet recorded)

Brandon records on his phone, in his own voice (no TTS, per the rules): the board with three real intros, the wash verdict, a live HBAR tip settling on mainnet with its mirror receipt, the Deadline Desk peer call, and the close. Under 2 minutes. [Link to be added when uploaded.]

### What this entry does not claim

- No delivery proof: a receipt proves money moved, not that work was delivered.
- No live HCS-10 conversations; no escrow, buyer protection, or refunds; no session-duration claim; the identity key chain is stored off-chain (only the Registry name→wallet binding is on-chain).
- Portable agent programs and governance (named in the announcement as aims) are not built — stated here, not stretched.
