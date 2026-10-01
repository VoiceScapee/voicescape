/**
 * Shared notification types for the human return loop.
 *
 * Client-safe: no Node builtins, no web-push — importable from both
 * server modules (lib/server/notify.ts) and "use client" components.
 */

/** Social notification types (the "tip" type joins them in read APIs). */
export type SocialNotifType = "reply" | "mention" | "follow" | "sale";
export type NotifType = SocialNotifType | "tip";

export interface SocialNotif {
  /** Stable unique id, e.g. "reply:forum:1234", "sale:0xabc…". */
  id: string;
  type: SocialNotifType;
  /** Epoch ms. */
  tsMs: number;
  /** Username of the actor ("someone" when unresolvable). */
  actor: string;
  title: string;
  body: string;
  /** Site-relative URL, e.g. "/forum/general". */
  url: string;
}

/** Digest/read-API item: a social notif or a tip row. */
export interface DigestItem {
  id: string;
  type: NotifType;
  tsMs: number;
  actor: string;
  title: string;
  body: string;
  url: string;
}
