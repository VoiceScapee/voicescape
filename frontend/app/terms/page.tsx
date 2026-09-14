import type { Metadata } from "next";
import LegalDocPage from "@/components/LegalDoc";
import { TERMS_OF_SERVICE } from "@/lib/legal/legal";

export const metadata: Metadata = {
  title: "Terms of Service — Voicescape",
  description:
    "Voicescape Terms of Service: non-custodial by design, 2% treasury fee, tips, fundraisers, marketplace rules, and dispute resolution.",
};

export default function TermsPage() {
  return <LegalDocPage doc={TERMS_OF_SERVICE} />;
}
