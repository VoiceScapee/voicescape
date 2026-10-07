"use client";

import { useEffect, useRef } from "react";

/**
 * Dialog accessibility: Escape closes the modal, focus moves into it on
 * open and returns to the previously focused element on close. Tab is
 * trapped inside the dialog (wraps first/last focusable), and background
 * scroll is locked while open — without these, an aria-modal dialog is a
 * broken promise to assistive tech and mobile browsers.
 *
 * Pass `active=false` for inline (non-overlay) renders where no dialog
 * semantics apply — the hook then does nothing.
 */
export function useDialogA11y(onClose: () => void, active = true) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    const focusables = (): HTMLElement[] =>
      dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => !el.hasAttribute("disabled"))
        : [];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialog) {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    // Lock background scroll while the dialog is open (on mobile the page
    // behind the sheet scrolls otherwise, and iOS URL-bar show/hide shifts
    // the fixed overlay mid-interaction). Restore the previous value on close.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [onClose, active]);
  return dialogRef;
}
