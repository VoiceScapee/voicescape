"use client";

/**
 * First-run onboarding on the landing page.
 *
 * Everyone — brand-new or returning owner — gets the same flow: splash,
 * then the landing page, then the navbar (Brandon's call, 2026-09-13).
 * This component never redirects anywhere. Its only job: if the connected
 * wallet owns no blockpage, show the skippable first-blockpage wizard.
 * Returning owners reach their page through the navbar wallet menu.
 */
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { fetchRegisteredUsername } from "@/lib/identity";
import { Onboarding } from "@/components/Onboarding";

const PUBLISHED_KEY = "vs_published_username";

/**
 * Set by markPublished(); consumed once by the Buddy widget, which greets
 * the visitor with "🎉 Your blockpage is live!" the next time it opens.
 */
export const BUDDY_CELEBRATE_KEY = "vs_buddy_celebrate";

/** The locally-remembered published username, if any. */
function publishedUsername(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(PUBLISHED_KEY);
  } catch {
    return null;
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
    if (!isAuthenticated) {
      setVisible(false);
      setChecking(false);
      return;
    }
    if (publishedUsername()) {
      // Returning owner — nothing to do. They navigate from the navbar.
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
  return <Onboarding onDone={() => setVisible(false)} account={account ?? sessionAddress} />;
}

/** Called by the builder after a successful publish. */
export function markPublished(username: string): void {
  try {
    localStorage.setItem(PUBLISHED_KEY, username.toLowerCase());
    localStorage.setItem(BUDDY_CELEBRATE_KEY, "true");
    localStorage.setItem("vs_onboarded", "true");
  } catch {
    /* storage unavailable — best effort */
  }
}
