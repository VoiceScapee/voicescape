/**
 * normalizeBlockForRender tests for the heartbeat and tabs blocks.
 */
import { describe, expect, it } from "vitest";
import { normalizeBlockForRender } from "./schema";

describe("heartbeat block", () => {
  it("normalizes to a heartbeat block", () => {
    expect(normalizeBlockForRender({ type: "heartbeat" })).toEqual({
      type: "heartbeat",
    });
  });

  it("drops unknown fields", () => {
    expect(
      normalizeBlockForRender({ type: "heartbeat", wallet: "0xabc", fake: 1 }),
    ).toEqual({ type: "heartbeat" });
  });
});

describe("tabs block", () => {
  it("normalizes nested blocks recursively", () => {
    const out = normalizeBlockForRender({
      type: "tabs",
      tabs: [
        { label: "Proof", blocks: [{ type: "heartbeat" }] },
        { label: "Badges", blocks: [{ type: "bio", text: "HUMAN · FOUNDER" }] },
      ],
    });
    expect(out).toEqual({
      type: "tabs",
      tabs: [
        { label: "Proof", blocks: [{ type: "heartbeat" }] },
        { label: "Badges", blocks: [{ type: "bio", text: "HUMAN · FOUNDER" }] },
      ],
    });
  });

  it("caps tabs at 4 and nested blocks at 8", () => {
    const blocks = Array.from({ length: 20 }, () => ({ type: "bio", text: "x" }));
    const tabs = Array.from({ length: 6 }, (_, i) => ({
      label: `T${i}`,
      blocks,
    }));
    const out = normalizeBlockForRender({ type: "tabs", tabs }) as {
      type: string;
      tabs: { blocks: unknown[] }[];
    };
    expect(out.tabs).toHaveLength(4);
    expect(out.tabs[0].blocks).toHaveLength(8);
  });

  it("drops empty tabs and returns null when none survive", () => {
    const out = normalizeBlockForRender({
      type: "tabs",
      tabs: [
        { label: "Empty", blocks: [] },
        { label: "Junk", blocks: [{ type: "nope" }] },
      ],
    });
    expect(out).toBeNull();
  });

  it("caps labels at 24 chars and defaults missing labels", () => {
    const out = normalizeBlockForRender({
      type: "tabs",
      tabs: [{ blocks: [{ type: "bio", text: "x" }] }],
    }) as { tabs: { label: string }[] };
    expect(out.tabs[0].label).toBe("Tab");
    const long = normalizeBlockForRender({
      type: "tabs",
      tabs: [{ label: "x".repeat(100), blocks: [{ type: "bio", text: "x" }] }],
    }) as { tabs: { label: string }[] };
    expect(long.tabs[0].label).toHaveLength(24);
  });

  it("rejects non-array tabs", () => {
    expect(normalizeBlockForRender({ type: "tabs" })).toBeNull();
    expect(normalizeBlockForRender({ type: "tabs", tabs: "nope" })).toBeNull();
  });
});

describe("badges block", () => {
  it("normalizes items", () => {
    expect(
      normalizeBlockForRender({ type: "badges", items: ["HUMAN", "FOUNDER"] }),
    ).toEqual({ type: "badges", items: ["HUMAN", "FOUNDER"] });
  });

  it("trims, caps length at 24 and count at 8, drops empties", () => {
    const items = ["  ok  ", "", "x".repeat(40), ...Array.from({ length: 10 }, (_, i) => `b${i}`)];
    const out = normalizeBlockForRender({ type: "badges", items }) as {
      items: string[];
    };
    expect(out.items[0]).toBe("ok");
    expect(out.items[1]).toHaveLength(24);
    expect(out.items).toHaveLength(8);
  });

  it("returns null when no items survive", () => {
    expect(normalizeBlockForRender({ type: "badges", items: [] })).toBeNull();
    expect(normalizeBlockForRender({ type: "badges" })).toBeNull();
  });
});

describe("hero block badges", () => {
  it("keeps page-authored hero badges", () => {
    expect(
      normalizeBlockForRender({ type: "hero", title: "Brandon", badges: ["HUMAN"] }),
    ).toEqual({ type: "hero", title: "Brandon", badges: ["HUMAN"] });
  });

  it("trims, drops empties, and caps hero badges at 4", () => {
    const out = normalizeBlockForRender({
      type: "hero",
      title: "Brandon",
      badges: [" HUMAN ", "", 42, "A".repeat(40), "b", "c", "d", "e"],
    }) as { badges?: string[] };
    expect(out.badges).toEqual(["HUMAN", "A".repeat(24), "b", "c"]);
  });

  it("omits badges when none survive", () => {
    expect(
      normalizeBlockForRender({ type: "hero", title: "Brandon", badges: ["  "] }),
    ).toEqual({ type: "hero", title: "Brandon" });
  });
});
