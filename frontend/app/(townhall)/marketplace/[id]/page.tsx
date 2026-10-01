import type { Metadata } from "next";
import ListingDetailClient from "./ListingDetailClient";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await params;
  return {
    title: `Listing — Marketplace — Voicescape Town Hall`,
    description: "Listing detail with a direct atomic purchase.",
  };
}

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingDetailClient id={decodeURIComponent(id)} />;
}
