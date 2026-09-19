import type { Metadata } from "next";
import DmcaForms from "@/components/DmcaForms";
import { getDmcaAgentContact } from "@/lib/server/dmca/notices";

export const metadata: Metadata = {
  title: "Copyright — Voicescape",
  description:
    "File a copyright takedown notice or counter-notice with Voicescape's designated copyright agent.",
};

export default function DmcaPage() {
  return <DmcaForms agentContact={getDmcaAgentContact()} />;
}
