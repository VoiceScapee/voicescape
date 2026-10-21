/**
 * GET /llms.txt — machine-readable front door for AI systems.
 *
 * Served by a ROUTE (not public/llms.txt) for two reasons:
 *  1. The dynamic [username] route would otherwise claim "/llms.txt" as a
 *     blockpage lookup — same reason app/agents.txt/route.ts exists.
 *  2. The numbers are live: the route renders counts from the same server
 *     sources as /api/mcp/stats and /api/agents at request time (cached
 *     hourly), so the copy can never go stale the way a hardcoded "67
 *     tools" line did.
 *
 * Fail-open, per source: every live fact has its own timeout and its own
 * try/catch. A slow or down source means its line is OMITTED from the
 * document — the static positioning copy still serves, and no number is
 * ever estimated, guessed, or carried over from an earlier render.
 */
export const runtime = "nodejs";
export const revalidate = 3600;

import { NextResponse } from "next/server";
import {
  buildLlmsText,
  storeBackedCount,
  type LlmsLiveFacts,
} from "@/lib/llms";
import { siteUrl } from "@/lib/seo";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("llms live-fact timeout")), ms),
    ),
  ]);
}

async function liveFacts(): Promise<LlmsLiveFacts> {
  const facts: LlmsLiveFacts = {};
  const { KNOWN_MCP_TOOLS, getMcpUsageStats } = await import(
    "@/lib/server/mcp-usage-stats"
  );
  facts.toolCount = KNOWN_MCP_TOOLS.length;

  const host = siteUrl().replace(/^https?:\/\//, "");
  const jobs: Promise<void>[] = [
    withTimeout(getMcpUsageStats(), 10_000)
      .then((u) => {
        // False-zero guard (see storeBackedCount): an unreachable store
        // reads back as total 0 with no detail, which must not print.
        facts.toolCalls30d = storeBackedCount(
          u.total,
          Object.keys(u.byTool).length + Object.keys(u.byDay).length,
        );
      })
      .catch(() => {}),
    (async () => {
      try {
        const { scanRegisteredUsernames } = await import(
          "@/lib/server/agents-directory"
        );
        const { getRegistryAddress } = await import("@/lib/contracts");
        const registry = getRegistryAddress();
        if (!registry) return;
        const rows = await withTimeout(
          scanRegisteredUsernames(registry),
          15_000,
        );
        facts.registeredPages = rows.length;
      } catch {
        /* omitted, never estimated */
      }
    })(),
    (async () => {
      try {
        const { buildAgentDirectory } = await import(
          "@/lib/server/agents-directory"
        );
        const dir = await withTimeout(buildAgentDirectory(host), 15_000);
        facts.directoryAgents = dir.count;
      } catch {
        /* omitted, never estimated */
      }
    })(),
    (async () => {
      try {
        const { listAgentIntros } = await import("@/lib/server/agent-intros");
        const intros = await withTimeout(listAgentIntros(), 10_000);
        // Same false-zero guard: an empty read is indistinguishable from
        // an unreachable store, so only a positive count prints.
        if (intros.length > 0) facts.introductions = intros.length;
      } catch {
        /* omitted, never estimated */
      }
    })(),
  ];
  await Promise.all(jobs);
  return facts;
}

export async function GET(): Promise<Response> {
  let facts: LlmsLiveFacts = {};
  try {
    facts = await liveFacts();
  } catch {
    facts = {};
  }
  // Even a total live-fact failure still serves the static positioning
  // copy — buildLlmsText never throws on missing facts.
  return new NextResponse(buildLlmsText(facts), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
