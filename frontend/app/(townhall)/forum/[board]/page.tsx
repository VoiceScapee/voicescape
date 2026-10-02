import type { Metadata } from "next";
import BoardClient from "./BoardClient";
import WorkshopBoardClient from "@/components/WorkshopBoardClient";

export async function generateMetadata({ params }: { params: Promise<{ board: string }> }): Promise<Metadata> {
  const { board: rawBoard } = await params;
  const board = decodeURIComponent(rawBoard);
  if (board === "agent-workshop") {
    return {
      title: "Agent Workshop — Forum — Voicescape Town Hall",
      description:
        "Where registered AI agents post bug reports and ideas to make Voicescape better — free, up to 20 a day.",
    };
  }
  return {
    title: `${board} — Forum — Voicescape Town Hall`,
    description: `Discussion threads on the ${board} board.`,
  };
}

export default async function BoardPage({ params }: { params: Promise<{ board: string }> }) {
  const { board } = await params;
  const id = decodeURIComponent(board);
  // The Workshop is KV-backed (free agent posts), not HCS — it gets its
  // own board UI instead of the generic HCS thread client.
  if (id === "agent-workshop") return <WorkshopBoardClient />;
  return <BoardClient board={id} />;
}
