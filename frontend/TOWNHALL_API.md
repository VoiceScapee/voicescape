# Voicescape Social Town Hall — API + HCS contract

Server layer: `lib/server/townhall/`. REST routes: `app/api/townhall/`.
This document is the exact contract the frontend UI builds against.
Anything here that differs from the settled spec is listed under
**Deviations** at the bottom.

## Architecture

HCS is the substrate: ordered, timestamped, cheap. **One topic per domain**
(cheaper to manage than per-board topics):

| Domain     | Env var                | Kinds on the topic                       |
|------------|------------------------|------------------------------------------|
| forum      | `TOWNHALL_TOPIC_FORUM` | `post`, `mod-action`                     |
| chat       | `TOWNHALL_TOPIC_CHAT`  | `chat`, `mod-action`                     |
| votes      | `TOWNHALL_TOPIC_VOTES` | `rep-vote`                               |
| polls      | `TOWNHALL_TOPIC_GOV`   | `proposal`, `proposal-vote`, `event`     |
| market     | `TOWNHALL_TOPIC_MARKET`| `listing`                                |

Boards, walls and rooms are **fields in the message**, not topics.

HCS is append-only. Moderation = `mod-action` messages + server-side
filtering. Votes and listings use **latest per key wins** semantics
(re-voting changes your vote; a new `listing` message with the same `id`
replaces the old one).

## HCS message envelope

Every message is JSON: `{v:1, kind, ts:"<iso>", author:"<username>", ...}`.
`ts` is set by the server at submit time. `seq` is the HCS consensus
sequence number (the ordering primitive everywhere).

- post: `{kind:"post", board:"general", wall:"<username>"|null, body, replyTo:"<seq>"|null}`
- chat: `{kind:"chat", room:"lobby", body}`
- rep-vote: `{kind:"rep-vote", target:"<username>", voter:"<username>", value:1|-1}` — latest per (voter,target) wins
- proposal: `{kind:"proposal", id:"<slug>", title, body, closesAt:"<iso>"}`
- proposal-vote: `{kind:"proposal-vote", proposal:"<id>", voter, choice:"yes"|"no"|"abstain"}` — latest per (voter,proposal) wins
- event: `{kind:"event", id:"<slug>", title, description, startsAt:"<iso>", room:"event-<id>"}` (see Deviations)
- listing: `{kind:"listing", id:"<slug>", seller:"<username>", title, description, priceUsdCents, goodsType:"physical"|"digital", ipfsHash|null, status:"active"|"sold"|"cancelled"}` — latest per id wins
- mod-action: `{kind:"mod-action", targetKind?:"post"|"chat", board|null, wall|null, targetSeq, action:"hide"}`
  — submitted via `POST /api/townhall/mod-actions` (see below). Post hides
  live on the forum topic; chat hides live on the chat topic with the room
  name in `board`. `targetKind` defaults to `"post"` for pre-existing
  actions. The HCS `author` field is the session-verified moderator.

## REST API

All routes live under `app/api/townhall/`. JSON in, JSON out.

### Boards

- `GET /api/townhall/boards` → `{boards:[{id,title,description}]}`.
  Seed boards: `general`, `announcements` (mods post-only), `ideas`, `help`.

### Forum posts

- `GET /api/townhall/posts?board=&wall=&limit=&before=` →
  `{posts:[{seq,board,wall,author,body,replyTo,ts}]}`.
  Newest first. Mod-hidden posts are filtered out. `before` = a seq cursor
  (returns posts with `seq < before`). `limit` defaults to 50, max 100.
- `POST /api/townhall/posts` `{board?,wall?,body,replyTo?,dustFeeTxId,author}` →
  `201 {seq}`. Dust fee required (see below). Errors:
  `400` bad body/board/wall/replyTo, `402` fee missing or invalid
  `{error,dustFeeTinybars,treasury}`, `403` author not registered in the
  on-chain registry, `403` non-mod posting to `announcements`.

### Reputation

- `GET /api/townhall/reputation?target=&voter=` →
  `{target,up,down,score,myVote}` where `score = up - down` and `myVote`
  is `1|-1|null` (the requesting voter's current vote).
- `POST /api/townhall/reputation` `{target,voter,value}` →
  `{up,down,score,myVote}`. Voter must be registered. One vote per voter
  per target, changeable (latest wins). `400` on self-vote or bad value.

### Polls (proposals)

Advisory polls only — no on-chain execution. UI route
`app/(townhall)/polls` (`PollsClient`); renamed from "governance" 2026-09-10.

- `GET /api/townhall/proposals` →
  `{proposals:[{id,author,title,body,closesAt,yes,no,abstain}]}` (newest first).
- `POST /api/townhall/proposals` `{author,title,body,closesAt,dustFeeTxId}` →
  `201 {id}`. Dust fee required.
- `POST /api/townhall/proposals/[id]/vote` `{voter,choice}` →
  `{yes,no,abstain}`. Latest vote per voter wins. Voter must be registered.

### Chat

- `POST /api/townhall/chat/[room]` `{author,body,dustFeeTxId}` → `201 {seq}`.
  Dust fee required. Author must be registered.
- `GET /api/townhall/chat/[room]/stream?since=<seq>` — Server-Sent Events.
  Events: `data: {"seq":..,"room":..,"author":..,"body":..,"ts":..}`.
  Implementation: initial burst of all messages with `seq > since`, then the
  chat topic is polled every 5s; `: keepalive` comments keep the connection
  warm. The stream closes when the client disconnects. Reconnect with
  `?since=<last seen seq>`.

### Moderation

- `POST /api/townhall/mod-actions`
  `{author, targetKind?:"post"|"chat", targetSeq, board?, wall?}` →
  `201 {seq}`. Appends a mod-action (hide) to the HCS topic of the target's
  domain (forum topic for posts, chat topic for chat messages; chat hides
  carry the room name in `board`). Session + page-owner gated, then
  authorized: `TOWNHALL_MODS` global mods may hide anywhere; a page owner
  may hide on their own wall. Errors: `400` bad targetSeq, `401` no/invalid
  session, `403` not a moderator here, `404` target not found. No dust fee.
  Hides are permanent in v1 (HCS is append-only; there is no unhide action).
- `GET /api/townhall/mod-status?username=<page>&wall=<page?>` →
  `{username, isMod, canModerateWall}`. Tells the UI whether the signed-in
  page owner may moderate (drives the Hide button visibility).

### Events

- `GET /api/townhall/events` →
  `{events:[{id,title,description,startsAt,room}]}` sorted by `startsAt`.
- `POST /api/townhall/events` `{author,title,description,startsAt}` →
  `201 {id}`. Author must be in `TOWNHALL_MODS` (`403` otherwise).
  `room` is `"event-<id>"`. No dust fee (mods only).

### Marketplace listings

- `GET /api/townhall/listings` →
  `{listings:[{id,seller,title,description,priceUsdCents,goodsType,ipfsHash,status,ts}]}`.
  Latest message per `id` wins (status updates are new messages).
- `POST /api/townhall/listings`
  `{seller,title,description,priceUsdCents,goodsType,ipfsHash?,dustFeeTxId}` →
  `201 {id}`. Dust fee required. Seller must be registered.
- `POST /api/townhall/listings/[id]/status` `{seller,status}` → `200 {}`.
  Seller-only (`403` otherwise). `status` is `sold`|`cancelled` (`400` on
  anything else, `404` on unknown id).

### Direct sales (atomic, no escrow)

Marketplace sales are single atomic transactions through the
VoicescapeTips contract: `buyListing(address seller, string listingRef)`
payable — 98% to the seller, 2% to the treasury, in the same transaction.
The contract never holds buyer funds; there is no escrow and no buyer
protection. Delivery happens off-chain. `PurchaseCompleted(buyer, seller,
listingRef, amount, fee)` events are the on-chain proof-of-payment used
for reputation-vote eligibility.

### Ids

`id` for proposals, events and listings = URL-safe slug of the title +
`-` + base-36 timestamp (unique, human-readable).

## Dust fee

Every forum post, chat message, proposal and listing costs a tiny HBAR
dust fee → treasury. Flow:

1. Client sends an HBAR transfer of `>= DUST_FEE_TINYBARS` tinybars to the
   treasury address (`NEXT_PUBLIC_TREASURY_ADDRESS`) from its own wallet.
2. Client passes the Hedera tx id as `dustFeeTxId` (e.g.
   `0.0.1234@1694000000.000000000`).
3. Server verifies via the free mirror node REST API
   (`/api/v1/transactions/<txId>`) that the tx succeeded, transferred
   enough to the treasury, was paid by the caller's own wallet, and that
   the tx id hasn't been used before — **before** submitting anything to
   HCS.
4. Missing/invalid/underpaid fee → `402 {error, dustFeeTinybars, treasury}`.
   The client can retry with a fresh fee tx id; the response tells it exactly
   how much and where.

Default `DUST_FEE_TINYBARS=2_000_000` tinybars = 0.02 HBAR ≈ $0.004 at
~$0.20/HBAR — a real per-write cost that prices out spam while staying
cheap enough to ignore for legitimate use. It exists to deter spam, not
to earn revenue.

Two anti-abuse rules are enforced server-side, both checked against the
mirror node before anything is submitted to HCS:

- **Single-use fee tx ids.** Every accepted fee tx id is recorded and
  rejected on reuse — one payment buys exactly one write. (v1 keeps this
  registry in process memory with a 7-day TTL: a server restart wipes it,
  and a second server instance doesn't share it.)
- **Sender binding.** The fee must be paid by the wallet that signed the
  session: the tx's payer (parsed from its own `transaction_id`) is
  compared against the session account. `0x…` sessions are resolved to
  their `0.0.x` account id via the mirror node
  `/api/v1/accounts/<evm-address>` before comparing.

## Trust model

- **Only registered page owners may write.** Every write route requires a
  signed wallet session (`requireSession` in `auth.ts`); the session's
  wallet must own the claimed page (`requirePageOwner`, verified live
  against the on-chain registry). Server-side results are cached for 60s.
- **Moderation:** page owners moderate their own walls (a `mod-action`
  whose `wall` equals the author's username). Global/board mods come from
  the `TOWNHALL_MODS` env list (comma-separated usernames). The
  `announcements` board is post-only for mods; events are mod-only.
  HCS `author` is the session-verified page owner, so mod-actions are
  honored only from authorized moderators or the wall owner.
- **Wallet-signature authorship (shipped).** Every write route requires a
  signed session (`requireSession`/`requirePageOwner`): the client signs an
  EIP-4361-style "Sign in with Voicescape" message and the server verifies
  the signature (EVM `personal_sign` recovery, or Hedera Ed25519 via the
  mirror node) and binds the session to the on-chain page owner. The
  `x-vs-session` header is a **bearer token**: replaying the identical
  header works for the whole 7-day session, and the nonce registry is
  per-instance in-memory state (wiped on restart, not shared across
  instances). High-value actions such as a marketplace purchase are
  wallet-signed on-chain, which is the real backstop.
- **Mod-hide applies to forum posts and chat messages.** Hides are
  submitted via `POST /api/townhall/mod-actions` (session + page-owner
  gated; global mods or the wall owner) and filtered out of
  `GET /api/townhall/posts` and the chat SSE stream. Hides are permanent
  in v1 (HCS is append-only; there is no unhide action).
- Server operator keys (`TOWNHALL_OPERATOR_ID`/`TOWNHALL_OPERATOR_KEY`)
  are server-only — never exposed to the browser.
- Never put real private keys/seed phrases in chat or files (env vars
  only). Never create real HCS topics or touch mainnet without Brandon's
  explicit go. Tests mock HCS and the mirror node — no network.

## Environment

| Var | Where | Purpose |
|-----|-------|---------|
| `TOWNHALL_OPERATOR_ID` | server-only | HCS submit operator account |
| `TOWNHALL_OPERATOR_KEY` | server-only | HCS submit operator key (env only!) |
| `TOWNHALL_HCS_NETWORK` | server | `testnet`\|`previewnet`\|`mainnet` |
| `TOWNHALL_TOPIC_FORUM` | server | forum topic id |
| `TOWNHALL_TOPIC_CHAT` | server | chat topic id |
| `TOWNHALL_TOPIC_VOTES` | server | votes topic id |
| `TOWNHALL_TOPIC_GOV` | server | polls topic id (env name retained) |
| `TOWNHALL_TOPIC_MARKET` | server | market topic id |
| `DUST_FEE_TINYBARS` | server | dust fee in tinybars (default 2,000,000 = 0.02 HBAR) |
| `NEXT_PUBLIC_TREASURY_ADDRESS` | public | dust-fee recipient (0.0.x) |
| `TOWNHALL_MODS` | server | comma-separated moderator usernames |

Create the five topics once with `npm run townhall:init` (runs
`scripts/townhall-init.ts` via tsx; refuses mainnet without an explicit
`TOWNHALL_HCS_NETWORK=mainnet` re-run — and that re-run still needs
Brandon's go), then paste the printed ids into env.

## Sales contract (verified interface)

Marketplace sales settle through `VoicescapeTips.buyListing` (no escrow —
the contract never holds buyer funds):

```solidity
function buyListing(address seller, string listingRef) payable;
// 98% to seller, 2% to treasury, atomically in the same transaction.
// Emits PurchaseCompleted(buyer, seller, listingRef, amount, fee).
```

## Deviations from the settled spec

1. **`event` HCS kind added.** The envelope spec listed 7 kinds; events
   needed one, so `event` lives on the polls topic with
   `{kind:"event", id, title, description, startsAt, room}` and
   `room = "event-<id>"`.
2. **Chat SSE polls every 5s** with `: keepalive` comments and closes on
   client disconnect (reconnect with `?since=<seq>`).
3. **Mod-hide filtering applies to forum posts and chat messages.**
   Hides are permanent in v1 (no unhide action; HCS is append-only).
4. **Posts `GET`**: `limit` defaults to 50, max 100.
5. **402 body shape**: `{error, dustFeeTinybars, treasury}` (the spec's
   `{dustFeeTinybars, treasury}` plus an `error` string).
6. **Env var names**: `TOWNHALL_TOPIC_GOV` and `TOWNHALL_TOPIC_MARKET`
   (per spec), plus `TOWNHALL_TOPIC_VOTES`.
7. **`createPost` wall validation**: wall posts require the wall owner to
   be registered (not in the original spec; prevents typosquatted walls).
