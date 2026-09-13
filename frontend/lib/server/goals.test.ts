/**
 * Tests for the funding-goal store logic (lib/server/goals.ts) with the
 * in-memory KV backend: CRUD, owner gating, and input validation.
 */
import { describe, expect, it } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import {
  campaignRaised,
  clearGoal,
  defaultGoalDeps,
  FUNDRAISER_INDEX_KEY,
  GOAL_MAX_HBAR,
  goalKey,
  isCampaignReached,
  parseGoalValue,
  readFundraiserUsernames,
  readGoal,
  validateGoalInput,
  writeGoal,
  type GoalDeps,
} from "./goals";

const OWNER = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);

/** Deps with a memory store and canned auth/ownership/earnings answers. */
function testDeps(opts?: {
  sessionAddress?: string | null;
  owner?: string | null;
  /** Canned all-time HBAR for the baseline snapshot (default 0). */
  allTime?: number | null;
}): GoalDeps {
  const sessionAddress = opts?.sessionAddress === undefined ? OWNER : opts.sessionAddress;
  const owner = opts?.owner === undefined ? OWNER : opts.owner;
  const allTime = opts?.allTime === undefined ? 0 : opts.allTime;
  return {
    store: createMemoryKvStore(),
    verifySession: async (cred: unknown) =>
      sessionAddress && cred != null
        ? { ok: true as const, address: sessionAddress }
        : { ok: false as const, error: "no session" },
    resolveOwner: async () => owner,
    readAllTimeHbar: async () => allTime,
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

  it("defaults baselineHbar to 0 for legacy records", () => {
    const legacy = {
      username: "old",
      owner: OWNER,
      targetHbar: 100,
      title: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(parseGoalValue(JSON.stringify(legacy))).toMatchObject({ baselineHbar: 0 });
    expect(
      parseGoalValue(JSON.stringify({ ...legacy, baselineHbar: 42.5 })),
    ).toMatchObject({ baselineHbar: 42.5 });
    // Garbage baselines fall back to 0 rather than corrupting the record.
    expect(
      parseGoalValue(JSON.stringify({ ...legacy, baselineHbar: -3 })),
    ).toMatchObject({ baselineHbar: 0 });
  });
});

describe("campaignRaised / isCampaignReached", () => {
  it("measures progress from the baseline, floored at zero", () => {
    expect(campaignRaised({ baselineHbar: 500, targetHbar: 100 }, 560)).toBe(60);
    expect(campaignRaised({ baselineHbar: 500, targetHbar: 100 }, 400)).toBe(0);
    expect(campaignRaised({ baselineHbar: 0, targetHbar: 100 }, null)).toBe(0);
  });

  it("reaches only on campaign progress, not all-time", () => {
    expect(isCampaignReached({ baselineHbar: 500, targetHbar: 100 }, 599.99)).toBe(false);
    expect(isCampaignReached({ baselineHbar: 500, targetHbar: 100 }, 600)).toBe(true);
    // Legacy record (no baseline): old all-time behavior.
    expect(isCampaignReached({ baselineHbar: 0, targetHbar: 100 }, 100)).toBe(true);
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

  it("snapshots the all-time total as the baseline for a new campaign", async () => {
    const deps = testDeps({ allTime: 12.5 });
    const set = (await writeGoal(deps, "creator1", { targetHbar: 100 }, "cred")).json as {
      goal: { baselineHbar: number; createdAt: string };
    };
    expect(set.goal.baselineHbar).toBe(12.5);
  });

  it("editing a live campaign keeps its baseline and createdAt", async () => {
    const deps = testDeps({ allTime: 10 });
    const first = (await writeGoal(deps, "creator1", { targetHbar: 100, title: "v1" }, "cred")).json as {
      goal: { baselineHbar: number; createdAt: string };
    };
    expect(first.goal.baselineHbar).toBe(10);
    // Tips arrive (all-time 60 < baseline 10 + target 100 → still live),
    // then the owner tweaks the title: progress must not reset.
    const deps2 = { ...deps, store: deps.store, readAllTimeHbar: async () => 60 };
    const second = (await writeGoal(deps2, "creator1", { targetHbar: 100, title: "v2" }, "cred")).json as {
      goal: { baselineHbar: number; createdAt: string; title: string };
    };
    expect(second.goal.baselineHbar).toBe(10);
    expect(second.goal.createdAt).toBe(first.goal.createdAt);
    expect(second.goal.title).toBe("v2");
  });

  it("saving after the previous campaign completed starts a new campaign", async () => {
    // Campaign 1: baseline 10, target 100 → completes at all-time 110.
    const store = createMemoryKvStore();
    const mkDeps = (allTime: number): GoalDeps => ({
      ...testDeps(),
      store,
      readAllTimeHbar: async () => allTime,
    });
    await writeGoal(mkDeps(10), "creator1", { targetHbar: 100 }, "cred");
    // All-time is now 115: campaign 1 reached (115 − 10 ≥ 100).
    // A new goal reopens donations with progress restarted at zero.
    const second = (await writeGoal(mkDeps(115), "creator1", { targetHbar: 50 }, "cred")).json as {
      goal: { baselineHbar: number; createdAt: string; targetHbar: number };
    };
    expect(second.goal.baselineHbar).toBe(115);
    expect(second.goal.targetHbar).toBe(50);
    expect(campaignRaised(second.goal, 115)).toBe(0);
    expect(isCampaignReached(second.goal, 115)).toBe(false);
  });

  it("clear + set restarts the campaign from the current all-time total", async () => {
    const store = createMemoryKvStore();
    const mkDeps = (allTime: number): GoalDeps => ({
      ...testDeps(),
      store,
      readAllTimeHbar: async () => allTime,
    });
    await writeGoal(mkDeps(10), "creator1", { targetHbar: 100 }, "cred");
    await clearGoal(mkDeps(10), "creator1", "cred");
    const again = (await writeGoal(mkDeps(40), "creator1", { targetHbar: 100 }, "cred")).json as {
      goal: { baselineHbar: number };
    };
    expect(again.goal.baselineHbar).toBe(40);
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

  it("writeGoal adds the username to the fundraiser index; clearGoal removes it", async () => {
    const deps = testDeps();
    expect(await readFundraiserUsernames(deps.store)).toEqual([]);
    await writeGoal(deps, "creator1", { targetHbar: 100 }, "cred");
    await writeGoal(deps, "creator2", { targetHbar: 50 }, "cred");
    expect(await readFundraiserUsernames(deps.store)).toEqual(["creator1", "creator2"]);
    // Re-saving the same goal does not duplicate the index entry.
    await writeGoal(deps, "creator1", { targetHbar: 150 }, "cred");
    expect(await readFundraiserUsernames(deps.store)).toEqual(["creator1", "creator2"]);
    await clearGoal(deps, "creator1", "cred");
    expect(await readFundraiserUsernames(deps.store)).toEqual(["creator2"]);
  });

  it("readFundraiserUsernames returns [] for missing or corrupt index values", async () => {
    const store = createMemoryKvStore();
    expect(await readFundraiserUsernames(store)).toEqual([]);
    await store.set(FUNDRAISER_INDEX_KEY, "not json", 60000);
    expect(await readFundraiserUsernames(store)).toEqual([]);
    await store.set(FUNDRAISER_INDEX_KEY, JSON.stringify({ nope: true }), 60000);
    expect(await readFundraiserUsernames(store)).toEqual([]);
  });
});
