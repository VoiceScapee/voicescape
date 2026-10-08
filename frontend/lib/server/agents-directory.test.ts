/**
 * agents-directory regression tests.
 *
 * Root cause (2026-10-08): /api/agents returned count 0 while the registry
 * held live agent registrations. contractIdString() ran the registry's EVM
 * address through ContractId.fromEvmAddress(0, 0, a).toString(), which for
 * the non-long-zero (CREATE-deployed) registry produced the bogus id
 * "0.0.d87f8113c5bcc47c40dc26a43ffa9b1629385a58". The mirror node 200s on
 * that phantom id, so the results scan silently found nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";

import {
  buildAgentDirectory,
  clearDirectoryCache,
  contractIdString,
  decodeRegisterCalldata,
} from "./agents-directory";

const EVM_REGISTRY = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const MIRROR = "https://mainnet.mirrornode.hedera.com";

const ABI = [
  "function registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)",
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
];
const iface = new ethers.Interface(ABI);

const AGENT = {
  username: "test-agent-1",
  ipfsHash: "QmTestPageHash123",
  owner: "0x1111111111111111111111111111111111111111",
  operator: "0x2222222222222222222222222222222222222222",
  purpose: "A test agent for the directory regression suite.",
};

// Second agent: registered WITHOUT disclosing an operator (the
// bacon-the-dino case). Brandon's call 2026-10-08: show all agents.
const AGENT_NO_OPERATOR = {
  username: "test-agent-2",
  ipfsHash: "QmTestPageHash456",
  owner: "0x3333333333333333333333333333333333333333",
  operator: "0x0000000000000000000000000000000000000000",
  purpose: "An agent that did not disclose an operator.",
};

const AGENTS = [AGENT, AGENT_NO_OPERATOR];

function registerCalldata(a: typeof AGENT): string {
  return iface.encodeFunctionData("registerPage", [
    a.username,
    a.ipfsHash,
    1,
    a.operator,
    a.purpose,
  ]);
}

function resolveResult(a: typeof AGENT): string {
  return iface.encodeFunctionResult("resolvePage", [
    a.owner,
    a.ipfsHash,
    1,
    a.operator,
    a.purpose,
  ]);
}

describe("contractIdString", () => {
  it("passes a non-long-zero EVM address through unchanged", () => {
    expect(contractIdString(EVM_REGISTRY)).toBe(EVM_REGISTRY);
  });

  it("passes long-zero EVM addresses through unchanged too", () => {
    // The mirror node accepts long-zero form directly; no 0.0.N rewrite needed.
    expect(
      contractIdString("0x0000000000000000000000000000000000002b5e"),
    ).toBe("0x0000000000000000000000000000000000002b5e");
  });

  it("passes 0.0.N ids through unchanged", () => {
    expect(contractIdString("0.0.10854058")).toBe("0.0.10854058");
  });

  it("rejects garbage instead of building a phantom mirror query", () => {
    expect(() => contractIdString("not-an-address")).toThrow(
      /Invalid registry address/,
    );
  });

  it("never emits the bogus 0.0.<hex> form for the production registry", () => {
    expect(contractIdString(EVM_REGISTRY)).not.toMatch(/^0\.0\.[0-9a-f]{40}$/);
  });
});

describe("decodeRegisterCalldata", () => {
  it("decodes a real registerPage call", () => {
    const d = decodeRegisterCalldata(registerCalldata(AGENT));
    expect(d).not.toBeNull();
    expect(d!.username).toBe(AGENT.username);
    expect(d!.ownerType).toBe(1);
    expect(d!.operator.toLowerCase()).toBe(AGENT.operator.toLowerCase());
  });
});

describe("buildAgentDirectory with an EVM-address registry", () => {
  const requestedUrls: string[] = [];

  beforeEach(() => {
    clearDirectoryCache();
    requestedUrls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { method?: string }) => {
        const u = String(url);
        requestedUrls.push(u);
        if (u.includes("/api/v1/contracts/") && u.includes("/results?")) {
          return {
            ok: true,
            json: async () => ({
              results: AGENTS.map((a, i) => ({
                result: "SUCCESS",
                function_parameters: registerCalldata(a),
                timestamp: `178900000${i}.000000000`,
              })),
              links: { next: null },
            }),
          };
        }
        if (u.endsWith("/api/v1/contracts/call")) {
          expect(init?.method).toBe("POST");
          const posted = JSON.parse(String((init as any)?.body ?? "{}"));
          const decoded = iface.decodeFunctionData(
            "resolvePage",
            posted.data as string,
          );
          const agent =
            AGENTS.find((a) => a.username === decoded[0]) ?? AGENT;
          return {
            ok: true,
            json: async () => ({ result: resolveResult(agent) }),
          };
        }
        const ipfsAgent = AGENTS.find((a) => u.includes(a.ipfsHash));
        if (ipfsAgent) {
          return {
            ok: true,
            json: async () => ({
              services: [
                {
                  name: "test-service",
                  description: "does tests",
                  priceHbar: "0.5",
                },
              ],
              capabilities: ["testing"],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDirectoryCache();
  });

  it("queries the mirror node at the real EVM address and lists the agent", async () => {
    const dir = await buildAgentDirectory("example.com", {});
    const resultsUrl = requestedUrls.find((u) => u.includes("/results?"));
    expect(resultsUrl).toBeDefined();
    // The regression: the old code requested the phantom
    // /contracts/0.0.d87f8113.../results and found nothing.
    expect(resultsUrl).toContain(`/contracts/${EVM_REGISTRY}/results`);
    expect(resultsUrl).not.toContain("0.0.d87f");

    expect(dir.count).toBe(2);
    expect(dir.agents[0].username).toBe(AGENT.username);
    expect(dir.agents[0].operator?.toLowerCase()).toBe(
      AGENT.operator.toLowerCase(),
    );
    expect(dir.agents[0].purpose).toBe(AGENT.purpose);
    expect(dir.registry).toBe(EVM_REGISTRY);
  });

  it("lists an agent that did not disclose an operator, with operator null", async () => {
    const dir = await buildAgentDirectory("example.com", {});
    const undisclosed = dir.agents.find(
      (a) => a.username === AGENT_NO_OPERATOR.username,
    );
    expect(undisclosed).toBeDefined();
    expect(undisclosed!.operator).toBeNull();
    expect(undisclosed!.purpose).toBe(AGENT_NO_OPERATOR.purpose);
  });
});
