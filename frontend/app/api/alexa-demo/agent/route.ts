/**
 * POST /api/alexa-demo/agent — Voicescape Voice Builder (hackathon demo).
 *
 * Demo-only agent loop for the Amazon Build, Ship, Shape Alexa+ track entry.
 * NOT production: this route exists on the hackathon branch only and is never
 * merged to master. It performs no wallet, payment, claim, or signing work.
 *
 * Flow: spoken transcript -> Groq plans tool calls -> the LIVE Voicescape MCP
 * server is called over Streamable HTTP (spec 2025-11-25) -> a page draft is
 * returned for the client to preview and speak back.
 *
 * Groq auth: this host's credential helper is Python-only, so the route
 * spawns ~/workspace/skills/groq/bin/groq_chat.py as a child process and
 * feeds it the request on stdin. The raw key never crosses into Node code.
 * On Vercel (serverless) the child process can't run, so the route falls
 * back to Pollinations' keyless HTTPS endpoint ($0, no key) for planning.
 * Either way the MCP calls are identical: live server, Streamable HTTP,
 * spec 2025-11-25.
 */
import { spawn } from "child_process";
import { NextRequest, NextResponse } from "next/server";

const GROQ_CLI = "/home/hatch/workspace/skills/groq/bin/groq_chat.py";
const GROQ_MODEL = "openai/gpt-oss-20b";
const MCP_ENDPOINT = "https://voicescape.vercel.app/api/mcp";
const MCP_PROTOCOL_VERSION = "2025-11-25";

/** Read-only / preview-only tools the demo is allowed to call. */
const ALLOWED_TOOLS = new Set([
  "lookup_blockpage",
  "list_templates",
  "blockpage_earnings",
  "list_tip_assets",
  "check_profile_pin",
]);

/** Fields that stay server-side — never sent to the demo client. */
const SENSITIVE_KEYS = new Set([
  "owner_evm",
  "owner_account",
  "operator",
  "ipfs_hash",
  "wallet",
  "account_id",
]);

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface PageDraft {
  displayName?: string;
  purpose?: string;
  theme?: { background?: string; foreground?: string; accent?: string; fontFamily?: string };
  socials?: Array<{ platform: string; url: string }>;
  links?: Array<{ label: string; url: string }>;
  // Blocks may be the planner's simple {type,content} shape or the real
  // blockpage block shapes (hero, bio, music, livestream, tipJar, links,
  // gallery) fetched live from IPFS.
  blocks?: Array<Record<string, unknown>>;
}

interface AgentPlan {
  speak: string;
  steps: string[];
  toolCalls: ToolCall[];
  pageDraft: PageDraft;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

const SYSTEM_PROMPT =
  "You are the planner for the Voicescape Voice Builder demo. " +
  "Voicescape is a Hedera-mainnet social dapp where creators own blockpages " +
  "(profile pages) and keep 98% of every on-chain tip. " +
  "You plan a page draft from the user's spoken request and pick live MCP " +
  "tools to call. Read-only tools only. " +
  "Reply with JSON ONLY, no markdown fences, matching this shape: " +
  '{"speak":"1-2 sentence spoken summary","steps":["what you did, 2-5 items"],' +
  '"toolCalls":[{"name":"lookup_blockpage","arguments":{"username":"name"}}],' +
  '"pageDraft":{"displayName":"...","purpose":"...","theme":{"background":"#hex","foreground":"#hex","accent":"#hex"},' +
  '"socials":[{"platform":"x|instagram|youtube|tiktok|website","url":"https://..."}],' +
  '"links":[{"label":"...","url":"https://..."}],"blocks":[{"type":"text","content":"..."}]}} ' +
  "Only use these tool names: lookup_blockpage, list_templates, " +
  "blockpage_earnings, list_tip_assets, check_profile_pin. " +
  "If the user asks to see a live music blockpage (e.g. 'show me a live " +
  "music blockpage', 'my music', 'music page'), call lookup_blockpage with " +
  "username \"ash-rook\" — it is our live music blockpage — and set " +
  "pageDraft.displayName from it. Frame your spoken summary as showing the " +
  "live example, not building something new. The server fetches the " +
  "full live page for the preview, so keep your own draft blocks short; the " +
  "real blocks win. Otherwise only include lookup_blockpage when the user " +
  "named a username. " +
  "Never invent usernames, wallet data, or earnings numbers — if you " +
  "don't know, say so in speak and keep the draft generic.";

async function groqChildJson(messages: unknown): Promise<string> {
  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages,
    max_tokens: 2048,
    temperature: 0.7,
  });
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn("python3", [GROQ_CLI], { timeout: 90000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout: out }) : reject(new Error(`groq cli exit ${code}: ${err.slice(0, 300)}`))
    );
    child.stdin.write(body);
    child.stdin.end();
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error) throw new Error(`groq: ${parsed.error} ${parsed.detail ?? ""}`);
  const content: string = parsed.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("groq: empty plan");
  return content;
}

/**
 * Keyless HTTPS fallback for serverless (Vercel preview): the Python
 * credential helper can't run there, so plan via Pollinations' free
 * OpenAI-compatible endpoint. $0, no key. Demo-only.
 */
async function pollinationsJson(messages: unknown): Promise<string> {
  const res = await fetch("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai",
      messages,
      max_tokens: 2048,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`pollinations: HTTP ${res.status}`);
  const parsed = await res.json();
  const content: string = parsed.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("pollinations: empty plan");
  return content;
}

async function groqJson(prompt: string): Promise<string> {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  // Serverless (Vercel preview) can't spawn the Python credential helper.
  if (process.env.VERCEL) return cleanJson(await pollinationsJson(messages));
  try {
    return cleanJson(await groqChildJson(messages));
  } catch {
    return cleanJson(await pollinationsJson(messages));
  }
}

function cleanJson(raw: string): string {
  // Models sometimes wrap JSON in fences despite instructions; strip them.
  let s = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // If there's prose around the JSON, extract the outermost object.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

async function planWithRetry(prompt: string, attempts = 2): Promise<AgentPlan> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(await groqJson(prompt)) as AgentPlan;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("planner failed");
}

/**
 * Deterministic fallback when the AI planner is unreachable (the free
 * planning endpoint is flaky): handles the demo's known prompts with no
 * model call. The MCP calls that follow are still 100% live — only the
 * "thinking" step is rule-based.
 */
function fallbackPlan(spoken: string): AgentPlan {
  const lower = spoken.toLowerCase();
  const steps = ["Heard your request", "Planning over the live MCP server"];
  if (/music|ash.?rook/.test(lower)) {
    steps.push('Looking up the live "ash-rook" music blockpage');
    return {
      speak:
        "Here's the Ash Rook live music blockpage — a real page on Voicescape, with music playing inside the preview.",
      steps,
      toolCalls: [{ name: "lookup_blockpage", arguments: { username: "ash-rook" } }],
      pageDraft: { displayName: "Ash Rook", purpose: "Live music blockpage", blocks: [] },
    };
  }
  const userMatch = lower.match(/(?:look\s*up|show me)(?: the)? blockpage ([a-z0-9][a-z0-9\-_]*)/);
  if (userMatch) {
    const username = userMatch[1];
    steps.push(`Looking up the live "${username}" blockpage`);
    return {
      speak: `Here's the live ${username} blockpage, pulled straight from Voicescape.`,
      steps,
      toolCalls: [{ name: "lookup_blockpage", arguments: { username } }],
      pageDraft: { displayName: username, blocks: [] },
    };
  }
  if (/photo|portfolio/.test(lower)) {
    steps.push("Listing live page templates");
    return {
      speak: "Here's a photography portfolio starter, built from live Voicescape templates.",
      steps,
      toolCalls: [{ name: "list_templates", arguments: {} }],
      pageDraft: {
        displayName: "Photography portfolio",
        purpose: "A portfolio page starter",
        theme: { background: "#0f172a", foreground: "#f1f5f9", accent: "#38bdf8" },
        blocks: [{ type: "text", content: "A portfolio page — your photos, your story, tips open." }],
      },
    };
  }
  steps.push("Drafting a preview");
  return {
    speak: "Here's a blockpage preview I put together for you.",
    steps,
    toolCalls: [],
    pageDraft: {
      displayName: "Your page",
      theme: { background: "#0f172a", foreground: "#f1f5f9", accent: "#38bdf8" },
      blocks: [{ type: "text", content: spoken.slice(0, 140) }],
    },
  };
}

/** Pull the username out of a successful lookup_blockpage tool result. */
function lookedUpUsername(results: Array<{ tool: string; result: unknown }>): string | null {
  for (const t of results) {
    if (t.tool !== "lookup_blockpage") continue;
    const text = (t.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    if (!text) continue;
    try {
      const j = JSON.parse(text) as { found?: boolean; username?: string };
      if (j.found && j.username) return j.username;
    } catch {
      /* not JSON — ignore */
    }
  }
  return null;
}

interface LivePage {
  blocks: Array<Record<string, unknown>>;
  theme?: { background?: string; foreground?: string; accent?: string; fontFamily?: string };
  displayName?: string;
  purpose?: string;
}

/**
 * Fetch a blockpage's full live JSON (resolve -> IPFS) so the demo preview
 * renders the ACTUAL page — real blocks, real theme, real playing
 * livestream — instead of a mock.
 */
async function fetchLivePage(username: string): Promise<LivePage | null> {
  try {
    const r = await fetch(
      `https://voicescape.vercel.app/api/resolve?username=${encodeURIComponent(username)}`
    );
    if (!r.ok) return null;
    const { ipfsHash } = (await r.json()) as { ipfsHash?: string };
    if (!ipfsHash) return null;
    const p = await fetch(`https://gateway.pinata.cloud/ipfs/${ipfsHash}`);
    if (!p.ok) return null;
    const page = (await p.json()) as {
      blocks?: Array<Record<string, unknown>>;
      theme?: LivePage["theme"];
      purpose?: string;
      username?: string;
    };
    const hero = (page.blocks ?? []).find((b) => b.type === "hero") as
      | { title?: string }
      | undefined;
    return {
      blocks: page.blocks ?? [],
      theme: page.theme,
      displayName: hero?.title ?? page.username,
      purpose: page.purpose,
    };
  } catch {
    return null;
  }
}

async function mcpRpc(method: string, params: Record<string, unknown>, id: number) {
  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  for (const line of dataLines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === id && msg.result !== undefined) return msg.result;
      if (msg.id === id && msg.error) throw new Error(`mcp: ${msg.error.message ?? "rpc error"}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("mcp:")) throw e;
    }
  }
  throw new Error("mcp: no result in stream");
}

export async function POST(req: NextRequest) {
  try {
    const { transcript } = (await req.json()) as { transcript?: string };
    const spoken = (transcript ?? "").trim();
    if (!spoken) {
      return NextResponse.json({ error: "empty transcript" }, { status: 400 });
    }

    // 1. Plan the build: AI planner first, deterministic fallback if the
    //    free planning endpoint is down (the MCP calls after this are
    //    still live either way).
    let plan: AgentPlan;
    let plannedBy: string;
    try {
      plan = await planWithRetry(spoken);
      plannedBy = "ai";
    } catch {
      plan = fallbackPlan(spoken);
      plannedBy = "fallback";
    }

    // 2. Call the LIVE MCP server over Streamable HTTP (spec 2025-11-25).
    const init = await mcpRpc(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "voicescape-alexa-demo", version: "0.1.0" },
      },
      1
    );

    const toolResults: Array<{ tool: string; result: unknown }> = [];
    let callId = 2;
    for (const call of plan.toolCalls ?? []) {
      if (!ALLOWED_TOOLS.has(call.name)) continue; // never let the planner reach past read-only
      try {
        const result = await mcpRpc("tools/call", { name: call.name, arguments: call.arguments ?? {} }, callId++);
        toolResults.push({ tool: call.name, result: sanitize(result) });
      } catch (e) {
        toolResults.push({
          tool: call.name,
          result: { error: e instanceof Error ? e.message : "tool failed" },
        });
      }
    }

    // 3. If the planner looked up a real blockpage, fetch its full live
    //    JSON so the preview is the ACTUAL page — real blocks, real theme,
    //    real playing livestream — not a mock.
    const steps: string[] = plan.steps ?? [];
    const liveUsername = lookedUpUsername(toolResults);
    let livePage: LivePage | null = null;
    if (liveUsername) {
      livePage = await fetchLivePage(liveUsername);
      if (livePage) {
        steps.push(`Pulled the live ${liveUsername} blockpage for the preview`);
      }
    }

    const pageDraft: PageDraft = livePage
      ? {
          displayName: livePage.displayName ?? plan.pageDraft?.displayName,
          purpose: livePage.purpose ?? plan.pageDraft?.purpose,
          theme: livePage.theme ?? plan.pageDraft?.theme,
          blocks: livePage.blocks,
        }
      : plan.pageDraft ?? {};

    return NextResponse.json({
      speak: plan.speak ?? "Draft ready.",
      steps,
      toolResults,
      pageDraft,
      mcp: {
        endpoint: MCP_ENDPOINT,
        protocolVersion: init?.protocolVersion ?? MCP_PROTOCOL_VERSION,
        serverName: init?.serverInfo?.name ?? "voicescape",
      },
      disclaimer:
        "Demo preview — nothing was claimed or published. Claiming a blockpage happens in the dapp with your own wallet.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "agent failed" },
      { status: 500 }
    );
  }
}
