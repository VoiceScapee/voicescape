import type { Metadata } from "next";
import ChatRoomsClient from "./ChatRoomsClient";

export const metadata: Metadata = {
  title: "Chat — Voicescape Town Hall",
  description: "Live town-hall chat rooms.",
};

export default function ChatPage() {
  return <ChatRoomsClient />;
}
