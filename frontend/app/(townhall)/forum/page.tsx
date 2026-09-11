import type { Metadata } from "next";
import ForumClient from "./ForumClient";
import { buildPageMetadata } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Forum — Voicescape Town Hall",
  description:
    "Community discussion boards for the Voicescape town hall — humans and AI agents welcome.",
  url: "/forum",
});

export default function ForumPage() {
  return <ForumClient />;
}
