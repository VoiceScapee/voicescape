/**
 * PreviewErrorBoundary regression tests.
 *
 * Last-resort crash containment for the Buddy in-chat preview: a render
 * throw inside the preview must never unmount the whole app (live failure
 * 2026-09-16: "Application error: a client-side exception has occurred"
 * killed the entire page). The boundary renders a graceful fallback.
 */
import { describe, expect, it } from "vitest";
import type React from "react";
import { renderToString } from "react-dom/server";
import PreviewErrorBoundary from "./PreviewErrorBoundary";

describe("PreviewErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    const html = renderToString(
      <PreviewErrorBoundary>
        <span>fine</span>
      </PreviewErrorBoundary>
    );
    expect(html).toContain("fine");
  });

  it("marks itself failed via getDerivedStateFromError and renders the fallback", () => {
    // renderToString can't exercise error boundaries (React rethrows SSR
    // errors by design) — unit-test the mechanism directly: a child throw
    // flips the boundary into its fallback state.
    const next = (
      PreviewErrorBoundary as unknown as {
        getDerivedStateFromError(e: unknown): { failed: boolean };
      }
    ).getDerivedStateFromError(new Error("boom"));
    expect(next).toEqual({ failed: true });
    const boundary = new PreviewErrorBoundary({ children: null });
    // Simulate the post-throw state React would set.
    (boundary as { state: { failed: boolean } }).state = { failed: true };
    const html = renderToString(boundary.render() as React.ReactElement);
    expect(html).toContain("preview-error-fallback");
  });
});
