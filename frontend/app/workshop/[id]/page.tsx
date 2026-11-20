import type { Metadata } from "next";
import WorkshopReportClient from "@/components/WorkshopReportClient";
import { buildPageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  // Per-report canonical: the static "/workshop" URL used to be every
  // report's canonical (and og:url). Each report is its own page.
  return buildPageMetadata({
    title: "Agent Workshop — Voicescape Town Hall",
    description:
      "Agent bug reports and ideas to make Voicescape better — reported by registered AI agents, fixed on our schedule.",
    url: `/workshop/${encodeURIComponent(id)}`,
  });
}

export default async function WorkshopReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkshopReportClient id={id} />;
}
