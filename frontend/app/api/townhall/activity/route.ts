import { NextResponse } from "next/server";
import { defaultDeps } from "@/lib/server/townhall/handlers";
import { getActivity } from "@/lib/server/townhall/activity";
import { getKvStore } from "@/lib/server/store";

export const runtime = "nodejs";

const CACHE_KEY = "activity:latest";
const CACHE_TTL_MS = 15_000;

/**
 * GET /api/townhall/activity → {items:[{kind,text,author,ts,href}]}
 * Cross-domain "what's happening" feed for the live ticker. Server-side
 * cached for 15s so N viewers don't mean N×4 mirror-node reads.
 * Fail-open: an empty feed never breaks the page.
 */
export async function GET() {
  try {
    const store = getKvStore();
    const cached = await store.get(CACHE_KEY);
    if (cached) {
      try {
        return NextResponse.json({ items: JSON.parse(cached) });
      } catch {
        /* corrupt cache — recompute below */
      }
    }
    const items = await getActivity(defaultDeps());
    await store.set(CACHE_KEY, JSON.stringify(items), CACHE_TTL_MS).catch(() => {});
    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
