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
  theme?: { background?: string; foreground?: string; accent?: string };
  socials?: Array<{ platform: string; url: string }>;
  links?: Array<{ label: string; url: string }>;
  blocks?: Array<{ type: string; content: string }>;
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
  "Only include lookup_blockpage when the user named a username. " +
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

    // 1. Groq plans the build (one retry if the model fumbles the JSON).
    let plan: AgentPlan;
    try {
      plan = await planWithRetry(spoken);
    } catch {
      return NextResponse.json({ error: "The agent stumbled — try again." }, { status: 502 });
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

    return NextResponse.json({
      speak: plan.speak ?? "Draft ready.",
      steps: plan.steps ?? [],
      toolResults,
      pageDraft: plan.pageDraft ?? {},
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
