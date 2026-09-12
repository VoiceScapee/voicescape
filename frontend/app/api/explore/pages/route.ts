import { NextResponse } from "next/server";

/**
 * GET /api/explore/pages
 * KISS: Returns a list of discoverable blockpages.
 * v1: Featured pages (seeded) + search resolves any username via /api/resolve.
 * Future: Enumerate from registry PageRegistered events via mirror node.
 */
const FEATURED_PAGES = [
  {
    username: "user-10424063",
    displayName: "Voicescape Founder",
    description: "Founder's blockpage — the first on Voicescape.",
    featured: true,
  },
];

export async function GET() {
  // v1: Return featured pages. The frontend search handles arbitrary usernames
  // via the existing /api/resolve/[username] endpoint.
  return NextResponse.json({
    pages: FEATURED_PAGES,
    count: FEATURED_PAGES.length,
  });
}
