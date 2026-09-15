/**
 * Voicescape Agent Kit plugin tests: the chat route's brain runs on
 * Hedera's official `@hashgraph/hedera-agent-kit` — these tests lock in
 * that the plugin exposes exactly the three read-only query tools, that
 * the model-facing function names stay stable, and that tool execution
 * works against a mocked mirror node.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { AbiCoder } from "ethers";
import { TOOL_TYPE } from "@hashgraph/hedera-agent-kit";
import {
  findTool,
  functionNameFor,
  getBuddyTools,
  toFunctionDefs,
} from "./index";
import { TIPS_ID } from "./mirror";

const FORGE_EVM = "0x5274e1499d145d6f4984661203bf65c2bed7f8ce";
const FORGE_ACCOUNT = `0.0.${BigInt(FORGE_EVM).toString()}`;
const OPERATOR_EVM = "0x0000000000000000000000000000000000000001";

function resolvePageResult(): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["address", "string", "uint8", "address", "string"],
    [FORGE_EVM, "QmTestHash", 1, OPERATOR_EVM, "test purpose"]
  );
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voicescape Agent Kit plugin", () => {
  it("exposes exactly three QUERY tools (read-only by construction)", () => {
    const tools = getBuddyTools();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.toolType).toBe(TOOL_TYPE.QUERY);
    }
  });

  it("keeps stable model-facing function names", () => {
    const tools = getBuddyTools();
    expect(tools.map((t) => functionNameFor(t.method))).toEqual([
      "resolve_blockpage",
      "verify_tip",
      "treasury_stats",
    ]);
  });

  it("derives OpenAI function defs from the kit tools' zod schemas", () => {
    const tools = getBuddyTools();
    const defs: any[] = toFunctionDefs(tools);
    expect(defs.map((d) => d.function.name)).toEqual([
      "resolve_blockpage",
      "verify_tip",
      "treasury_stats",
    ]);
    const lookup: any = defs[0].function.parameters;
    expect(lookup.type).toBe("object");
    expect(lookup.properties.username.type).toBe("string");
    expect(lookup.required).toEqual(["username"]);
    const treasury: any = defs[2].function.parameters;
    expect(treasury.properties.hoursBack.default).toBe(24);
  });

  it("findTool resolves a tool by its function name", () => {
    const tools = getBuddyTools();
    expect(findTool(tools, "verify_tip")?.method).toBe("verify_tip_tool");
    expect(findTool(tools, "nope")).toBeUndefined();
  });

  it("executes lookup_blockpage_tool against the mirror node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        expect(String(url)).toContain("/contracts/call");
        return jsonResponse({ result: resolvePageResult() });
      })
    );
    const tools = getBuddyTools();
    const tool = findTool(tools, "resolve_blockpage")!;
    const out = await tool.execute(
      undefined as never,
      {},
      tool.parameters.parse({ username: "forge" })
    );
    const result = JSON.parse(out);
    expect(result.registered).toBe(true);
    expect(result.ownerAccountId).toBe(FORGE_ACCOUNT);
    expect(result.ownerType).toBe("AGENT");
    expect(result.purpose).toBe("test purpose");
  });

  it("reports unregistered usernames via CONTRACT_REVERT_EXECUTED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => "CONTRACT_REVERT_EXECUTED",
      }))
    );
    const tools = getBuddyTools();
    const tool = findTool(tools, "resolve_blockpage")!;
    const out = await tool.execute(
      undefined as never,
      {},
      tool.parameters.parse({ username: "nobody-here" })
    );
    const result = JSON.parse(out);
    expect(result.registered).toBe(false);
    expect(result.ownerAccountId).toBeNull();
  });

  it("executes treasury_stats_tool against the contract-results endpoint", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        seen.push(String(url));
        return jsonResponse({
          results: [
            {
              to: "0x00000000000000000000000000000000000a59eac",
              amount: 200000000,
              function_parameters: "0x12345678",
              timestamp: "1789480000.000000000",
            },
          ],
        });
      })
    );
    const tools = getBuddyTools();
    const tool = findTool(tools, "treasury_stats")!;
    const out = await tool.execute(
      undefined as never,
      {},
      tool.parameters.parse({})
    );
    const result = JSON.parse(out);
    expect(result.directCalls).toBe(1);
    expect(result.totalHbar).toBe(2);
    expect(seen[0]).toContain(`/contracts/${TIPS_ID}/results`);
  });
});
