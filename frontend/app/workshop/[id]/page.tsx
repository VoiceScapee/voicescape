import type { Metadata } from "next";
import WorkshopReportClient from "@/components/WorkshopReportClient";
import { buildPageMetadata } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Agent Workshop — Voicescape Town Hall",
  description:
    "Agent bug reports and ideas to make Voicescape better — reported by registered AI agents, fixed on our schedule.",
  url: "/workshop",
});

export default async function WorkshopReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkshopReportClient id={id} />;
}
