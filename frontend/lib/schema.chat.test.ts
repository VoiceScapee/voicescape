/**
 * Chat block schema tests.
 *
 * Pure-function tests: the "chat" block is registered in BLOCK_TYPES,
 * createDefaultBlock builds it, and isValidPage accepts/rejects it.
 */
import { describe, expect, it } from "vitest";
import { BLOCK_TYPES, createDefaultBlock, isValidPage } from "./schema";

function basePage(blocks: unknown[]) {
  return {
    version: 1,
    username: "test-user",
    theme: { background: "#000", foreground: "#fff", accent: "#f0f", fontFamily: "sans" },
    blocks,
  };
}

describe("chat block schema", () => {
  it("is registered in BLOCK_TYPES", () => {
    expect((BLOCK_TYPES as readonly string[])).toContain("chat");
  });

  it("createDefaultBlock returns a chat block with a title", () => {
    const b = createDefaultBlock("chat");
    expect(b).toEqual({ type: "chat", title: "Chat" });
  });

  it("isValidPage accepts a well-formed chat block", () => {
    expect(isValidPage(basePage([{ type: "chat" }]))).toBe(true);
    expect(isValidPage(basePage([{ type: "chat", title: "Stream chat" }]))).toBe(true);
  });

  it("isValidPage rejects a non-string chat title", () => {
    expect(isValidPage(basePage([{ type: "chat", title: 42 }]))).toBe(false);
  });

  it("isValidPage still rejects unknown block types", () => {
    expect(isValidPage(basePage([{ type: "chatroom" }]))).toBe(false);
  });
});
