import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  subscribeToasts,
  pushToast,
  dismissToast,
  clearToasts,
  type Toast,
} from "./toasts";

describe("toasts", () => {
  let seen: Toast[][];
  let unsub: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
    seen = [];
    unsub = subscribeToasts((t) => seen.push(t));
  });

  afterEach(() => {
    unsub();
    vi.useRealTimers();
    clearToasts();
  });

  it("pushes a toast and notifies subscribers", () => {
    const id = pushToast({ kind: "success", title: "Tip confirmed" });
    const latest = seen[seen.length - 1];
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(id);
    expect(latest[0].title).toBe("Tip confirmed");
    expect(latest[0].kind).toBe("success");
  });

  it("auto-dismisses after the default duration", () => {
    pushToast({ kind: "info", title: "Tip submitted" });
    expect(seen[seen.length - 1]).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    expect(seen[seen.length - 1]).toHaveLength(0);
  });

  it("keeps error toasts longer by default", () => {
    pushToast({ kind: "error", title: "Tip failed" });
    vi.advanceTimersByTime(6000);
    expect(seen[seen.length - 1]).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(seen[seen.length - 1]).toHaveLength(0);
  });

  it("dismisses manually", () => {
    const id = pushToast({ kind: "pending", title: "Confirming…" });
    dismissToast(id);
    expect(seen[seen.length - 1]).toHaveLength(0);
    // Advancing past the (cleared) timer must not resurrect it.
    vi.advanceTimersByTime(10_000);
    expect(seen[seen.length - 1]).toHaveLength(0);
  });

  it("caps the stack at four toasts", () => {
    for (let i = 0; i < 6; i++) {
      pushToast({ kind: "info", title: `toast ${i}` });
    }
    const latest = seen[seen.length - 1];
    expect(latest).toHaveLength(4);
    expect(latest[3].title).toBe("toast 5");
  });
});
