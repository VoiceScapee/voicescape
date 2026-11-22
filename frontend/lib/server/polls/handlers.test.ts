/**
 * Poll handler tests.
 *
 * Model under test: free votes, one per IP per poll; the first vote
 * defines the ballot; a changed ballot is rejected, never silently
 * re-interpreted.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createMemoryKvStore, type KvStore } from "../store";
import { castVote, getPoll, type PollDeps } from "./handlers";

const OPTIONS = ["Agent tips", "A live build", "Theo returns"];

function deps(): PollDeps {
  return { store: createMemoryKvStore() };
}

describe("castVote", () => {
  let d: PollDeps;
  beforeEach(() => {
    d = deps();
  });

  it("records a first vote and reports the results", async () => {
    const r = await castVote(d, "voicescape-webseries", "ep2-topic", {
      optionIndex: 1,
      options: OPTIONS,
    }, "1.2.3.4");
    expect(r.status).toBe(200);
    const json = r.json as { counts: number[]; total: number; votedOption: number };
    expect(json.counts).toEqual([0, 1, 0]);
    expect(json.total).toBe(1);
    expect(json.votedOption).toBe(1);
  });

  it("rejects a second vote from the same IP, honestly", async () => {
    await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 0, options: OPTIONS }, "1.2.3.4");
    const again = await castVote(d, "voicescape-webseries", "ep2-topic", {
      optionIndex: 2,
      options: OPTIONS,
    }, "1.2.3.4");
    expect(again.status).toBe(409);
    expect((again.json as { votedOption: number }).votedOption).toBe(0);
    const results = await getPoll(d, "voicescape-webseries", "ep2-topic", "1.2.3.4");
    expect((results.json as { total: number }).total).toBe(1);
  });

  it("lets different IPs vote and accumulates counts", async () => {
    await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 0, options: OPTIONS }, "1.1.1.1");
    await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 0, options: OPTIONS }, "2.2.2.2");
    await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 2, options: OPTIONS }, "3.3.3.3");
    const results = await getPoll(d, "voicescape-webseries", "ep2-topic", "9.9.9.9");
    const json = results.json as { counts: number[]; total: number; votedOption: number | null };
    expect(json.counts).toEqual([2, 0, 1]);
    expect(json.total).toBe(3);
    expect(json.votedOption).toBeNull();
  });

  it("validates the ballot: bad index, too few options, unknown page/poll", async () => {
    expect(
      (await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 5, options: OPTIONS }, "1.2.3.4")).status,
    ).toBe(400);
    expect(
      (await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 0, options: ["only"] }, "1.2.3.4")).status,
    ).toBe(400);
    expect(
      (await castVote(d, "x", "ep2-topic", { optionIndex: 0, options: OPTIONS }, "1.2.3.4")).status,
    ).toBe(400);
    expect(
      (await castVote(d, "voicescape-webseries", "BAD ID!", { optionIndex: 0, options: OPTIONS }, "1.2.3.4")).status,
    ).toBe(400);
  });

  it("rejects votes when the ballot changed since voting started", async () => {
    await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 0, options: OPTIONS }, "1.1.1.1");
    const changed = await castVote(d, "voicescape-webseries", "ep2-topic", {
      optionIndex: 0,
      options: ["Agent tips", "Something else entirely", "Theo returns"],
    }, "2.2.2.2");
    expect(changed.status).toBe(409);
    expect((changed.json as { error: string }).error).toMatch(/options changed/);
  });
});

describe("getPoll", () => {
  let d: PollDeps;
  beforeEach(() => {
    d = deps();
  });

  it("reports zero votes honestly before anyone votes", async () => {
    const r = await getPoll(d, "voicescape-webseries", "ep2-topic", "1.2.3.4");
    expect(r.status).toBe(200);
    const json = r.json as { options: string[] | null; counts: number[]; total: number; votedOption: number | null };
    expect(json.options).toBeNull();
    expect(json.counts).toEqual([]);
    expect(json.total).toBe(0);
    expect(json.votedOption).toBeNull();
  });

  it("returns the stored ballot and the caller's own choice", async () => {
    await castVote(d, "voicescape-webseries", "ep2-topic", { optionIndex: 2, options: OPTIONS }, "1.2.3.4");
    const r = await getPoll(d, "voicescape-webseries", "ep2-topic", "1.2.3.4");
    const json = r.json as { options: string[]; counts: number[]; votedOption: number };
    expect(json.options).toEqual(OPTIONS);
    expect(json.counts).toEqual([0, 0, 1]);
    expect(json.votedOption).toBe(2);
  });
});
