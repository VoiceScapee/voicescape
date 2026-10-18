/**
 * Tiny global toast store — the ambient transaction-lifecycle layer.
 *
 * Tip flows (TipModal, the blockpage tip panel) already render detailed
 * inline states; toasts mirror the lifecycle transitions (submitted →
 * confirming → confirmed / failed) so the user never loses the thread if
 * the modal closes or they navigate away. Display only: toasts never
 * change what a transaction does.
 */

export type ToastKind = "pending" | "success" | "error" | "info";

export interface ToastInput {
  title: string;
  sub?: string;
  kind: ToastKind;
  /** When set, the toast links the transaction on the explorer. */
  txId?: string;
  explorerBase?: string;
  /** Auto-dismiss after ms. Defaults: 6000 (info/pending/success), 9000 (error). */
  durationMs?: number;
}

export interface Toast extends ToastInput {
  id: number;
  kind: ToastKind;
  durationMs: number;
}

type Listener = (toasts: Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let seq = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  const snapshot = [...toasts];
  listeners.forEach((fn) => fn(snapshot));
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  fn([...toasts]);
  return () => {
    listeners.delete(fn);
  };
}

/** Push a toast; returns its id. Auto-dismisses after durationMs. */
export function pushToast(input: ToastInput): number {
  const id = seq++;
  const toast: Toast = {
    ...input,
    id,
    durationMs:
      input.durationMs ?? (input.kind === "error" ? 9000 : 6000),
  };
  toasts = [...toasts.slice(-3), toast];
  emit();
  timers.set(
    id,
    setTimeout(() => dismissToast(id), toast.durationMs),
  );
  return id;
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (toasts.some((t) => t.id === id)) {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }
}

/** Test/dev helper: clear all toasts and timers. */
export function clearToasts() {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  toasts = [];
  emit();
}
