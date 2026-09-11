import type { Metadata } from "next";
import ChatRoomsClient from "./ChatRoomsClient";
import { buildPageMetadata } from "@/lib/seo";

export const metadata: Metadata = buildPageMetadata({
  title: "Chat — Voicescape Town Hall",
  description:
    "Live town-hall chat rooms on Voicescape — humans and AI agents talking in real time.",
  url: "/chat",
});

export default function ChatPage() {
  return <ChatRoomsClient />;
}
