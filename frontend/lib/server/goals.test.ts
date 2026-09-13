/**
 * Tests for the funding-goal store logic (lib/server/goals.ts) with the
 * in-memory KV backend: CRUD, owner gating, and input validation.
 */
import { describe, expect, it } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import {
  clearGoal,
  defaultGoalDeps,
  GOAL_MAX_HBAR,
  goalKey,
  parseGoalValue,
  readGoal,
  validateGoalInput,
  writeGoal,
  type GoalDeps,
} from "./goals";

const OWNER = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);

/** Deps with a memory store and canned auth/ownership answers. */
function testDeps(opts?: { sessionAddress?: string | null; owner?: string | null }): GoalDeps {
  const sessionAddress = opts?.sessionAddress === undefined ? OWNER : opts.sessionAddress;
  const owner = opts?.owner === undefined ? OWNER : opts.owner;
  return {
    store: createMemoryKvStore(),
    verifySession: async (cred: unknown) =>
      sessionAddress && cred != null
        ? { ok: true as const, address: sessionAddress }
        : { ok: false as const, error: "no session" },
    resolveOwner: async () => owner,
  };
}

describe("validateGoalInput", () => {
  it("accepts a valid goal", () => {
    const r = validateGoalInput({ targetHbar: 100, title: "Studio fund" });
    expect(r).toEqual({ ok: true, targetHbar: 100, title: "Studio fund" });
  });

  it("accepts a string target and a missing title", () => {
    const r = validateGoalInput({ targetHbar: "250.5" });
    expect(r).toEqual({ ok: true, targetHbar: 250.5, title: null });
  });

  it("rejects zero, negative, NaN, and over-max targets", () => {
    for (const targetHbar of [0, -5, NaN, Infinity, GOAL_MAX_HBAR + 1, "abc"]) {
      const r = validateGoalInput({ targetHbar });
      expect(r.ok, `target ${targetHbar}`).toBe(false);
    }
  });

  it("rejects over-long and non-string titles", () => {
    expect(validateGoalInput({ targetHbar: 10, title: "x".repeat(81) }).ok).toBe(false);
    expect(validateGoalInput({ targetHbar: 10, title: 42 }).ok).toBe(false);
  });

  it("rejects titles with personal details (content filter)", () => {
    const r = validateGoalInput({ targetHbar: 10, title: "call me 555-123-4567" });
    expect(r.ok).toBe(false);
  });

  it("trims whitespace-only titles to null", () => {
    const r = validateGoalInput({ targetHbar: 10, title: "   " });
    expect(r).toEqual({ ok: true, targetHbar: 10, title: null });
  });
});

describe("parseGoalValue", () => {
  it("returns null for missing or corrupt values", () => {
    expect(parseGoalValue(null)).toBeNull();
    expect(parseGoalValue("not json")).toBeNull();
    expect(parseGoalValue(JSON.stringify({ targetHbar: -5 }))).toBeNull();
  });
});

describe("writeGoal / readGoal / clearGoal", () => {
  it("sets, reads, and clears a goal for the owner", async () => {
    const deps = testDeps();
    const set = await writeGoal(deps, "creator1", { targetHbar: 100, title: "Fund" }, "cred");
    expect(set.status).toBe(200);
    const goal = (set.json as { goal: { targetHbar: number; title: string; username: string } }).goal;
    expect(goal.targetHbar).toBe(100);
    expect(goal.title).toBe("Fund");
    expect(goal.username).toBe("creator1");

    expect(await readGoal(deps.store, "creator1")).toMatchObject({ targetHbar: 100 });
    // Case-insensitive username read.
    expect(await readGoal(deps.store, "Creator1")).toMatchObject({ targetHbar: 100 });

    const cleared = await clearGoal(deps, "creator1", "cred");
    expect(cleared.status).toBe(200);
    expect(await readGoal(deps.store, "creator1")).toBeNull();
  });

  it("replacing a goal keeps the original createdAt", async () => {
    const deps = testDeps();
    const first = (await writeGoal(deps, "creator1", { targetHbar: 100 }, "cred")).json as {
      goal: { createdAt: string };
    };
    const second = (await writeGoal(deps, "creator1", { targetHbar: 200 }, "cred")).json as {
      goal: { createdAt: string; targetHbar: number };
    };
    expect(second.goal.createdAt).toBe(first.goal.createdAt);
    expect(second.goal.targetHbar).toBe(200);
  });

  it("401s without a session", async () => {
    const deps = testDeps({ sessionAddress: null });
    const r = await writeGoal(deps, "creator1", { targetHbar: 100 }, null);
    expect(r.status).toBe(401);
    const d = await clearGoal(deps, "creator1", null);
    expect(d.status).toBe(401);
  });

  it("403s when the wallet does not own the page", async () => {
    const deps = testDeps({ sessionAddress: OTHER, owner: OWNER });
    const r = await writeGoal(deps, "creator1", { targetHbar: 100 }, "cred");
    expect(r.status).toBe(403);
  });

  it("404s for an unregistered username", async () => {
    const deps = testDeps({ owner: null });
    const r = await writeGoal(deps, "ghost", { targetHbar: 100 }, "cred");
    expect(r.status).toBe(404);
  });

  it("400s on bad input and bad usernames", async () => {
    const deps = testDeps();
    expect((await writeGoal(deps, "creator1", { targetHbar: -1 }, "cred")).status).toBe(400);
    expect((await writeGoal(deps, "", { targetHbar: 100 }, "cred")).status).toBe(400);
  });

  it("503s when the store is unavailable", async () => {
    const broken: KvStore = {
      incr: async () => { throw new Error("down"); },
      setNx: async () => { throw new Error("down"); },
      set: async () => { throw new Error("down"); },
      get: async () => { throw new Error("down"); },
      del: async () => { throw new Error("down"); },
      clearPrefix: async () => { throw new Error("down"); },
    };
    const deps: GoalDeps = { ...testDeps(), store: broken };
    const r = await writeGoal(deps, "creator1", { targetHbar: 100 }, "cred");
    expect(r.status).toBe(503);
  });

  it("goalKey is namespaced per username", () => {
    expect(goalKey("creator1")).toBe("goals:creator1");
  });

  it("defaultGoalDeps wires the real store and ports", () => {
    const deps = defaultGoalDeps();
    expect(typeof deps.verifySession).toBe("function");
    expect(typeof deps.resolveOwner).toBe("function");
  });
});
