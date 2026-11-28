import { describe, expect, it } from "vitest";
import { withUtf8Charset } from "./http-charset";

describe("withUtf8Charset", () => {
  it("adds charset=utf-8 to a charset-less SSE response, keeping the body", async () => {
    const res = withUtf8Charset(
      new Response("data: {\"a\":\"—\"}\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await res.text()).toContain("—");
  });

  it("adds charset=utf-8 to a charset-less JSON response", async () => {
    const res = withUtf8Charset(
      new Response(JSON.stringify({ s: "—" }), { headers: { "content-type": "application/json" } }),
    );
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect((await res.json() as { s: string }).s).toBe("—");
  });

  it("leaves a response that already names a charset untouched", () => {
    const res = withUtf8Charset(
      new Response("{}", { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("leaves non-text/json responses untouched", () => {
    const res = withUtf8Charset(
      new Response("<html/>", { headers: { "content-type": "text/html" } }),
    );
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it("simulates a header-decoding client: latin-1 without charset mojibakes, utf-8 with charset does not", () => {
    const body = "—"; // U+2014, UTF-8 bytes E2 80 94
    const bytes = Buffer.from(body, "utf8");
    // requests/httpx default a charset-less text/* response to ISO-8859-1,
    // so each UTF-8 byte becomes its own codepoint — the dash is lost.
    const decoded = bytes.toString("latin1");
    expect(decoded).not.toBe("—");
    expect(decoded.codePointAt(0)).toBe(0xe2);
    expect(decoded.codePointAt(1)).toBe(0x80);
    expect(decoded.codePointAt(2)).toBe(0x94);
    // With charset=utf-8 the same bytes decode correctly.
    expect(bytes.toString("utf8")).toBe("—");
  });
});
