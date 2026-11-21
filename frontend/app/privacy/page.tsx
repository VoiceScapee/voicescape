import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import LegalDocPage from "@/components/LegalDoc";
import { PRIVACY_POLICY } from "@/lib/legal/legal";

export const metadata: Metadata = buildPageMetadata({
  title: "Privacy Policy — Voicescape",
  description:
    "Voicescape Privacy Policy: privacy by design, what we collect, what we never collect, and your rights.",
  url: "/privacy",
});

export default function PrivacyPage() {
  return <LegalDocPage doc={PRIVACY_POLICY} />;
}
