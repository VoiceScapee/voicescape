/**
 * BYOK (bring-your-own-key) tests.
 *
 * The guarantees under test:
 * 1. The user's Anthropic key lives ONLY in browser localStorage.
 * 2. Generations call api.anthropic.com DIRECTLY — never our server,
 *    so no server-side AI spend can happen on any user-triggered path.
 * 3. Friendly, honest errors for missing keys, rejected keys, and bad model output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BYOK_STORAGE_KEY,
  ByokError,
  clearByokKey,
  DEFAULT_BYOK_MODEL,
  generatePageWithByokKey,
  getByokKey,
  hasByokKey,
  setByokKey,
  VIBECODE_SYSTEM_PROMPT,
} from "./byok";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const VALID_PAGE = {
  version: 1,
  username: "demo-user",
  theme: {
    background: "#000",
    foreground: "#fff",
    accent: "#0ff",
    fontFamily: "sans-serif",
  },
  blocks: [{ type: "hero", title: "Hello" }],
};

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text }] }),
    text: async () => text,
  } as Response;
}

beforeEach(() => {
  // In-memory localStorage shim (vitest runs in node here).
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    },
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BYOK key storage (browser localStorage only)", () => {
  it("round-trips set/get/has/clear under the voicescape key", () => {
    expect(hasByokKey()).toBe(false);
    expect(getByokKey()).toBeNull();
    setByokKey("sk-ant-api-test-123");
    expect(hasByokKey()).toBe(true);
    expect(getByokKey()).toBe("sk-ant-api-test-123");
    clearByokKey();
    expect(hasByokKey()).toBe(false);
    expect(getByokKey()).toBeNull();
  });

  it("trims whitespace and rejects empty keys", () => {
    setByokKey("  sk-ant-api-abc  ");
    expect(getByokKey()).toBe("sk-ant-api-abc");
    expect(() => setByokKey("   ")).toThrow(ByokError);
  });

  it("uses a voicescape-namespaced key, not a generic one", () => {
    expect(BYOK_STORAGE_KEY).toContain("vs-");
    setByokKey("k");
    expect((window as unknown as { localStorage: Storage }).localStorage.getItem(BYOK_STORAGE_KEY)).toBe("k");
  });
});

describe("generatePageWithByokKey (direct browser → Anthropic)", () => {
  it("calls api.anthropic.com directly with the user's key — never our server", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(okResponse(JSON.stringify(VALID_PAGE)));

    const page = await generatePageWithByokKey({
      pageJson: VALID_PAGE,
      instruction: "make it neon",
      apiKey: "sk-ant-api-user-key",
    });

    expect(page.username).toBe("demo-user");
    // Exactly one network call, straight to Anthropic — nothing to our origin.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_URL);
    expect(url).not.toContain("/api/");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api-user-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // Anthropic's documented opt-in header for direct browser access.
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init.body as string) as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe(DEFAULT_BYOK_MODEL);
    expect(body.system).toBe(VIBECODE_SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain("make it neon");
  });

  it("throws a friendly error when no key is set", async () => {
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "  " }),
    ).rejects.toThrow(ByokError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("throws a key-specific error on 401", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid x-api-key",
    } as Response);
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "bad-key" }),
    ).rejects.toThrow(/rejected your API key/);
  });

  it("attributes billing/rate errors to Anthropic, not us", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate_limit_error",
    } as Response);
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "k" }),
    ).rejects.toThrow(/between you and Anthropic/);
  });

  it("rejects non-JSON model output without touching our server", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse("not json at all"));
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "k" }),
    ).rejects.toThrow(/valid JSON/);
  });

  it("rejects schema-invalid model output", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse(JSON.stringify({ version: 1 })));
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "k" }),
    ).rejects.toThrow(/page schema/);
  });

  it("rejects empty model output", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse(""));
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "k" }),
    ).rejects.toThrow(/no text content/);
  });

  it("wraps network failures in a friendly error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      generatePageWithByokKey({ pageJson: VALID_PAGE, instruction: "hi", apiKey: "k" }),
    ).rejects.toThrow(/Could not reach api\.anthropic\.com/);
  });
});
