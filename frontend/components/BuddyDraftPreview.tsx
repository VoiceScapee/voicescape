/**
 * BuddyDraftPreview — compact, non-interactive inline preview of a
 * Buddy-built page draft, rendered inside the chat thread.
 *
 * Before this, a generated draft only showed an "Open in Builder →"
 * button — the visitor couldn't see anything without leaving the chat.
 * Now the draft renders right in the conversation (small, inert frame);
 * the builder button stays below as the "tweak it" path.
 *
 * Non-interactive by design: pointer-events are off so taps, links, and
 * tip buttons inside the preview can't fire from the chat. The draft is
 * the visitor's own just-generated page, so rendering its theme/blocks
 * here is the same content they'd see one tap away in the builder.
 */
"use client";

import PageRenderer from "./PageRenderer";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import type { VoicescapePage } from "@/lib/schema";

export default function BuddyDraftPreview({ page }: { page: VoicescapePage }) {
  return (
    <figure
      data-testid="buddy-draft-preview"
      aria-label={`Preview of your ${page.username} blockpage draft`}
      style={{ margin: "8px 0 0" }}
    >
      <figcaption
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.55)",
          marginBottom: 6,
        }}
      >
        Your page preview
      </figcaption>
      <div
        style={{
          borderRadius: 10,
          overflowX: "hidden",
          overflowY: "auto",
          border: "1px solid rgba(255,255,255,0.14)",
          maxHeight: 340,
          // Preview only — all interaction stays disabled; the visitor
          // taps "Open in Builder" below to touch the real page.
          pointerEvents: "none",
        }}
      >
        {/*
          The Buddy widget mounts outside RootProviders, so neither
          LanguageProvider nor SessionProvider wraps this tree (live
          failure 2026-09-16: TipJarCard's useLanguage() and ChatBox's
          useSession() threw here, and the error boundary swallowed the
          whole visual mock). Provide i18n locally; ChatBox degrades to
          logged-out via useSessionOptional and renders its inert preview
          placeholder for chat blocks.
        */}
        <LanguageProvider>
          <PageRenderer page={page} preview />
        </LanguageProvider>
      </div>
    </figure>
  );
}
