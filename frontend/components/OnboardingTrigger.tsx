"use client";

/**
 * Post-connect routing + onboarding decision on the landing page.
 *
 * On first app load after the wallet connects:
 *   - wallet owns a page on-chain (or local storage says onboarded/published)
 *     → route straight to the page builder (their page loads for editing).
 *   - wallet owns NO page → show the first-blockpage wizard (unchanged).
 *
 * The redirect fires once per tab session, only after the on-chain page
 * check resolves — existing owners never see a wizard flash, and new
 * wallets still get the guided first-blockpage flow.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { fetchRegisteredUsername } from "@/lib/identity";
import { Onboarding, isOnboarded } from "@/components/Onboarding";

const PUBLISHED_KEY = "vs_published_username";
const REDIRECT_KEY = "vs_builder_redirect_done";

function hasPublished(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!localStorage.getItem(PUBLISHED_KEY);
  } catch {
    return false;
  }
}

/** Once per tab session — navigating back to the landing page must not yank. */
function redirectDone(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return sessionStorage.getItem(REDIRECT_KEY) === "1";
  } catch {
    return true; // storage unavailable — fail closed, don't redirect
  }
}

function markRedirectDone(): void {
  try {
    sessionStorage.setItem(REDIRECT_KEY, "1");
  } catch {
    /* best effort */
  }
}

export function OnboardingTrigger() {
  const { isAuthenticated, status, account, session } = useSession();
  const sessionAddress = session?.address ?? null;
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  // The on-chain page check runs once per connected address.
  const checkedFor = useRef<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    if (!isAuthenticated) {
      setVisible(false);
      setChecking(false);
      return;
    }
    const mayRedirect = !redirectDone();
    if (isOnboarded() || hasPublished()) {
      // Returning owner — straight to the builder on first load.
      setVisible(false);
      setChecking(false);
      if (mayRedirect) {
        markRedirectDone();
        router.replace("/builder");
      }
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
          // First load after connect: take them to the builder.
          markPublished(username);
          setVisible(false);
          if (mayRedirect) {
            markRedirectDone();
            router.replace("/builder");
          }
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
  }, [isAuthenticated, status, account, sessionAddress, router]);

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
