/**
 * PreviewErrorBoundary — last-resort crash containment for the Buddy
 * in-chat page preview.
 *
 * Model-generated mocks are untrusted input: even with server-side
 * normalization, a render throw inside BuddyDraftPreview must never
 * unmount the whole chat (live failure 2026-09-16: "Application error: a
 * client-side exception has occurred" killed the entire page). The
 * boundary catches the throw and renders a graceful retry prompt instead.
 */
"use client";

import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

export default class PreviewErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div
          data-testid="preview-error-fallback"
          style={{
            padding: "14px 12px",
            borderRadius: 10,
            border: "1px solid rgba(255, 255, 255, 0.14)",
            background: "rgba(255, 255, 255, 0.04)",
            fontSize: 13,
            color: "rgba(232, 234, 240, 0.85)",
          }}
        >
          🎨 That preview didn&apos;t load cleanly — describe what
          you&apos;d like and I&apos;ll sketch it again.
        </div>
      );
    }
    return this.props.children;
  }
}
