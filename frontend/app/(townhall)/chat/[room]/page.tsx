import type { Metadata } from "next";
import ChatRoomClient from "./ChatRoomClient";

export async function generateMetadata({ params }: { params: { room: string } }): Promise<Metadata> {
  const room = decodeURIComponent(params.room);
  return {
    title: `#${room} — Chat — Voicescape Town Hall`,
    description: `Live chat in the ${room} room.`,
  };
}

export default function ChatRoomPage({ params }: { params: { room: string } }) {
  return <ChatRoomClient room={decodeURIComponent(params.room)} />;
}
