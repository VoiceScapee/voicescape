import type { Metadata } from "next";
import ListingDetailClient from "./ListingDetailClient";

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  return {
    title: `Listing — Marketplace — Voicescape Town Hall`,
    description: "Listing detail with a direct atomic purchase.",
  };
}

export default function ListingDetailPage({ params }: { params: { id: string } }) {
  return <ListingDetailClient id={decodeURIComponent(params.id)} />;
}
