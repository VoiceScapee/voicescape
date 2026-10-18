/**
 * DappVoiceMicMount — the voice mic on dapp surfaces.
 *
 * Mounted once in the root layout. Renders the mic in dapp mode (no
 * blockpage context — answers general Voicescape questions) ONLY on
 * explicit dapp surfaces. Blockpages (`/[username]`) are never matched:
 * they mount their own page-scoped <PageVoiceMic>, so this allowlist
 * can never double-mount.
 *
 * Excluded on purpose: /admin (internal), /alexa-demo (hackathon demo —
 * keep it pristine), /embed (floating chrome must not leak into iframes),
 * /(townhall) routes (own chat UI), /api, and short-link redirects.
 */
"use client";

import { usePathname } from "next/navigation";
import PageVoiceMic from "./PageVoiceMic";
import { dappSectionFor } from "@/lib/voice-dapp-chips";

const DAPP_VOICE_PATHS = [
  "/",
  "/explore",
  "/agents",
  // "/builder" intentionally absent (2026-10-18): the builder's Describe
  // step has its own integrated voice input — a floating mic would cover
  // step content. The path-choice screen's own buttons cover navigation.
  "/console",
  "/ai-agent",
  "/trust",
  "/status",
  "/new-to-web3",
  "/fundraiser",
  "/intros",
  "/mcp",
];

function isDappSurface(pathname: string): boolean {
  return DAPP_VOICE_PATHS.some((p) =>
    p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(p + "/"),
  );
}

export default function DappVoiceMicMount() {
  const pathname = usePathname();
  if (!pathname || !isDappSurface(pathname)) return null;
  return <PageVoiceMic username={null} page={null} dappSection={dappSectionFor(pathname)} />;
}
