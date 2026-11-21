/**
 * JSON-LD script tag for Schema.org structured data.
 *
 * The data passed in must mirror ONLY what the page already shows
 * publicly — no invented ratings, reviews, addresses, or statistics.
 * Escaping lives in lib/seo's jsonLdHtml (unit-tested in seo.test.ts).
 */
import { jsonLdHtml } from "@/lib/seo";

export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonLdHtml(data) }}
    />
  );
}
