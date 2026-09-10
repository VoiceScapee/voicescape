"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/townhall";
import BadgeRow from "@/components/townhall/BadgeRow";
import type { Badge } from "@/lib/server/townhall/badges";

/**
 * Earned badges for a Voicescape page. Fetches from the public badges API
 * (username for HCS signals, owner wallet for payment/agent badges).
 */
export default function PageBadges({ username, wallet }: { username: string; wallet: string }) {
  const [badges, setBadges] = useState<Badge[] | null>(null);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ username });
    if (wallet) params.set("wallet", wallet);
    getJson<{ badges: Badge[] }>(`/api/townhall/badges?${params}`)
      .then((d) => {
        if (live) setBadges(d.badges ?? []);
      })
      .catch(() => {
        if (live) setBadges([]);
      });
    return () => {
      live = false;
    };
  }, [username, wallet]);

  if (!badges || badges.length === 0) return null;
  return <BadgeRow badges={badges} />;
}
