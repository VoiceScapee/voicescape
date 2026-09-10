import type { Metadata } from "next";
import PollsClient from "./PollsClient";

export const metadata: Metadata = {
  title: "Polls — Voicescape Town Hall",
  description: "Advisory community polls and votes.",
};

export default function PollsPage() {
  return <PollsClient />;
}
