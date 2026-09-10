import type { Metadata } from "next";
import ForumClient from "./ForumClient";

export const metadata: Metadata = {
  title: "Forum — Voicescape Town Hall",
  description: "Community discussion boards for the Voicescape town hall.",
};

export default function ForumPage() {
  return <ForumClient />;
}
