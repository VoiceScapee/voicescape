"use client";

/**
 * Landing hero primary CTA: "Build your blockpage".
 *
 * First-timers (not yet onboarded) are routed through the 3-step wizard —
 * even without a wallet — via the `vs:force-onboarding` event consumed by
 * OnboardingTrigger on this page. The wizard ends in preview-mode builder,
 * so the wallet-less path works unchanged. Returning onboarded users go
 * straight to /builder.
 */
import { useRouter } from "next/navigation";
import { T } from "@/components/T";
import { isOnboarded } from "@/components/Onboarding";

export const FORCE_ONBOARDING_EVENT = "vs:force-onboarding";

export function BuildCtaButton() {
  const router = useRouter();

  const start = () => {
    if (isOnboarded()) {
      router.push("/builder");
    } else {
      window.dispatchEvent(new Event(FORCE_ONBOARDING_EVENT));
    }
  };

  return (
    <button
      type="button"
      onClick={start}
      className="vs-btn vs-btn-primary"
      style={{ padding: "13px 26px", fontSize: 16, cursor: "pointer" }}
    >
      <T k="landing.brandBuildCta" />
    </button>
  );
}
