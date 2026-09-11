"use client";

/**
 * Decides whether to show the onboarding modal on the landing page.
 *
 * Shows when ALL of:
 *   - the wallet session is authenticated (wallet connected + signed in)
 *   - the user has not completed/skipped onboarding (vs_onboarded)
 *   - the user has not published a page yet (vs_published_username)
 *
 * Returning users (have a page, or already onboarded/skipped) never see it.
 */
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { Onboarding, isOnboarded } from "@/components/Onboarding";

const PUBLISHED_KEY = "vs_published_username";

function hasPublished(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!localStorage.getItem(PUBLISHED_KEY);
  } catch {
    return false;
  }
}

export function OnboardingTrigger() {
  const { isAuthenticated, status } = useSession();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status === "loading") return;
    if (isAuthenticated && !isOnboarded() && !hasPublished()) {
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [isAuthenticated, status]);

  if (!visible) return null;
  return <Onboarding onDone={() => setVisible(false)} />;
}

/** Called by the builder after a successful publish. */
export function markPublished(username: string): void {
  try {
    localStorage.setItem(PUBLISHED_KEY, username.toLowerCase());
    localStorage.setItem("vs_onboarded", "true");
  } catch {
    /* storage unavailable — best effort */
  }
}
