import { describe, expect, it } from "vitest";
import { firstStackFrame, scrubFrame } from "./client-error-frame";

describe("firstStackFrame", () => {
  it("extracts a V8 frame with function, file basename, line and col", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'call')",
      "    at approveSessionRequest (https://voicescape.vercel.app/_next/static/chunks/485.js:1:2345)",
      "    at foo (https://x/bar.js:2:3)",
    ].join("\n");
    expect(firstStackFrame(stack)).toBe("at approveSessionRequest (485.js:1:2345)");
  });

  it("handles anonymous V8 frames", () => {
    const stack = ["Error: x", "    at https://voicescape.vercel.app/_next/static/chunks/1.js:10:20"].join("\n");
    expect(firstStackFrame(stack)).toBe("at 1.js:10:20");
  });

  it("handles Firefox-style frames", () => {
    const stack = ["foo@https://voicescape.vercel.app/static/app.js:5:6", "bar@https://x/y.js:1:1"].join("\n");
    expect(firstStackFrame(stack)).toBe("at foo (app.js:5:6)");
  });

  it("scrubs wallet addresses and account IDs from frames", () => {
    const stack = [
      "Error: 0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0 failed",
      "    at tip (https://x/c.js:1:2)",
    ].join("\n");
    const f = firstStackFrame(stack);
    expect(f).not.toContain("0x571D");
    expect(f).toContain("at tip (c.js:1:2)");
  });

  it("returns null for missing or unparseable stacks", () => {
    expect(firstStackFrame(null)).toBeNull();
    expect(firstStackFrame("")).toBeNull();
    expect(firstStackFrame("just a message")).toBeNull();
  });
});

describe("scrubFrame", () => {
  it("scrubs 0.0.x account ids", () => {
    expect(scrubFrame("at f (a.js:1:2) for 0.0.10424063")).toBe("at f (a.js:1:2) for 0.0.…");
  });
});
