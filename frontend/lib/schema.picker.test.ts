/**
 * Quick-build (2026-09-29) picker tests: the Add-block picker shows one
 * smart "Links & socials" entry and hides types that duplicate another
 * block's job or serve no first-timer job. The schema (BLOCK_TYPES) and the
 * renderers keep every type — existing pages render identically.
 */
import { describe, expect, it } from "vitest";
import { BLOCK_TYPES, PICKER_BLOCK_TYPES, PICKER_LABELS, type BlockType } from "./schema";

const HIDDEN: BlockType[] = [
  "links",
  "top8",
  "chat",
  "badges",
  "tabs",
  "operator",
  "capabilities",
];

describe("PICKER_BLOCK_TYPES", () => {
  it("hides only the redundant types, keeps everything else", () => {
    expect([...PICKER_BLOCK_TYPES].sort()).toEqual(
      BLOCK_TYPES.filter((t) => !(HIDDEN as string[]).includes(t)).sort(),
    );
  });

  it("is a subset of the schema's BLOCK_TYPES (renderers unchanged)", () => {
    for (const t of PICKER_BLOCK_TYPES) {
      expect(BLOCK_TYPES).toContain(t);
    }
  });

  it("keeps links in the schema for backward compatibility", () => {
    expect(BLOCK_TYPES).toContain("links");
    expect(PICKER_BLOCK_TYPES).not.toContain("links");
  });

  it("still offers the core first-timer blocks", () => {
    for (const t of ["hero", "bio", "socials", "tipJar", "guestbook", "music", "gallery"] as const) {
      expect(PICKER_BLOCK_TYPES).toContain(t);
    }
  });
});

describe("PICKER_LABELS", () => {
  it("labels socials as Links & socials", () => {
    expect(PICKER_LABELS.socials).toBe("🔗 Links & socials");
  });
});
