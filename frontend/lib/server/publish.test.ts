/**
 * lib/server/publish.js size-cap tests: publishPageJson must throw
 * "page JSON too large" before any network call when the document exceeds
 * PIN_MAX_PAGE_JSON_BYTES (default 1,048,576). No network, no Pinata.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PAGE_JSON_BYTES,
  maxPageJsonBytes,
  publishPageJson,
} from "./publish.js";

const SMALL_PAGE = { version: 1, username: "brandon", blocks: [] };

function bigPage(paddingChars: number) {
  return {
    version: 1,
    username: "brandon",
    blocks: [{ type: "bio", text: "x".repeat(paddingChars) }],
  };
}

afterEach(() => {
  delete process.env.PIN_MAX_PAGE_JSON_BYTES;
});

describe("maxPageJsonBytes", () => {
  it("defaults to 1,048,576 (1 MB)", () => {
    expect(maxPageJsonBytes()).toBe(1_048_576);
    expect(DEFAULT_MAX_PAGE_JSON_BYTES).toBe(1_048_576);
  });

  it("follows PIN_MAX_PAGE_JSON_BYTES when set", () => {
    process.env.PIN_MAX_PAGE_JSON_BYTES = "2048";
    expect(maxPageJsonBytes()).toBe(2048);
  });
});

describe("publishPageJson size cap", () => {
  it("throws 'page JSON too large' for an oversized document — before any network/PINATA check", async () => {
    process.env.PIN_MAX_PAGE_JSON_BYTES = "100";
    await expect(publishPageJson(bigPage(10_000))).rejects.toThrow(/page JSON too large/);
  });

  it("throws the oversized error even when the page is otherwise valid and PINATA_JWT is missing", async () => {
    process.env.PIN_MAX_PAGE_JSON_BYTES = "100";
    const err = await publishPageJson(bigPage(10_000)).catch((e: unknown) => e);
    expect(String(err)).toMatch(/page JSON too large/);
    expect(String(err)).not.toMatch(/PINATA_JWT/);
  });

  it("passes the size check for a small page (fails later on the missing PINATA_JWT, not on size)", async () => {
    await expect(publishPageJson(SMALL_PAGE)).rejects.toThrow(/PINATA_JWT is not set/);
  });

  it("a page just under the configured cap passes the size check", async () => {
    // Under the 100-byte cap: hits the PINATA_JWT check instead of size.
    const page = { version: 1, username: "b", blocks: [] };
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    expect(bytes).toBeLessThan(100);
    process.env.PIN_MAX_PAGE_JSON_BYTES = "100";
    await expect(publishPageJson(page)).rejects.toThrow(/PINATA_JWT is not set/);
  });
});
