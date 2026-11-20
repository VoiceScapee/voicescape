import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import DmcaForms from "@/components/DmcaForms";
import { getDmcaAgentContact } from "@/lib/server/dmca/notices";

export const metadata: Metadata = buildPageMetadata({
  title: "Copyright — Voicescape",
  description:
    "File a copyright takedown notice or counter-notice with Voicescape's designated copyright agent.",
  url: "/dmca",
});

export default function DmcaPage() {
  return <DmcaForms agentContact={getDmcaAgentContact()} />;
}
