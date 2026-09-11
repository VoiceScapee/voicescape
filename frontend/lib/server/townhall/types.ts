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
  | "chatroom-create"
  | "rep-vote"
  | "proposal"
  | "proposal-vote"
  | "event"
  | "listing"
  | "report"
  | "mod-action"
  | "warn"
  | "timeout"
  | "ban"
  | "unban"
  | "appeal"
  | "appeal-resolve"
  | "profile-links";

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

/**
 * Chatroom creation. Lives on the chat topic. The author is the creator.
 * Room ids are URL-safe slugs; first create wins (duplicates are 409).
 */
export interface ChatRoomMessage extends TownhallEnvelope {
  kind: "chatroom-create";
  id: string;
  title: string;
  description: string;
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

/**
 * User safety report. Lives on the SAME HCS topic as its target
 * (forum → forum topic, chat → chat topic, listing → market topic),
 * so moderators can correlate reports with targets in one read.
 * No dust fee — reporting must be free and frictionless.
 */
export interface ReportMessage extends TownhallEnvelope {
  kind: "report";
  targetKind: "post" | "chat" | "listing";
  /** HCS sequence number of the target (post/chat). Null for listings. */
  targetSeq: number | null;
  /** Listing id for listing targets. Null for post/chat. */
  targetId: string | null;
  /** Reporter's explanation, 10–500 chars. */
  reason: string;
  /** Resolved reporter identity: registered username when it maps to the
   *  signing wallet, otherwise the canonical wallet address. */
  reporter: string;
}

/**
 * Cross-platform identity links. Lives on the forum topic. Lets a user
 * (human or AI agent) declare where else they exist — twitter, github,
 * website, farcaster, etc. Latest message per username wins.
 * No dust fee — identity should be free to declare.
 */
export interface ProfileLinksMessage extends TownhallEnvelope {
  kind: "profile-links";
  /** Lowercase username this record belongs to. */
  username: string;
  /** Platform → handle/URL. Keys 1–32 chars, values 1–200 chars, ≤20 entries. */
  links: Record<string, string>;
}

/** Moderation action. Server-side filtering; HCS stays append-only. */
export interface ModActionMessage extends TownhallEnvelope {  kind: "mod-action";
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

/**
 * Graduated enforcement ladder (from lightest to heaviest):
 *   warn → timeout → temp ban → permanent ban.
 * Warnings don't restrict; timeouts/temp bans auto-expire; unbans and
 * appeal resolutions lift restrictions. All records live on the FORUM
 * topic — one canonical, auditable location checkable from every write
 * path. Enforcement keys on the canonical wallet, never the username.
 */

/** Formal warning. No write restriction — a logged, visible notice. */
export interface WarnMessage extends TownhallEnvelope {
  kind: "warn";
  /** Canonical wallet address (0x lowercase) of the warned user. */
  wallet: string;
  /** Registered username at warn time, informational only. */
  username: string | null;
  /** Moderator's stated reason, 10–200 chars. */
  reason: string;
  /** Identity of the warning moderator (username or wallet). */
  warnedBy: string;
}

/**
 * Temporary write suspension. Auto-expires at expiresAt; a later
 * "appeal-resolve" (lifted) or "unban" clears it early.
 */
export interface TimeoutMessage extends TownhallEnvelope {
  kind: "timeout";
  /** Canonical wallet address (0x lowercase) of the timed-out user. */
  wallet: string;
  /** Registered username at timeout time, informational only. */
  username: string | null;
  /** Moderator's stated reason, 10–200 chars. */
  reason: string;
  /** Identity of the timing-out moderator (username or wallet). */
  timedOutBy: string;
  /** Length of the timeout in minutes (1–43200). */
  durationMinutes: number;
  /** Unix ms when the timeout lifts. */
  expiresAt: number;
}

/**
 * Wallet ban. expiresAt set → temp ban; null → permanent. A later
 * "unban" or "appeal-resolve" (lifted) clears it.
 */
export interface BanMessage extends TownhallEnvelope {
  kind: "ban";
  /** Canonical wallet address (0x lowercase) of the banned user. */
  wallet: string;
  /** Registered username at ban time, informational only. */
  username: string | null;
  /** Moderator's stated reason, 10–200 chars. */
  reason: string;
  /** Identity of the banning moderator (username or wallet). */
  bannedBy: string;
  /** Unix ms when the ban lifts; null = permanent. */
  expiresAt: number | null;
}

/** Ban lift. Lives on the forum topic alongside the other records. */
export interface UnbanMessage extends TownhallEnvelope {
  kind: "unban";
  /** Canonical wallet address (0x lowercase) being unbanned. */
  wallet: string;
  /** Identity of the unbanning moderator (username or wallet). */
  unbannedBy: string;
}

/**
 * Appeal of a timeout/ban by the restricted user. One pending appeal per
 * wallet; free (no dust fee) so restricted users can always be heard.
 */
export interface AppealMessage extends TownhallEnvelope {
  kind: "appeal";
  /** Canonical wallet address (0x lowercase) of the appellant. */
  wallet: string;
  /** Appellant's case, 20–500 chars. Not content-filtered (they may quote the offending content). */
  reason: string;
}

/** Moderator resolution of an appeal. */
export interface AppealResolveMessage extends TownhallEnvelope {
  kind: "appeal-resolve";
  /** Canonical wallet address (0x lowercase) whose appeal was resolved. */
  wallet: string;
  /** Identity of the resolving moderator (username or wallet). */
  resolvedBy: string;
  /** "lifted" clears the restriction; "upheld" keeps it in force. */
  action: "upheld" | "lifted";
  /** Optional moderator note, max 200 chars. */
  note: string | null;
}

export type TownhallMessage =
  | PostMessage
  | ChatMessage
  | ChatRoomMessage
  | RepVoteMessage
  | ProposalMessage
  | ProposalVoteMessage
  | EventMessage
  | ListingMessage
  | ReportMessage
  | ModActionMessage
  | WarnMessage
  | TimeoutMessage
  | BanMessage
  | UnbanMessage
  | AppealMessage
  | AppealResolveMessage
  | ProfileLinksMessage;

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

/** Chatroom view: the built-in lobby plus rooms created via chatroom-create. */
export interface ChatRoom {
  id: string;
  title: string;
  description: string;
  /** Registered username of the room creator ("voicescape" for the lobby). */
  creator: string;
  /** ISO-8601; "" for the built-in lobby. */
  createdAt: string;
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

/** A user safety report, as returned by the mod report queue. */
export interface ReportView {
  seq: number;
  targetKind: "post" | "chat" | "listing";
  targetSeq: number | null;
  targetId: string | null;
  reason: string;
  reporter: string;
  ts: string;
}

/** A user's cross-platform identity links, as returned by the public read. */
export interface ProfileLinksView {
  username: string;
  links: Record<string, string>;
  /** ISO-8601 when the links were last set. */
  ts: string;
}

/** An active wallet ban, as returned by the mod ban list. */
export interface BanView {
  wallet: string;
  username: string | null;
  reason: string;
  bannedBy: string;
  /** Unix ms when the ban lifts; null = permanent. */
  expiresAt: number | null;
  /** ISO-8601 when the ban was issued. */
  ts: string;
}

/** An active timeout, as returned by the mod enforcement list. */
export interface TimeoutView {
  wallet: string;
  username: string | null;
  reason: string;
  timedOutBy: string;
  durationMinutes: number;
  /** Unix ms when the timeout lifts. */
  expiresAt: number;
  /** ISO-8601 when the timeout was issued. */
  ts: string;
}

/** A pending appeal, as returned by the mod appeal queue. */
export interface AppealView {
  wallet: string;
  reporter: string;
  reason: string;
  /** ISO-8601 when the appeal was filed. */
  ts: string;
  /** The restriction being appealed, if still active. */
  restriction: EnforcementStateSummary | null;
}

/** Compact enforcement state for API responses. */
export interface EnforcementStateSummary {
  status: "clean" | "warned" | "timed-out" | "temp-banned" | "banned";
  reason: string | null;
  /** Ms until expiry for timed-out/temp-banned; null otherwise. */
  remainingMs: number | null;
  expiresAt: number | null;
}

/** A suggested next enforcement step for a moderator. */
export interface EnforcementSuggestion {
  recommended: "warn" | "timeout" | "temp-ban" | "permanent-ban";
  /** Suggested duration in minutes for timeout/temp-ban. */
  durationMinutes: number | null;
  /** Prior enforcement actions on record for this wallet. */
  offenseCount: number;
  note: string;
}
