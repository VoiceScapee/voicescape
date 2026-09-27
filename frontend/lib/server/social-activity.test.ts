/**
 * lib/server/social-activity tests: the capped, TTL'd bot-post log.
 *
 * The module reads through getKvStore()'s process-wide singleton, which
 * falls back to the in-memory store in this test env (no VALKEY_URL /
 * UPSTASH vars set). Tests seed through the same singleton and reset it
 * between tests for isolation.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  getKvStore,
  resetKvStoreSingleton,
} from "@/lib/server/store";
import {
  SOCIAL_ACTIVITY_KEY,
  SOCIAL_ACTIVITY_MAX,
  SOCIAL_ACTIVITY_TTL_MS,
  logSocialPost,
  readSocialActivity,
} from "@/lib/server/social-activity";

beforeEach(() => {
  resetKvStoreSingleton();
});

describe("logSocialPost / readSocialActivity", () => {
  it("reads empty when nothing was ever posted", async () => {
    expect(await readSocialActivity()).toEqual([]);
  });

  it("stores newest-first", async () => {
    await logSocialPost("x", "first post");
    await logSocialPost("discord", "second post");
    const events = await readSocialActivity();
    expect(events).toHaveLength(2);
    expect(events[0].platform).toBe("discord");
    expect(events[1].platform).toBe("x");
    expect(typeof events[0].ts).toBe("string");
    expect(events[0].summary).toBe("second post");
  });

  it("truncates long summaries to 140 chars", async () => {
    await logSocialPost("x", "a".repeat(500));
    const events = await readSocialActivity();
    expect(events[0].summary).toHaveLength(140);
  });

  it("caps the stored list at SOCIAL_ACTIVITY_MAX, newest first", async () => {
    for (let i = 0; i < SOCIAL_ACTIVITY_MAX + 10; i++) {
      await logSocialPost("x", `post ${i}`);
    }
    const raw = await getKvStore().get(SOCIAL_ACTIVITY_KEY);
    const arr = JSON.parse(raw ?? "[]");
    expect(arr).toHaveLength(SOCIAL_ACTIVITY_MAX);
    expect(arr[0].summary).toBe(`post ${SOCIAL_ACTIVITY_MAX + 9}`);
    expect(await readSocialActivity(1000)).toHaveLength(SOCIAL_ACTIVITY_MAX);
  });

  it("treats a corrupt stored value as empty, not a crash", async () => {
    await getKvStore().set(
      SOCIAL_ACTIVITY_KEY,
      "not json{{{",
      SOCIAL_ACTIVITY_TTL_MS,
    );
    expect(await readSocialActivity()).toEqual([]);
  });

  it("filters out unknown platforms stored by hand", async () => {
    await getKvStore().set(
      SOCIAL_ACTIVITY_KEY,
      JSON.stringify([
        { platform: "telegram", summary: "hi", ts: new Date().toISOString() },
        { platform: "x", summary: "ok", ts: new Date().toISOString() },
      ]),
      SOCIAL_ACTIVITY_TTL_MS,
    );
    const events = await readSocialActivity();
    expect(events).toHaveLength(1);
    expect(events[0].platform).toBe("x");
  });

  it("respects the read limit", async () => {
    await logSocialPost("x", "one");
    await logSocialPost("x", "two");
    await logSocialPost("x", "three");
    expect(await readSocialActivity(2)).toHaveLength(2);
  });
});
