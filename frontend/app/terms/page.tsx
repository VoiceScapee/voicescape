import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import LegalDocPage from "@/components/LegalDoc";
import { TERMS_OF_SERVICE } from "@/lib/legal/legal";

export const metadata: Metadata = buildPageMetadata({
  title: "Terms of Service — Voicescape",
  description:
    "Voicescape Terms of Service: non-custodial by design, 2% treasury fee, tips, fundraisers, marketplace rules, and dispute resolution.",
  url: "/terms",
});

export default function TermsPage() {
  return <LegalDocPage doc={TERMS_OF_SERVICE} />;
}
