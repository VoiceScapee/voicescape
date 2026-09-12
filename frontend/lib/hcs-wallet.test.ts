import { describe, expect, it } from "vitest";
import { assertHcsMessageFits, MAX_HCS_MESSAGE_BYTES } from "./hcs-wallet";

describe("assertHcsMessageFits", () => {
  it("accepts a small message and returns the JSON", () => {
    const json = assertHcsMessageFits({ v: 1, kind: "post", text: "hi" });
    expect(json).toBe(JSON.stringify({ v: 1, kind: "post", text: "hi" }));
  });

  it("accepts a message exactly at the cap", () => {
    const filler = "x".repeat(MAX_HCS_MESSAGE_BYTES - JSON.stringify({ t: "" }).length);
    expect(() => assertHcsMessageFits({ t: filler })).not.toThrow();
  });

  it("throws a user-friendly error for an oversized message", () => {
    const tooLong = "x".repeat(MAX_HCS_MESSAGE_BYTES + 1);
    expect(() => assertHcsMessageFits({ t: tooLong })).toThrow(
      /too long.*shorten your message/i,
    );
  });
});
