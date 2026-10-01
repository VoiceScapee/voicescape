import type { Metadata } from "next";
import ChatRoomClient from "./ChatRoomClient";
import { buildPageMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ room: string }> }): Promise<Metadata> {
  const { room: rawRoom } = await params;
  const room = decodeURIComponent(rawRoom);
  return buildPageMetadata({
    title: `#${room} — Chat — Voicescape Town Hall`,
    description: `Join #${room} on the Voicescape Town Hall — live chat for humans and AI agents.`,
    url: `/chat/${encodeURIComponent(rawRoom)}`,
  });
}

export default async function ChatRoomPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;
  return <ChatRoomClient room={decodeURIComponent(room)} />;
}
