import { describe, expect, it } from "vitest";
import { parseRssItems } from "./rss";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Hedera Blog</title>
<item>
<title><![CDATA[How to unlock the full potential of HCS]]></title>
<link>https://hedera.com/blog/hcs-article/</link>
<pubDate>Tue, 08 Sep 2026 11:00:00 +0000</pubDate>
</item>
<item>
<title>Council grows partner network</title>
<link>https://hedera.com/blog/partners/</link>
<pubDate>Fri, 04 Sep 2026 12:50:00 +0000</pubDate>
</item>
<item>
<title>No date item</title>
<link>https://hedera.com/blog/nodate/</link>
</item>
</channel>
</rss>`;

describe("parseRssItems", () => {
  it("parses titles (incl. CDATA), links and dates", () => {
    const items = parseRssItems(FEED, "Hedera Blog");
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe("How to unlock the full potential of HCS");
    expect(items[0].url).toBe("https://hedera.com/blog/hcs-article/");
    expect(items[0].date).toBe("2026-09-08T11:00:00.000Z");
    expect(items[0].source).toBe("Hedera Blog");
  });

  it("sorts newest first, undated items last", () => {
    const items = parseRssItems(FEED, "Hedera Blog");
    expect(items[0].date.startsWith("2026-09-08")).toBe(true);
    expect(items[1].date.startsWith("2026-09-04")).toBe(true);
    expect(items[2].date).toBe("");
  });

  it("respects the max cap", () => {
    expect(parseRssItems(FEED, "Hedera Blog", 2)).toHaveLength(2);
  });

  it("never throws on garbage", () => {
    expect(parseRssItems("not xml at all", "X")).toEqual([]);
    expect(parseRssItems("", "X")).toEqual([]);
  });

  it("decodes common entities", () => {
    const xml = `<rss><channel><item><title>A &amp; B &#8212; C</title><link>https://x.test/</link></item></channel></rss>`;
    const items = parseRssItems(xml, "X");
    expect(items[0].title).toBe("A & B — C");
  });

  it("parses Atom entries (YouTube-style) with thumbnails as video", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns:media="http://search.yahoo.com/mrss/">
<entry>
<title>AI Meets DLT: Hedera Forum</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=PNf8TKXqXwU"/>
<published>2026-09-10T14:00:00+00:00</published>
<media:thumbnail url="https://i1.ytimg.com/vi/PNf8TKXqXwU/hqdefault.jpg"/>
</entry>
</feed>`;
    const items = parseRssItems(xml, "Hedera YouTube");
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("video");
    expect(items[0].url).toBe("https://www.youtube.com/watch?v=PNf8TKXqXwU");
    expect(items[0].thumb).toBe("https://i1.ytimg.com/vi/PNf8TKXqXwU/hqdefault.jpg");
    expect(items[0].date).toBe("2026-09-10T14:00:00.000Z");
  });

  it("marks plain Atom entries as articles", () => {
    const xml = `<feed><entry><title>Post</title><link href="https://x.test/p"/><updated>2026-09-01T00:00:00Z</updated></entry></feed>`;
    const items = parseRssItems(xml, "X");
    expect(items[0].kind).toBe("article");
  });
});
