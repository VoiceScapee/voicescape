/**
 * Voicescape plugin for the Hedera Agent Kit — Blockpage Buddy's brain.
 *
 * This is the same plugin that powers the standalone Agent Kit runtime:
 * three read-only chain tools (blockpage lookup, tip verification, treasury
 * stats), all served from the public Hedera mainnet mirror node. No signing,
 * no spending, no operator key — pure queries.
 *
 * `getBuddyTools()` returns the kit's `Tool` objects bound to a per-request
 * context. `toFunctionDefs()` converts them to the OpenAI function-calling
 * shape the chat route sends to the model. The route executes tools through
 * the kit (`tool.execute`) — never through hand-rolled copies.
 */
import {
  TOOL_TYPE,
  type Context,
  type Plugin,
  type Tool,
} from "@hashgraph/hedera-agent-kit";
import zodToJsonSchema from "zod-to-json-schema";
import {
  LOOKUP_BLOCKPAGE_TOOL,
  TREASURY_STATS_TOOL,
  VERIFY_TIP_TOOL,
  lookupBlockpageTool,
  treasuryStatsTool,
  verifyTipTool,
} from "./tools";

/** Agent Kit context extended with the request AbortSignal for chain reads. */
export type BuddyContext = Context & { signal?: AbortSignal };

const voicescapePlugin: Plugin = {
  name: "voicescape-plugin",
  version: "1.0.0",
  description:
    "Read-only Voicescape chain tools: blockpage lookup, tip verification, " +
    "and treasury stats via the Hedera mainnet mirror node.",
  tools: (context: Context) => [
    lookupBlockpageTool(context),
    verifyTipTool(context),
    treasuryStatsTool(context),
  ],
};

export default voicescapePlugin;
export {
  LOOKUP_BLOCKPAGE_TOOL,
  TREASURY_STATS_TOOL,
  VERIFY_TIP_TOOL,
  type Tool,
};

/**
 * Build Buddy's tools for one request. Defense in depth: this route is
 * read-only, so refuse to register anything that isn't a QUERY tool — a
 * future transaction tool can never slip into the chat path.
 */
export function getBuddyTools(signal?: AbortSignal): Tool[] {
  const context: BuddyContext = { signal };
  const tools = voicescapePlugin.tools(context);
  for (const tool of tools) {
    if (tool.toolType !== TOOL_TYPE.QUERY) {
      throw new Error(
        `refusing non-query tool in read-only chat route: ${tool.method}`
      );
    }
  }
  return tools;
}

/** The model-facing function name for a kit tool method. */
export function functionNameFor(method: string): string {
  switch (method) {
    case LOOKUP_BLOCKPAGE_TOOL:
      return "resolve_blockpage";
    case VERIFY_TIP_TOOL:
      return "verify_tip";
    case TREASURY_STATS_TOOL:
      return "treasury_stats";
    default:
      return method;
  }
}

/**
 * Convert kit tools to OpenAI function definitions for the chat-completions
 * request. Parameter schemas come straight from each tool's zod schema, so
 * the model can only send arguments the tool will accept.
 */
export function toFunctionDefs(tools: Tool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: functionNameFor(tool.method),
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters, {
        $refStrategy: "none",
      }),
    },
  }));
}

/** Find the kit tool behind a model-facing function name. */
export function findTool(
  tools: Tool[],
  functionName: string
): Tool | undefined {
  return tools.find((t) => functionNameFor(t.method) === functionName);
}
