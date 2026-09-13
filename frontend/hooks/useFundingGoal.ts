"use client";

/**
 * useFundingGoal — shared funding-goal state for a blockpage.
 *
 * Fetches the owner's public funding goal (/api/goals) and the all-time
 * on-chain tipped total (/api/earnings), and derives the campaign progress
 * (all-time minus the goal's baseline snapshot) and whether the goal is
 * reached. Used by <GoalBar> (public progress section) and by the page
 * itself to pause the tip flow when the fundraiser limit is hit.
 *
 * Goals move no funds — tipping stays direct wallet-to-wallet on-chain.
 * The pause is enforced in the app UI; the Tips contract itself has no
 * concept of goals, so a tip sent directly to the contract would still
 * land. Copy must never claim on-chain enforcement.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// Funding-goal live updates:
// - polls every 30s while a goal is active and unreached
// - refetches immediately when a tip is confirmed on this page
//   (the page dispatches `voicescape:tip-confirmed` on mirror-node verdict)
export const TIP_CONFIRMED_EVENT = "voicescape:tip-confirmed";
const POLL_MS = 30_000;

export interface FundingGoalInfo {
  username: string;
  targetHbar: number;
  title: string | null;
  /** All-time proceeds snapshot at campaign start; progress = all-time − baseline. */
  baselineHbar: number;
}

export interface FundingGoalState {
  goal: FundingGoalInfo | null;
  /** Campaign progress in HBAR (all-time tipped total minus the baseline), null until loaded. */
  raised: number | null;
  /** True once the campaign's raised total meets the target. */
  reached: boolean;
  loading: boolean;
}

/**
 * Pure fundraiser-limit check: donations pause once the campaign's raised
 * total meets the goal target. Kept pure so the boundary logic is
 * unit-testable without a DOM.
 */
export function isFundingGoalReached(
  goal: { targetHbar: number } | null,
  raised: number | null,
): boolean {
  return goal !== null && raised !== null && goal.targetHbar > 0 && raised >= goal.targetHbar;
}

export function useFundingGoal(
  username: string | null,
  ownerAddress: string | null,
): FundingGoalState {
  const [goal, setGoal] = useState<FundingGoalInfo | null>(null);
  const [raised, setRaised] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!username) {
      if (mountedRef.current) setLoading(false);
      return;
    }
    try {
      const gRes = await fetch(`/api/goals?username=${encodeURIComponent(username)}`, {
        cache: "no-store",
      });
      const gJson = (await gRes.json()) as { goal?: FundingGoalInfo | null };
      const g = gJson.goal ?? null;
      if (!mountedRef.current) return;
      setGoal(g);
      if (g && ownerAddress) {
        try {
          const eRes = await fetch(`/api/earnings?address=${encodeURIComponent(ownerAddress)}`);
          const eJson = (await eRes.json()) as { hbarAllTime?: string };
          if (!mountedRef.current) return;
          const n = Number(eJson.hbarAllTime);
          // Campaign progress: the slice of the all-time total raised since
          // this campaign started. Never negative.
          const baseline = typeof g.baselineHbar === "number" && Number.isFinite(g.baselineHbar) ? g.baselineHbar : 0;
          setRaised(Number.isFinite(n) ? Math.max(0, n - baseline) : 0);
        } catch {
          if (mountedRef.current) setRaised(0);
        }
      } else if (!g) {
        setRaised(null);
      }
    } catch {
      if (mountedRef.current) {
        setGoal(null);
        setRaised(null);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [username, ownerAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refetch the moment a tip confirms on this page.
  useEffect(() => {
    const onTip = () => {
      void refresh();
    };
    window.addEventListener(TIP_CONFIRMED_EVENT, onTip);
    return () => window.removeEventListener(TIP_CONFIRMED_EVENT, onTip);
  }, [refresh]);

  // Poll while a goal is live and unreached so the bar moves without refresh.
  const reached = isFundingGoalReached(goal, raised);
  useEffect(() => {
    if (!goal || reached) return;
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [goal, reached, refresh]);

  return { goal, raised, reached, loading };
}
