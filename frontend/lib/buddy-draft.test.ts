import { describe, expect, it } from "vitest";
import { extractPageDraft, stripPageDraft } from "./buddy-draft";

const PAGE = {
  version: 1,
  username: "test-user",
  theme: {
    background: "#0b0b12",
    foreground: "#ffffff",
    accent: "#8259ef",
    fontFamily: "system-ui",
  },
  blocks: [
    { type: "hero", title: "Test", avatarImage: "https://ipfs.io/ipfs/QmX" },
    { type: "bio", text: "hello" },
  ],
};

describe("extractPageDraft", () => {
  it("extracts a valid page from a ```json fenced block", () => {
    const content = `Your page is ready! Tap below.\n\n\`\`\`json\n${JSON.stringify(PAGE)}\n\`\`\``;
    const draft = extractPageDraft(content);
    expect(draft).not.toBeNull();
    expect(draft?.username).toBe("test-user");
    expect(draft?.blocks).toHaveLength(2);
  });

  it("returns null when there is no fenced block", () => {
    expect(extractPageDraft("just a normal reply")).toBeNull();
  });

  it("returns null when the JSON does not parse", () => {
    expect(extractPageDraft("```json\n{not json\n```")).toBeNull();
  });

  it("returns null when the JSON is not a valid page", () => {
    const bad = { version: 1, username: "x", blocks: [{ type: "nope" }] };
    expect(extractPageDraft(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``)).toBeNull();
  });

  it("returns null for a non-json fenced block", () => {
    expect(extractPageDraft("```\nplain code\n```")).toBeNull();
  });
});

describe("stripPageDraft", () => {
  it("removes the fenced block and leaves the prose", () => {
    const content = `Your page is ready!\n\n\`\`\`json\n${JSON.stringify(PAGE)}\n\`\`\``;
    expect(stripPageDraft(content)).toBe("Your page is ready!");
  });

  it("leaves content without a draft untouched", () => {
    expect(stripPageDraft("hello")).toBe("hello");
  });

  it("strips a TRUNCATED (unclosed) fence so no raw JSON leaks — live failure 2026-09-16", () => {
    // The model hit max tokens mid-JSON: the fence never closed and the
    // reply ended mid-string. extractPageDraft returns null (can't parse)
    // and the old strip left the raw JSON visible in chat.
    const truncated =
      "Here's your free preview! ```json\n" +
      '{"version": 1, "username": "e2epreview03", "theme": {"background": "#1e1e1e"}, "blocks": [{"type": "hero", "title": "E2EPreview03"}, {"type": "top8", "friends": [{"name": "H';
    expect(extractPageDraft(truncated)).toBeNull();
    const stripped = stripPageDraft(truncated);
    expect(stripped).not.toContain('"version": 1');
    expect(stripped).not.toContain("```json");
    expect(stripped).toBe("Here's your free preview!");
  });

  it("strips a truncated fence even with the route's cut-short note appended", () => {
    const truncated =
      "```json\n" + '{"version": 1, "username": "x", "blocks": [{"type": "hero"';
    const withNote = truncated + " (note: my answer was cut short)";
    expect(stripPageDraft(withNote)).toBe("");
  });

  it("strips multiple fenced blocks, not just the first", () => {
    const content =
      `prose\n\`\`\`json\n${JSON.stringify(PAGE)}\n\`\`\`\nmore prose\n\`\`\`json\n${JSON.stringify(PAGE)}\n\`\`\``;
    const stripped = stripPageDraft(content);
    expect(stripped).not.toContain("```json");
    expect(stripped).not.toContain('"version": 1');
  });
});
