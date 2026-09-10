/**
 * Vibecode change-preview utilities for the builder page.
 *
 * Kept in a separate module (not page.tsx) because Next.js page modules
 * may only export the default component — extra runtime exports break
 * the generated page-type checks.
 */
import type { Block, VoicescapePage } from "@/lib/schema";

/** A pending AI-generated revision awaiting Apply / Discard. */
export interface AiDraft {
  page: VoicescapePage;
  summary: string[];
  instruction: string;
}

const shortFont = (f: string) => f.split(",")[0];

/** Narrow a same-type block pair for field-level diffing. */
type BlockOf<T extends Block["type"]> = Extract<Block, { type: T }>;
function blockPair<T extends Block["type"]>(
  x: Block,
  y: Block,
  type: T,
): [BlockOf<T>, BlockOf<T>] | null {
  return x.type === type && y.type === type ? [x as BlockOf<T>, y as BlockOf<T>] : null;
}

/**
 * Human-readable summary of what changed between two page revisions,
 * used for the AI change-preview. Returns at least one line.
 */
export function summarizeChanges(oldPage: VoicescapePage, newPage: VoicescapePage): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (out.length < 12) out.push(s);
  };

  if (oldPage.username !== newPage.username) {
    push(`Username: ${oldPage.username || "(blank)"} → ${newPage.username || "(blank)"}`);
  }
  (["background", "foreground", "accent"] as const).forEach((k) => {
    if (oldPage.theme[k] !== newPage.theme[k]) {
      push(`Theme ${k}: ${oldPage.theme[k]} → ${newPage.theme[k]}`);
    }
  });
  if (oldPage.theme.fontFamily !== newPage.theme.fontFamily) {
    push(`Font: ${shortFont(oldPage.theme.fontFamily)} → ${shortFont(newPage.theme.fontFamily)}`);
  }

  const a = oldPage.blocks;
  const b = newPage.blocks;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (!x && y) {
      push(`Added ${y.type} block`);
      continue;
    }
    if (x && !y) {
      push(`Removed ${x.type} block`);
      continue;
    }
    if (!x || !y) continue;
    if (x.type !== y.type) {
      push(`Replaced ${x.type} block with ${y.type}`);
      continue;
    }
    const heroPair = blockPair(x, y, "hero");
    const bioPair = blockPair(x, y, "bio");
    const linksPair = blockPair(x, y, "links");
    const tipJarPair = blockPair(x, y, "tipJar");
    const guestbookPair = blockPair(x, y, "guestbook");
    const musicPair = blockPair(x, y, "music");
    const galleryPair = blockPair(x, y, "gallery");
    if (heroPair) {
      const [o, n] = heroPair;
      if (o.title !== n.title) push(`Hero title → “${n.title}”`);
      else if ((o.subtitle ?? "") !== (n.subtitle ?? "")) push("Hero subtitle updated");
      else if ((o.avatarEmoji ?? "") !== (n.avatarEmoji ?? "")) push("Hero avatar updated");
      else if (JSON.stringify(o) !== JSON.stringify(n)) push("Hero block tweaked");
    } else if (bioPair) {
      const [o, n] = bioPair;
      if (o.text !== n.text) push("Bio text updated");
    } else if (linksPair) {
      const [o, n] = linksPair;
      if (o.items.length !== n.items.length) push(`Links: ${o.items.length} → ${n.items.length} items`);
      else if (JSON.stringify(o.items) !== JSON.stringify(n.items)) push("Links updated");
    } else if (tipJarPair) {
      const [o, n] = tipJarPair;
      if ((o.message ?? "") !== (n.message ?? "")) push("Tip jar message updated");
    } else if (guestbookPair) {
      const [o, n] = guestbookPair;
      if (o.entries.length !== n.entries.length) {
        push(`Guestbook: ${o.entries.length} → ${n.entries.length} entries`);
      } else if (JSON.stringify(o.entries) !== JSON.stringify(n.entries)) {
        push("Guestbook updated");
      }
    } else if (musicPair) {
      const [o, n] = musicPair;
      if ((o.title ?? "") !== (n.title ?? "") || (o.note ?? "") !== (n.note ?? "")) {
        push("Music block updated");
      }
    } else if (galleryPair) {
      const [o, n] = galleryPair;
      if (o.images.length !== n.images.length) {
        push(`Gallery: ${o.images.length} → ${n.images.length} images`);
      } else if (JSON.stringify(o.images) !== JSON.stringify(n.images)) {
        push("Gallery updated");
      }
    }
  }

  if (out.length === 0) return ["No visible changes detected"];
  if (out.length > 9) return [...out.slice(0, 9), `…and ${out.length - 9} more changes`];
  return out;
}
