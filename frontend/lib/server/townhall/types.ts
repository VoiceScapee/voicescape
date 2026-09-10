/**
 * Voicescape Social Town Hall — HCS message envelope + REST payload types.
 *
 * HCS is the substrate: one topic per domain (forum, chat, votes,
 * polls, market). Boards, walls and rooms are FIELDS in the message.
 * HCS is append-only, so moderation = `mod-action` messages + server-side
 * filtering, and votes/listings use "latest per key wins" semantics.
 */

/** Envelope every Town Hall HCS message carries. */
export interface TownhallEnvelope {
  v: 1;
  kind: TownhallKind;
  /** ISO-8601, set by the server at submit time. */
  ts: string;
  /** Registered Voicescape username of the author. */
  author: string;
}

export type TownhallKind =
  | "post"
  | "chat"
  | "rep-vote"
  | "proposal"
  | "proposal-vote"
  | "event"
  | "listing"
  | "mod-action";

/** Forum post. Lives on the forum topic; boards/walls are fields. */
export interface PostMessage extends TownhallEnvelope {
  kind: "post";
  board: string;
  /** Null for board posts; a username for wall posts. */
  wall: string | null;
  body: string;
  /** HCS sequence number of the post being replied to, or null. */
  replyTo: number | null;
}

/** Chat message. Lives on the chat topic. */
export interface ChatMessage extends TownhallEnvelope {
  kind: "chat";
  room: string;
  body: string;
}

/** Reputation vote. Latest per (voter, target) wins. */
export interface RepVoteMessage extends TownhallEnvelope {
  kind: "rep-vote";
  target: string;
  voter: string;
  value: 1 | -1;
}

/** Poll proposal. Advisory only — no execution path. */
export interface ProposalMessage extends TownhallEnvelope {
  kind: "proposal";
  id: string;
  title: string;
  body: string;
  /** ISO-8601. */
  closesAt: string;
}

/** Vote on a proposal. Latest per (voter, proposal) wins. */
export interface ProposalVoteMessage extends TownhallEnvelope {
  kind: "proposal-vote";
  proposal: string;
  voter: string;
  choice: "yes" | "no" | "abstain";
}

/** Town-hall event. Lives on the polls topic. Room is "event-<id>". */
export interface EventMessage extends TownhallEnvelope {
  kind: "event";
  id: string;
  title: string;
  description: string;
  /** ISO-8601. */
  startsAt: string;
  room: string;
}

/** Marketplace listing. Latest per id wins (status updates are new listings). */
export interface ListingMessage extends TownhallEnvelope {
  kind: "listing";
  id: string;
  /** Payout address for direct sales (0x… or 0.0.x). */
  seller: string;
  /** Page username of the seller — the identity the server auth-checks. */
  sellerUsername: string | null;
  title: string;
  description: string;
  priceUsdCents: number;
  goodsType: "physical" | "digital";
  ipfsHash: string | null;
  status: "active" | "sold" | "cancelled";
}

/** Moderation action. Server-side filtering; HCS stays append-only. */
export interface ModActionMessage extends TownhallEnvelope {
  kind: "mod-action";
  /**
   * What the hide targets: a forum post or a chat message. Optional for
   * back-compat — pre-existing mod-actions have no targetKind and are
   * treated as "post".
   */
  targetKind?: "post" | "chat";
  /** Scope of the hide. null = global scope for this target. */
  board: string | null;
  /** For chat targets, `board` carries the room name and `wall` is null. */
  wall: string | null;
  /** HCS sequence number of the hidden post/chat message. */
  targetSeq: number;
  action: "hide";
  /**
   * Canonical wallet address of the acting moderator, set when the hide was
   * authorized via TOWNHALL_MOD_WALLETS while acting under a registered
   * username. Lets the session-less read path honor the hide.
   */
  modWallet?: string | null;
}

export type TownhallMessage =
  | PostMessage
  | ChatMessage
  | RepVoteMessage
  | ProposalMessage
  | ProposalVoteMessage
  | EventMessage
  | ListingMessage
  | ModActionMessage;

/** Stored HCS message: decoded payload + consensus metadata. */
export interface StoredMessage<T = TownhallMessage> {
  /** HCS consensus sequence number (ordering). */
  seq: number;
  /** HCS topic id the message was read from. */
  topic: string;
  /** Consensus timestamp (ISO-8601). */
  consensusTimestamp: string;
  contents: T;
}

/* ------------------------------------------------------------------ */
/* REST payloads (see frontend/TOWNHALL_API.md)                        */
/* ------------------------------------------------------------------ */

export interface BoardInfo {
  id: string;
  title: string;
  description: string;
}

export interface PostView {
  seq: number;
  board: string;
  wall: string | null;
  author: string;
  body: string;
  replyTo: number | null;
  ts: string;
}

export interface ReputationView {
  target: string;
  up: number;
  down: number;
  score: number;
  /** The requesting voter's current vote, or null. */
  myVote: 1 | -1 | null;
}

export interface ProposalView {
  id: string;
  author: string;
  title: string;
  body: string;
  closesAt: string;
  yes: number;
  no: number;
  abstain: number;
}

export interface ChatEvent {
  seq: number;
  room: string;
  author: string;
  body: string;
  ts: string;
}

export interface EventView {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  room: string;
}

export interface ListingView {
  id: string;
  seller: string;
  sellerUsername: string | null;
  title: string;
  description: string;
  priceUsdCents: number;
  goodsType: "physical" | "digital";
  ipfsHash: string | null;
  status: "active" | "sold" | "cancelled";
  ts: string;
}
