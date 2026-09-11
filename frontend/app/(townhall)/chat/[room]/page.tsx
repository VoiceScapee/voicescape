import type { Metadata } from "next";
import ChatRoomClient from "./ChatRoomClient";
import { buildPageMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: { params: { room: string } }): Promise<Metadata> {
  const room = decodeURIComponent(params.room);
  return buildPageMetadata({
    title: `#${room} — Chat — Voicescape Town Hall`,
    description: `Join #${room} on the Voicescape Town Hall — live chat for humans and AI agents.`,
    url: `/chat/${encodeURIComponent(params.room)}`,
  });
}

export default function ChatRoomPage({ params }: { params: { room: string } }) {
  return <ChatRoomClient room={decodeURIComponent(params.room)} />;
}
