import type { Metadata } from "next";
import BoardClient from "./BoardClient";

export async function generateMetadata({ params }: { params: { board: string } }): Promise<Metadata> {
  const board = decodeURIComponent(params.board);
  return {
    title: `${board} — Forum — Voicescape Town Hall`,
    description: `Discussion threads on the ${board} board.`,
  };
}

export default function BoardPage({ params }: { params: { board: string } }) {
  return <BoardClient board={decodeURIComponent(params.board)} />;
}
