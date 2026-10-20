/**
 * voice-dapp-chips — per-surface content for the dapp-wide voice mic.
 *
 * First principles: each dapp surface gets the buttons its visitors
 * actually need — nothing generic, nothing borrowed from another page.
 * The builder surface is the two-path choice: build it yourself for
 * free, or build it with AI help. KISS: two chips there, never four.
 */

import type { Lang } from "@/lib/i18n/dictionaries";

export type DappSection = "builder" | "agents" | "explore" | "home";

/** Map a dapp-surface pathname to its mic section. Pure — unit tested. */
export function dappSectionFor(pathname: string): DappSection {
  if (pathname === "/builder" || pathname.startsWith("/builder/")) return "builder";
  if (pathname === "/agents" || pathname.startsWith("/agents/")) return "agents";
  if (pathname === "/explore" || pathname.startsWith("/explore/")) return "explore";
  return "home";
}

/**
 * Suggestion chips for a dapp section — general questions, never
 * page-specific. Chip text is what gets sent to /api/page-voice, so
 * every chip must match a deterministic dapp intent (en/es).
 */
export function dappSectionChips(section: DappSection, lang: Lang): string[] {
  const es = lang === "es";
  switch (section) {
    case "builder":
      // The two paths: free self-serve, or AI-assisted with our help.
      return [
        es ? "Lo hago yo (gratis)" : "Build it myself (free)",
        es ? "Ayúdame a construirla" : "Help me build it",
      ];
    case "agents":
      return [
        es ? "¿Cómo contrato un agente?" : "How do I hire an agent?",
        es ? "¿Cómo ganan los agentes?" : "How do agents earn?",
        es ? "¿Cuánto cuesta?" : "What does it cost?",
      ];
    case "explore":
      return [
        es ? "¿Qué es Voicescape?" : "What is Voicescape?",
        es ? "¿Qué son los agentes IA?" : "What are AI agents?",
        es ? "¿Cómo funcionan las propinas?" : "How do tips work?",
      ];
    case "home":
      return [
        es ? "¿Qué es Voicescape?" : "What is Voicescape?",
        es ? "¿Cómo creo una página?" : "How do I build a page?",
        es ? "¿Cómo funcionan las propinas?" : "How do tips work?",
        es ? "Contratar un agente IA" : "Hire an AI agent",
      ];
  }
}

/** Panel title per section. */
export function dappSectionTitle(section: DappSection): string {
  return section === "builder" ? "Build your page" : "Talk to Voicescape";
}

/** Honest footer note per section. */
export function dappSectionFooter(section: DappSection): string {
  return section === "builder"
    ? "Two ways to build: yourself, free — or with AI help."
    : "Answers about Voicescape — the dapp, blockpages, and AI agents.";
}
