/**
 * Minimal RSS 2.0 / Atom item parser — no dependency, $0, KISS.
 *
 * Only what the pulse feed needs: entries → title / url / date / kind.
 * YouTube channel feeds are Atom; WordPress blogs are RSS 2.0.
 * Defensive by design: malformed XML yields fewer items, never a throw
 * (callers treat "no items" as "hide the section").
 */

export interface PulseItem {
  title: string;
  url: string;
  /** ISO-8601, "" when the feed gave no parseable date. */
  date: string;
  source: string;
  kind: "article" | "video";
  /** Video thumbnail URL (YouTube media:thumbnail), "" for articles. */
  thumb: string;
}

/** Strip <![CDATA[..]]> wrappers and decode the entities feeds actually use. */
function cleanText(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  // Titles sometimes carry stray markup — drop tags, collapse whitespace.
  s = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function firstTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? cleanText(m[1]) : "";
}

/** <link href="..."> (Atom) or <link>...</link> (RSS). */
function linkHref(block: string): string {
  const atom = block.match(/<link[^>]*href="([^"]+)"/i);
  if (atom) return atom[1];
  return firstTag(block, "link");
}

/** YouTube-style <media:thumbnail url="...">. */
function thumbUrl(block: string): string {
  const m = block.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
  return m ? m[1] : "";
}

/**
 * Parse RSS 2.0 (<item>) or Atom (<entry>) XML into items
 * (newest first by date when present). Never throws.
 */
export function parseRssItems(xml: string, source: string, max = 8): PulseItem[] {
  try {
    const isAtom = /<feed[\s>]/i.test(xml) && !/<channel[\s>]/i.test(xml);
    const blocks = isAtom
      ? (xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [])
      : (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []);
    const items: PulseItem[] = [];
    for (const block of blocks) {
      const title = firstTag(block, "title");
      const url = linkHref(block);
      if (!title || !url) continue;
      const rawDate =
        firstTag(block, "pubDate") || firstTag(block, "published") || firstTag(block, "updated");
      let date = "";
      if (rawDate) {
        const t = Date.parse(rawDate);
        if (!Number.isNaN(t)) date = new Date(t).toISOString();
      }
      const thumb = thumbUrl(block);
      const isVideo = Boolean(thumb) || /youtube\.com|youtu\.be/.test(url);
      items.push({
        title,
        url,
        date,
        source,
        kind: isVideo ? "video" : "article",
        thumb,
      });
      if (items.length >= max) break;
    }
    // Newest first; undated items sink to the bottom in feed order.
    items.sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
    return items;
  } catch {
    return [];
  }
}
