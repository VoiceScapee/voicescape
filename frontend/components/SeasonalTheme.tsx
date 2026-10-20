"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { seasonForPath, seasonPageForPath } from "@/lib/season";

/**
 * Writes the active season onto <html> as data attributes so the seasonal
 * stylesheet can scope itself. Runs on every route change. Renders nothing.
 *
 * Only pages in the SEASON_ROLLOUT list (lib/season.ts) get the seasonal
 * skin — everything else gets data-season="none" (default theme), so the
 * rollout stays line-by-line. Sovereign routes (blockpages, claim links,
 * embeds — and the Amazon demo page, always) map to
 * data-season-page="sovereign" and never re-skin; blockpage content itself
 * is additionally guarded by [data-sovereign] in the CSS.
 */
export default function SeasonalTheme() {
  const pathname = usePathname();
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.season = seasonForPath(pathname ?? "/");
    el.dataset.seasonPage = seasonPageForPath(pathname ?? "/");
  }, [pathname]);
  return null;
}
