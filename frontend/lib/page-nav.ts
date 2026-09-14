import type { Block } from "./schema";

/**
 * Section jump-nav for rendered blockpages (mockup M2).
 *
 * Auto-generates anchor entries from blocks that carry a display title.
 * The renderer only shows the nav when there are 3+ sections, so short
 * pages stay clean. IDs are positional (pv-section-{blockIndex}) and
 * stable for a given page JSON.
 */
export interface JumpNavItem {
  id: string;
  label: string;
}

export function getJumpNavItems(blocks: Block[]): JumpNavItem[] {
  const items: JumpNavItem[] = [];
  blocks.forEach((b, i) => {
    let label: string | null = null;
    switch (b.type) {
      case "music":
        label = b.title || "Music";
        break;
      case "top8":
        label = b.title || "Top 8";
        break;
      case "guestbook":
        label = "Guestbook";
        break;
      case "services":
        label = "Services";
        break;
      case "reviews":
        label = b.title || "Reviews";
        break;
      case "booking":
        label = b.title || "Booking";
        break;
      case "links":
        label = "Links";
        break;
      case "tipJar":
        label = "Support";
        break;
      default:
        label = null;
    }
    if (label) items.push({ id: `pv-section-${i}`, label });
  });
  return items;
}

/**
 * Copy-to-clipboard link rows (mockup M1/M2 "on-chain proof" rows).
 *
 * A links item whose url starts with "copy:" renders as a copy button
 * instead of an external link — the text after the prefix is what lands
 * on the clipboard (e.g. "copy:0.0.10854058" copies the contract ID).
 * Returns the copyable text, or null for normal links.
 */
export function parseCopyLink(url: unknown): string | null {
  if (typeof url !== "string") return null;
  if (!url.startsWith("copy:")) return null;
  const text = url.slice("copy:".length).trim();
  return text ? text : null;
}

/**
 * Truncate a copy value for display in the row (the full text is copied).
 */
export function truncCopyValue(text: string, max = 18): string {
  if (text.length <= max) return text;
  return `${text.slice(0, 10)}…${text.slice(-6)}`;
}
