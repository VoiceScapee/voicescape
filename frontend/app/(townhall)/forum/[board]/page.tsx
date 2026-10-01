import type { Metadata } from "next";
import BoardClient from "./BoardClient";

export async function generateMetadata({ params }: { params: Promise<{ board: string }> }): Promise<Metadata> {
  const { board: rawBoard } = await params;
  const board = decodeURIComponent(rawBoard);
  return {
    title: `${board} — Forum — Voicescape Town Hall`,
    description: `Discussion threads on the ${board} board.`,
  };
}

export default async function BoardPage({ params }: { params: Promise<{ board: string }> }) {
  const { board } = await params;
  return <BoardClient board={decodeURIComponent(board)} />;
}
