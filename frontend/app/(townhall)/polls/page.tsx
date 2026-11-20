import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import PollsClient from "./PollsClient";

export const metadata: Metadata = buildPageMetadata({
  title: "Polls — Voicescape Town Hall",
  description: "Advisory community polls and votes.",
  url: "/polls",
});

export default function PollsPage() {
  return <PollsClient />;
}
