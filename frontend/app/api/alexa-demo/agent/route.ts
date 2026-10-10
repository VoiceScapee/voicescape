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

/** Every language the Voicescape dapp ships (frontend/lib/i18n/dictionaries.ts). */
const VOICE_LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  vi: "Vietnamese",
  id: "Indonesian",
  th: "Thai",
  tl: "Tagalog",
  tr: "Turkish",
  hi: "Hindi",
  ar: "Arabic",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  sv: "Swedish",
  lt: "Lithuanian",
  ro: "Romanian",
  ms: "Malay",
};

/** Fallback "here's the live music page" line when the AI planner is down. */
const FALLBACK_MUSIC_SPEAK: Record<string, string> = {
  en: "Here's the Ash Rook live music blockpage — a real page on Voicescape, with music playing inside the preview.",
  es: "Esta es la blockpage de música en vivo de Ash Rook — una página real de Voicescape, con música sonando dentro de la vista previa.",
  zh: "这是 Ash Rook 的现场音乐 blockpage——Voicescape 上的真实页面，预览中正在播放音乐。",
  ja: "Ash Rookのライブ音楽ブロックページです — Voicescapeの実際のページで、プレビュー内で音楽が流れています。",
  ko: "Ash Rook의 라이브 음악 블록페이지입니다 — Voicescape의 실제 페이지이며, 미리보기 안에서 음악이 재생 중입니다。",
  vi: "Đây là blockpage nhạc trực tiếp của Ash Rook — một trang thật trên Voicescape, với nhạc đang phát trong bản xem trước.",
  id: "Ini adalah blockpage musik live Ash Rook — halaman asli di Voicescape, dengan musik yang diputar di dalam pratinjau.",
  th: "นี่คือบล็อกเพจเพลงสดของ Ash Rook — เพจจริงบน Voicescape พร้อมเสียงเพลงที่เล่นอยู่ในตัวอย่าง",
  tl: "Ito ang live music blockpage ni Ash Rook — isang tunay na page sa Voicescape, na may tumutugtog na musika sa loob ng preview.",
  tr: "İşte Ash Rook canlı müzik blok sayfası — Voicescape'te gerçek bir sayfa, önizlemenin içinde müzik çalıyor.",
  hi: "यह Ash Rook का लाइव संगीत ब्लॉकपेज है — Voicescape पर एक असली पेज, जिसके प्रीव्यू में संगीत बज रहा है।",
  ar: "هذه هي صفحة الموسيقى المباشرة لـ Ash Rook — صفحة حقيقية على Voicescape، مع موسيقى تُشغَّل داخل المعاينة.",
  pt: "Esta é a blockpage de música ao vivo do Ash Rook — uma página real na Voicescape, com música tocando dentro da pré-visualização.",
  fr: "Voici la blockpage de musique en direct d'Ash Rook — une vraie page sur Voicescape, avec de la musique qui joue dans l'aperçu.",
  de: "Das ist Ash Rooks Live-Musik-Blockpage — eine echte Seite auf Voicescape, mit Musik direkt in der Vorschau.",
  it: "Questa è la blockpage di musica dal vivo di Ash Rook — una pagina reale su Voicescape, con musica in riproduzione nell'anteprima.",
  sv: "Här är Ash Rooks livemusik-blockpage — en riktig sida på Voicescape, med musik som spelas i förhandsvisningen.",
  lt: "Tai „Ash Rook“ gyvos muzikos blokpuslapis — tikras puslapis „Voicescape“, kurio peržiūroje groja muzika.",
  ro: "Aceasta este blockpage-ul de muzică live al lui Ash Rook — o pagină reală pe Voicescape, cu muzică redată în previzualizare.",
  ms: "Ini ialah blockpage muzik secara langsung Ash Rook — halaman sebenar di Voicescape, dengan muzik dimainkan di dalam pratonton.",
};

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

async function groqJson(prompt: string, langName: string): Promise<string> {
  const langSuffix =
    langName === "English"
      ? ""
      : ` The user speaks ${langName}: write your "speak" and "steps" in ${langName}.`;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT + langSuffix },
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

async function planWithRetry(prompt: string, langName: string, attempts = 2): Promise<AgentPlan> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(await groqJson(prompt, langName)) as AgentPlan;
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
function fallbackPlan(spoken: string, langCode: string): AgentPlan {
  const lower = spoken.toLowerCase();
  const steps = ["Heard your request", "Planning over the live MCP server"];
  // "music" in the dapp's languages, so the fallback works globally too.
  const musicRe =
    /music|música|音乐|音楽|음악|nhạc|musik|เพลง|musika|müzik|संगीत|موسيقى|musique|ash.?rook/;
  if (musicRe.test(lower)) {
    steps.push('Looking up the live "ash-rook" music blockpage');
    return {
      speak: FALLBACK_MUSIC_SPEAK[langCode] ?? FALLBACK_MUSIC_SPEAK.en,
      steps,
      toolCalls: [
        { name: "lookup_blockpage", arguments: { username: "ash-rook" } },
        { name: "blockpage_earnings", arguments: { username: "ash-rook" } },
      ],
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

/**
 * Resolve a YouTube channel's current live video ID by scraping the
 * channel's /live page (same technique as the dapp's /api/youtube-live).
 * The direct video embed is reliable; the live_stream?channel= resolver
 * embed proved unreliable in production. Returns null when it can't tell.
 */
async function resolveYouTubeVideoId(channel: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(channel)}/live`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!/"isLive":true/.test(html)) return null;
    const counts = new Map<string, number>();
    for (const m of html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return best;
  } catch {
    return null;
  }
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

/**
 * One honest line per real tool call, with its actual outcome — the demo's
 * proof of work. Returns null when the result can't be summarized.
 */
function describeToolResult(tool: string, result: unknown): string | null {
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) return `${tool} → called`;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return `${tool} → ok`;
  }
  if (tool === "lookup_blockpage") {
    const u = typeof j.username === "string" ? j.username : "page";
    return j.found ? `lookup_blockpage("${u}") → found ✓` : `lookup_blockpage("${u}") → not found`;
  }
  if (tool === "blockpage_earnings") {
    const gross = typeof j.total_gross_hbar === "string" ? j.total_gross_hbar : null;
    const n = typeof j.tip_count === "number" ? j.tip_count : null;
    if (gross !== null && n !== null) {
      return `blockpage_earnings → ${gross} HBAR tipped${n === 1 ? "" : "s"} (creator keeps 98%)`;
    }
    return "blockpage_earnings → ok";
  }
  if (tool === "list_templates") {
    const n = Array.isArray(j.templates) ? j.templates.length : Array.isArray(j) ? j.length : null;
    return n !== null ? `list_templates → ${n} live templates` : "list_templates → ok";
  }
  if (tool === "list_tip_assets") {
    const n = Array.isArray(j.assets) ? j.assets.length : null;
    return n !== null ? `list_tip_assets → ${n} tip assets` : "list_tip_assets → ok";
  }
  return `${tool} → ok`;
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
    const { transcript, lang } = (await req.json()) as {
      transcript?: string;
      lang?: string;
    };
    const spoken = (transcript ?? "").trim();
    if (!spoken) {
      return NextResponse.json({ error: "empty transcript" }, { status: 400 });
    }
    const langCode = typeof lang === "string" && VOICE_LANG_NAMES[lang] ? lang : "en";
    const langName = VOICE_LANG_NAMES[langCode];

    // 1. Plan the build: AI planner first, deterministic fallback if the
    //    free planning endpoint is down (the MCP calls after this are
    //    still live either way).
    let plan: AgentPlan;
    let plannedBy: string;
    try {
      plan = await planWithRetry(spoken, langName);
      plannedBy = "ai";
    } catch {
      plan = fallbackPlan(spoken, langCode);
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
    // Narrate each real tool call with its actual outcome — this is the
    // demo's proof of work, not decoration.
    for (const tr of toolResults) {
      const line = describeToolResult(tr.tool, tr.result);
      if (line) steps.push(line);
    }
    const liveUsername = lookedUpUsername(toolResults);
    let livePage: LivePage | null = null;
    if (liveUsername) {
      livePage = await fetchLivePage(liveUsername);
      if (livePage) {
        steps.push(`Pulled the live ${liveUsername} blockpage for the preview`);
        // Resolve YouTube livestream channels to direct video IDs — the
        // live_stream?channel= resolver embed is unreliable; the direct
        // video embed (same as the dapp uses) plays.
        for (const b of livePage.blocks) {
          if (
            b.type === "livestream" &&
            b.platform === "youtube" &&
            typeof b.channel === "string" &&
            b.channel
          ) {
            const videoId = await resolveYouTubeVideoId(b.channel);
            if (videoId) {
              b.videoId = videoId;
              steps.push("Found the live music stream — it's playing in the preview");
            }
          }
        }
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

    const toolCount = toolResults.length;
    const speakBase = plan.speak ?? "Draft ready.";
    // The agent calls out its real tool count — no vapor, it's the actual
    // number of live MCP calls made above.
    const speak =
      toolCount > 0 ? `${speakBase} I used ${toolCount} live MCP tool${toolCount === 1 ? "" : "s"} to build this.` : speakBase;
    if (toolCount > 0) steps.push(`$ ${toolCount} MCP tool${toolCount === 1 ? "" : "s"} called ⚡`);

    return NextResponse.json({
      speak,
      steps,
      toolResults,
      toolCount,
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
