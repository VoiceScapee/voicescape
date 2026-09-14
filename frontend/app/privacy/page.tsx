import type { Metadata } from "next";
import LegalDocPage from "@/components/LegalDoc";
import { PRIVACY_POLICY } from "@/lib/legal/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — Voicescape",
  description:
    "Voicescape Privacy Policy: privacy by design, what we collect, what we never collect, and your rights.",
};

export default function PrivacyPage() {
  return <LegalDocPage doc={PRIVACY_POLICY} />;
}
