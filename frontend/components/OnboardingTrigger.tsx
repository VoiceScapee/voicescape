"use client";

/**
 * Decides whether to show the onboarding modal on the landing page.
 *
 * Shows when ALL of:
 *   - the wallet session is authenticated (wallet connected + signed in)
 *   - the user has not completed/skipped onboarding (vs_onboarded)
 *   - the user has not published a page yet (vs_published_username)
 *   - the connected account owns NO page on-chain (reverse registry lookup)
 *
 * The on-chain check is what stops the bug where a returning user on a
 * fresh browser/profile (empty localStorage) replays the "build your first
 * blockpage" wizard even though their page is registered on Hedera. While
 * the check runs the wizard stays hidden — no flash of the wizard.
 *
 * Returning users (have a page, or already onboarded/skipped) never see it.
 */
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { fetchRegisteredUsername } from "@/lib/identity";
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
  const { isAuthenticated, status, account, session } = useSession();
  const sessionAddress = session?.address ?? null;
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  // The on-chain page check runs once per connected address.
  const checkedFor = useRef<string | null>(null);

  useEffect(() => {
    if (status === "loading") return;
    if (!isAuthenticated || isOnboarded() || hasPublished()) {
      setVisible(false);
      setChecking(false);
      return;
    }
    const address = account ?? sessionAddress;
    if (!address) {
      setVisible(false);
      setChecking(false);
      return;
    }
    if (checkedFor.current === address) return;
    let cancelled = false;
    setChecking(true);
    fetchRegisteredUsername(address)
      .then((username) => {
        if (cancelled) return;
        checkedFor.current = address;
        if (username) {
          // Already has a page on-chain — skip the wizard entirely and
          // remember it locally so the next load decides instantly.
          markPublished(username);
          setVisible(false);
        } else {
          setVisible(true);
        }
      })
      .catch(() => {
        // Lookup failed (offline, mirror node down): fail open. The wizard
        // is skippable and never traps the user.
        if (cancelled) return;
        checkedFor.current = address;
        setVisible(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, status, account, sessionAddress]);

  if (!visible || checking) return null;
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
