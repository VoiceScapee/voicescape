/**
 * GET /api/landing/fresh — recently-published blockpages from registry transactions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";

vi.mock("@/lib/contracts", () => ({
  resolvePage: vi.fn(),
  getRegistryAddress: vi.fn(() => "0.0.10854058"),
}));
vi.mock("@/lib/ipfs", () => ({
  fetchPageJson: vi.fn(),
}));
vi.mock("@/lib/server/townhall/topics", () => ({
  mirrorBaseUrl: vi.fn(() => "https://mainnet.mirrornode.hedera.com"),
}));

import { resolvePage } from "@/lib/contracts";
import { fetchPageJson } from "@/lib/ipfs";
import { GET } from "./route";

const resolvePageMock = vi.mocked(resolvePage);
const fetchPageJsonMock = vi.mocked(fetchPageJson);

const coder = new ethers.AbiCoder();
const SELECTOR = ethers.id("registerPage(string,string,uint8,address,string)").slice(2, 10);

function registerCalldata(username: string, ownerType: number): string {
  return (
    "0x" +
    SELECTOR +
    coder
      .encode(
        ["string", "string", "uint8", "address", "string"],
        [username, "QmHash", ownerType, "0x0000000000000000000000000000000000000001", "purpose"],
      )
      .slice(2)
  );
}

function mirrorResults(
  results: { function_parameters?: string; error_message?: string | null; timestamp?: string }[],
) {
  return { results, links: { next: null } };
}

const pageJson = (title: string) =>
  JSON.stringify({ blocks: [{ type: "hero", title, avatarEmoji: "🦎" }] });

function stubMirror(results: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => results })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resolvePageMock.mockImplementation(async (username: string) => ({
    owner: "0x0000000000000000000000000000000000000001",
    ipfsHash: `Qm${username}`,
    ownerType: username === "thechomps" ? 1 : 0,
    operator: "0x0000000000000000000000000000000000000000",
    purpose: "",
  }));
  fetchPageJsonMock.mockImplementation(async (hash: string) => pageJson(`Title ${hash}`));
});

describe("GET /api/landing/fresh", () => {
  it("returns recent registrations newest-first with decoded usernames", async () => {
    stubMirror(
      mirrorResults([
        {
          function_parameters: registerCalldata("thechomps", 1),
          error_message: null,
          timestamp: "1791480000.000000000",
        },
        {
          function_parameters: registerCalldata("informinmotion", 0),
          error_message: null,
          timestamp: "1791390000.000000000",
        },
      ]),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pages: { username: string; ownerType: number }[] };
    expect(json.pages.map((p) => p.username)).toEqual(["thechomps", "informinmotion"]);
    expect(json.pages[0]?.ownerType).toBe(1);
    expect(json.pages[1]?.ownerType).toBe(0);
  });

  it("skips failed calls, non-register calls, and undecodable calldata", async () => {
    stubMirror(
      mirrorResults([
        {
          function_parameters: registerCalldata("goodpage", 0),
          error_message: null,
          timestamp: "1791480000.000000000",
        },
        {
          function_parameters: registerCalldata("failedpage", 0),
          error_message: "revert",
          timestamp: "1791480001.000000000",
        },
        {
          // some other contract function (wrong selector)
          function_parameters: "0x12345678" + "00".repeat(64),
          error_message: null,
          timestamp: "1791480002.000000000",
        },
        {
          // right selector, garbage body
          function_parameters: "0x" + SELECTOR + "zzzz",
          error_message: null,
          timestamp: "1791480003.000000000",
        },
      ]),
    );
    const res = await GET();
    const json = (await res.json()) as { pages: { username: string }[] };
    expect(json.pages.map((p) => p.username)).toEqual(["goodpage"]);
  });

  it("dedupes re-registrations keeping the latest, and excludes curated pages", async () => {
    stubMirror(
      mirrorResults([
        {
          function_parameters: registerCalldata("repag", 0),
          error_message: null,
          timestamp: "1791480000.000000000",
        },
        {
          function_parameters: registerCalldata("repag", 0),
          error_message: null,
          timestamp: "1791390000.000000000",
        },
        {
          function_parameters: registerCalldata("forge", 1),
          error_message: null,
          timestamp: "1791480001.000000000",
        },
      ]),
    );
    const res = await GET();
    const json = (await res.json()) as {
      pages: { username: string; registeredAt: number }[];
    };
    expect(json.pages.map((p) => p.username)).toEqual(["repag"]);
    expect(json.pages[0]?.registeredAt).toBe(1791480000);
  });

  it("fails open to an empty list when the mirror node errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("mirror down");
      }),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pages: unknown[] };
    expect(json.pages).toEqual([]);
  });

  it("still lists a page when IPFS resolution fails", async () => {
    stubMirror(
      mirrorResults([
        {
          function_parameters: registerCalldata("nometa", 0),
          error_message: null,
          timestamp: "1791480000.000000000",
        },
      ]),
    );
    resolvePageMock.mockResolvedValue(null as never);
    const res = await GET();
    const json = (await res.json()) as {
      pages: { username: string; displayName: string }[];
    };
    expect(json.pages.map((p) => p.username)).toEqual(["nometa"]);
    expect(json.pages[0]?.displayName).toBe("@nometa");
  });
});
