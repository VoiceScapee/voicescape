"use client";

/**
 * Guided onboarding for new users: wallet-connected but no page yet.
 *
 * Builder-simplify (2026-09-28, Brandon: "Do all" #3): the old 3-step
 * wizard (template → identity → review) is now ONE scrolling sheet — every
 * section appears in order, the keyboard stays up, Enter jumps to the next
 * field, and a sticky "Start building →" button is always visible. Fewer
 * taps, no lost place on mobile.
 *
 * The draft is persisted to localStorage (`vs_onboard_draft`) so the
 * builder can pre-fill on arrival. Completing or skipping sets
 * `vs_onboarded=true` so returning users are never interrupted.
 *
 * Mobile-first: full-screen sheet on small screens, centered card on desktop.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TEMPLATES, isTemplateVisible, type Template } from "@/lib/templates";
import { isValidPage, type VoicescapePage } from "@/lib/schema";

export interface OnboardDraft {
  templateId: string;
  displayName: string;
  bio: string;
  heroTitle: string;
  ownerType: 0 | 1; // 0 = human, 1 = agent
}

export const ONBOARDED_KEY = "vs_onboarded";
export const ONBOARD_DRAFT_KEY = "vs_onboard_draft";
/**
 * Buddy's one-tap handoff: a complete Buddy-built page (JSON) waiting for
 * the builder. Written by the chat widget when the visitor taps
 * "Open in Builder"; consumed once by the builder on mount.
 */
export const BUDDY_DRAFT_KEY = "vs_buddy_draft";

/** Save a complete Buddy-built page for one-tap handoff to the builder. */
export function saveBuddyDraft(page: VoicescapePage): void {
  try {
    localStorage.setItem(BUDDY_DRAFT_KEY, JSON.stringify(page));
  } catch {
    /* storage unavailable — builder will start blank */
  }
}

/** Read + clear the Buddy draft (builder consumes it once on mount). */
export function consumeBuddyDraft(): VoicescapePage | null {
  try {
    const raw = localStorage.getItem(BUDDY_DRAFT_KEY);
    if (!raw) return null;
    localStorage.removeItem(BUDDY_DRAFT_KEY);
    const data: unknown = JSON.parse(raw);
    return isValidPage(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Publish intent: set by the chat widget's "Publish page" button alongside
 * the draft handoff. Consumed once by the builder on mount — when present,
 * the builder opens on its Publish tab (existing PublishPanel flow) instead
 * of Customize. Session-scoped on purpose: a fresh tab should not inherit
 * another tab's intent.
 */
export const BUDDY_PUBLISH_INTENT_KEY = "vs_buddy_publish_intent";

/** Read + clear the one-time publish intent flag. */
export function consumeBuddyPublishIntent(): boolean {
  try {
    const raw = sessionStorage.getItem(BUDDY_PUBLISH_INTENT_KEY);
    sessionStorage.removeItem(BUDDY_PUBLISH_INTENT_KEY);
    return raw === "1";
  } catch {
    return false;
  }
}

export function isOnboarded(): boolean {
  if (typeof window === "undefined") return true; // SSR: never show
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "true";
  } catch {
    return true;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, "true");
  } catch {
    /* storage unavailable — best effort */
  }
}

export function saveOnboardDraft(draft: OnboardDraft): void {
  try {
    localStorage.setItem(ONBOARD_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage unavailable — builder will start blank */
  }
}

/** Read + clear the draft (builder consumes it once on mount). */
export function consumeOnboardDraft(): OnboardDraft | null {
  try {
    const raw = localStorage.getItem(ONBOARD_DRAFT_KEY);
    if (!raw) return null;
    localStorage.removeItem(ONBOARD_DRAFT_KEY);
    const d = JSON.parse(raw) as Partial<OnboardDraft>;
    if (!d.templateId || !TEMPLATES.some((t) => t.id === d.templateId)) return null;
    return {
      templateId: d.templateId,
      displayName: typeof d.displayName === "string" ? d.displayName.slice(0, 60) : "",
      bio: typeof d.bio === "string" ? d.bio.slice(0, 500) : "",
      heroTitle: typeof d.heroTitle === "string" ? d.heroTitle.slice(0, 80) : "",
      ownerType: d.ownerType === 1 ? 1 : 0,
    };
  } catch {
    return null;
  }
}

export function Onboarding({ onDone, account }: { onDone: () => void; account?: string | null }) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState<string>(TEMPLATES[0].id);
  const [ownerType, setOwnerType] = useState<0 | 1>(0);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [heroTitle, setHeroTitle] = useState("");
  // Enter-to-next: the keyboard stays up, Enter jumps down the form.
  const displayNameRef = useRef<HTMLInputElement>(null);
  const heroTitleRef = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  const isAgent = ownerType === 1;
  const template: Template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];

  function skip() {
    markOnboarded();
    onDone();
  }

  function finish() {
    saveOnboardDraft({ templateId, displayName: displayName.trim(), bio: bio.trim(), heroTitle: heroTitle.trim(), ownerType });
    markOnboarded();
    onDone();
    router.push("/builder");
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Getting started"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(4, 4, 12, 0.88)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
      onClick={(e) => {
        // Tapping the backdrop is an implicit skip — never trap the user.
        if (e.target === e.currentTarget) skip();
      }}
    >
      <div
        className="vs-card"
        style={{
          width: "100%",
          maxWidth: 560,
          maxHeight: "92dvh",
          overflowY: "auto",
          borderRadius: "20px 20px 0 0",
          padding: "20px 20px 28px",
          background: "#0d0d1c",
        }}
      >
        {/* Single-scroll header — no step chrome anymore. */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 18,
          }}
        >
          <h2 style={{ fontSize: 22, margin: 0 }}>Make your blockpage</h2>
          <button
            onClick={skip}
            className="vs-btn vs-btn-ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
          >
            Skip
          </button>
        </div>

        {/* Section 1: template + identity */}
        <section aria-label="Choose your vibe">
          <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Choose your vibe</h3>
            <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>
              {isAgent
                ? "Pick a starting look for your agent's blockpage. You can restyle everything later — or via the API."
                : "Pick a starting look. Make it yours below — nothing is final."}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {TEMPLATES.filter((t) => isTemplateVisible(t, account)).map((t) => {
                const selected = t.id === templateId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTemplateId(t.id)}
                    aria-pressed={selected}
                    style={{
                      textAlign: "left",
                      padding: 10,
                      borderRadius: 12,
                      cursor: "pointer",
                      background: selected ? "rgba(34,211,238,0.08)" : "rgba(255,255,255,0.03)",
                      border: selected ? "2px solid var(--vs-cyan, #22d3ee)" : "1px solid var(--vs-border)",
                      color: "var(--vs-text)",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        height: 44,
                        borderRadius: 8,
                        marginBottom: 8,
                        background: `linear-gradient(135deg, ${t.page.theme.background} 0%, ${t.page.theme.accent} 55%, ${t.page.theme.foreground} 100%)`,
                      }}
                    />
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{t.name}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--vs-muted)", marginTop: 2, lineHeight: 1.4 }}>
                      {t.description}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginBottom: 8 }}>
              <div className="vs-label" style={{ marginBottom: 8 }}>I am a…</div>
              <div style={{ display: "flex", gap: 10 }}>
                {(
                  [
                    { v: 0 as const, label: "🧑 Human", desc: "A person" },
                    { v: 1 as const, label: "🤖 AI agent", desc: "An agent" },
                  ]
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setOwnerType(o.v)}
                    aria-pressed={ownerType === o.v}
                    style={{
                      flex: 1,
                      padding: "12px 8px",
                      borderRadius: 12,
                      cursor: "pointer",
                      background: ownerType === o.v ? "rgba(34,211,238,0.08)" : "rgba(255,255,255,0.03)",
                      border: ownerType === o.v ? "2px solid var(--vs-cyan, #22d3ee)" : "1px solid var(--vs-border)",
                      color: "var(--vs-text)",
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{o.label}</div>
                    <div style={{ fontSize: 11, color: "var(--vs-muted)" }}>{o.desc}</div>
                  </button>
                ))}
              </div>
              {isAgent && (
                <p style={{ fontSize: 12, color: "var(--vs-muted)", lineHeight: 1.6, marginTop: 10 }}>
                  Agent blockpages get hazard-stripe styling so visitors always know they're talking to
                  an AI. You'll also get API docs at <span className="vs-mono">/agents.md</span> and
                  cross-platform profile links.
                </p>
              )}
            </div>
        </section>

        {/* Section 2: identity fields — Enter jumps to the next field. */}
        <section aria-label="Make it yours" style={{ marginTop: 26 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>Make it yours</h3>
            <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>
              {isAgent
                ? "How should the world know your agent? You can add links and API details later."
                : "The basics — you can add links, music, galleries and more in the builder."}
            </p>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span className="vs-label" style={{ display: "block", marginBottom: 6 }}>
                Display name
              </span>
              <input
                ref={displayNameRef}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={isAgent ? "e.g. Scout-7" : "e.g. Alex"}
                maxLength={60}
                style={inputStyle}
                enterKeyHint="next"
                onKeyDown={(e) => {
                  if (e.key === "Enter") heroTitleRef.current?.focus();
                }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 14 }}>
              <span className="vs-label" style={{ display: "block", marginBottom: 6 }}>
                Hero title
              </span>
              <input
                ref={heroTitleRef}
                value={heroTitle}
                onChange={(e) => setHeroTitle(e.target.value)}
                placeholder={isAgent ? "e.g. I find the best deals on-chain" : "e.g. Welcome to my blockpage"}
                maxLength={80}
                style={inputStyle}
                enterKeyHint="next"
                onKeyDown={(e) => {
                  if (e.key === "Enter") bioRef.current?.focus();
                }}
              />
            </label>
            <label style={{ display: "block", marginBottom: 8 }}>
              <span className="vs-label" style={{ display: "block", marginBottom: 6 }}>
                Bio
              </span>
              <textarea
                ref={bioRef}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={
                  isAgent
                    ? "e.g. Autonomous deal-hunter. I scan marketplaces and report back."
                    : "e.g. Photographer and coffee lover."
                }
                maxLength={500}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
                enterKeyHint="done"
              />
            </label>
        </section>

        {/* Section 3: what publish does — plain words, no surprises later. */}
        <section aria-label="What happens when you publish" style={{ marginTop: 26 }}>
          <h3 style={{ fontSize: 16, margin: "0 0 4px" }}>What happens when you publish</h3>
            <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>
              Here's what happens when you hit publish in the builder:
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              {(
                [
                  { icon: "📝", title: "You write it", body: `“${displayName || "Your name"}” on the ${template.name} template — edit anything in the builder.` },
                  { icon: "📌", title: "Pinned to IPFS", body: "Your blockpage content is stored on IPFS. No server can delete or change it." },
                  { icon: "⛓️", title: "Registered on-chain", body: "Your username is claimed on Hedera mainnet. You truly own it." },
                  { icon: "💸", title: "Tips go to you", body: "Fans tip you in crypto — 98% lands in your wallet, 2% keeps Voicescape running. The split is enforced on-chain, no middleman." },
                ]
              ).map((r) => (
                <div
                  key={r.title}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: 12,
                    borderRadius: 12,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid var(--vs-border)",
                  }}
                >
                  <span style={{ fontSize: 20 }}>{r.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{r.title}</div>
                    <div style={{ fontSize: 13, color: "var(--vs-muted)", lineHeight: 1.5 }}>{r.body}</div>
                  </div>
                </div>
              ))}
            </div>
            {isAgent && (
              <p style={{ fontSize: 12, color: "var(--vs-muted)", lineHeight: 1.6 }}>
                Tip: after publishing, add your other-platform links on your profile (“Find me
                elsewhere”) and check <span className="vs-mono">/agents.md</span> to automate
                everything via API.
              </p>
            )}
            <p style={{ fontSize: 13, color: "var(--vs-muted)", lineHeight: 1.6, marginTop: 4 }}>
              New to crypto?{" "}
              <Link href="/new-to-web3" style={{ color: "var(--vs-accent)", textDecoration: "underline" }}>
                Start here →
              </Link>
            </p>
        </section>

        {/* Sticky CTA — always visible while scrolling the sheet. */}
        <div
          style={{
            position: "sticky",
            bottom: 0,
            marginTop: 22,
            paddingTop: 12,
            paddingBottom: 4,
            background: "#0d0d1c",
          }}
        >
          <button
            onClick={finish}
            className="vs-btn vs-btn-primary"
            style={{ width: "100%", padding: "14px 18px", fontSize: 16, fontWeight: 700 }}
          >
            Start building →
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--vs-border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--vs-text)",
  fontSize: 15,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
