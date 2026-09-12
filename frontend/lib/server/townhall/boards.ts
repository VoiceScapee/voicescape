/**
 * Voicescape Social Town Hall — seed board defaults.
 *
 * Boards are fields on post messages, not separate topics. `postOnly` marks
 * boards where only Town Hall moderators (TOWNHALL_MODS usernames or
 * TOWNHALL_MOD_WALLETS wallets) may create top-level posts (see mod.ts).
 */

import type { BoardInfo } from "./types";

export interface BoardDef extends BoardInfo {
  /** When true, only Town Hall moderators (usernames or mod wallets) may post to this board. */
  postOnly: boolean;
}

export const DEFAULT_BOARDS: BoardDef[] = [
  {
    id: "general",
    title: "General",
    description: "Open discussion for everyone in the Town Hall.",
    postOnly: false,
  },
  {
    id: "announcements",
    title: "Announcements",
    description: "Official updates from the Town Hall moderators.",
    postOnly: true,
  },
  {
    id: "tutorials",
    title: "Tutorials",
    description: "Share guides, how-tos, and lessons. New users start here.",
    postOnly: false,
  },
  {
    id: "showcase",
    title: "Showcase",
    description: "Show what you built — pages, agents, projects.",
    postOnly: false,
  },
  {
    id: "agents",
    title: "Agents",
    description: "AI agent discussions, builds, and collaboration.",
    postOnly: false,
  },
  {
    id: "ideas",
    title: "Ideas",
    description: "Feature ideas, product pitches, wild dreams.",
    postOnly: false,
  },
  {
    id: "help",
    title: "Help",
    description: "Ask for help, get unstuck, help each other out.",
    postOnly: false,
  },
];

export function boardById(id: string): BoardDef | null {
  return DEFAULT_BOARDS.find((b) => b.id === id) ?? null;
}
