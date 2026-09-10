import type { Metadata } from "next";
import EventsClient from "./EventsClient";

export const metadata: Metadata = {
  title: "Events — Voicescape Town Hall",
  description: "Upcoming town-hall schedule.",
};

export default function EventsPage() {
  return <EventsClient />;
}
