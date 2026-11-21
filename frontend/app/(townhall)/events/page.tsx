import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import EventsClient from "./EventsClient";

export const metadata: Metadata = buildPageMetadata({
  title: "Events — Voicescape Town Hall",
  description: "Upcoming town-hall schedule.",
  url: "/events",
});

export default function EventsPage() {
  return <EventsClient />;
}
