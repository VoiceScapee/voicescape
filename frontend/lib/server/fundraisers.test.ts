/**
 * Tests for the fundraiser board aggregation (lib/server/fundraisers.ts)
 * with canned deps: goal records + index in the memory KV backend.
 */
import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "./store";
import {
  FUNDRAISER_INDEX_KEY,
  GOAL_TTL_MS,
  goalKey,
  type FundingGoal,
} from "./goals";
import {
  listFundraisers,
  type FundraiserDeps,
} from "./fundraisers";

const OWNER_A = "0x" + "aa".repeat(20);
const OWNER_B = "0x" + "bb".repeat(20);

function goalRecord(username: string, owner: string, createdAt: string): FundingGoal {
  return {
    username,
    owner,
    targetHbar: 100,
    title: `${username} fund`,
    createdAt,
    updatedAt: createdAt,
  };
}

async function seed(usernames: string[], goals: Record<string, FundingGoal>) {
  const store = createMemoryKvStore();
  await store.set(FUNDRAISER_INDEX_KEY, JSON.stringify(usernames), GOAL_TTL_MS);
  for (const [u, g] of Object.entries(goals)) {
    await store.set(goalKey(u), JSON.stringify(g), GOAL_TTL_MS);
  }
  return store;
}

function depsFor(store: ReturnType<typeof createMemoryKvStore>, opts?: {
  owners?: Record<string, string | null>;
  raised?: Record<string, number | null>;
}): FundraiserDeps {
  return {
    store,
    resolveOwner: async (u: string) => opts?.owners?.[u] ?? null,
    raisedFor: async (a: string) => {
      const v = opts?.raised?.[a.toLowerCase()];
      return v === undefined ? null : v;
    },
  };
}

describe("listFundraisers", () => {
  it("returns active fundraisers newest first with raised totals", async () => {
    const store = await seed(
      ["alice", "bob"],
      {
        alice: goalRecord("alice", OWNER_A, "2026-09-01T00:00:00.000Z"),
        bob: goalRecord("bob", OWNER_B, "2026-09-10T00:00:00.000Z"),
      },
    );
    const deps = depsFor(store, {
      owners: { alice: OWNER_A, bob: OWNER_B },
      raised: { [OWNER_A]: 25.5, [OWNER_B]: 120 },
    });
    const list = await listFundraisers(deps);
    expect(list.map((f) => f.username)).toEqual(["bob", "alice"]);
    expect(list[0]).toMatchObject({ title: "bob fund", targetHbar: 100, raisedHbar: 120, owner: OWNER_B });
    expect(list[1]).toMatchObject({ raisedHbar: 25.5, owner: OWNER_A });
  });

  it("skips stale index entries, unresolvable owners, and unreadable totals", async () => {
    const store = await seed(
      ["alice", "stale", "ghost"],
      { alice: goalRecord("alice", OWNER_A, "2026-09-01T00:00:00.000Z") },
    );
    const deps = depsFor(store, {
      owners: { alice: OWNER_A, ghost: null },
      raised: {},
    });
    const list = await listFundraisers(deps);
    expect(list.map((f) => f.username)).toEqual(["alice"]);
    expect(list[0].raisedHbar).toBe(0);
  });

  it("returns [] when the index is missing", async () => {
    const store = createMemoryKvStore();
    const list = await listFundraisers(depsFor(store));
    expect(list).toEqual([]);
  });

  it("never throws when deps throw", async () => {
    const store = await seed(["alice"], {
      alice: goalRecord("alice", OWNER_A, "2026-09-01T00:00:00.000Z"),
    });
    const deps: FundraiserDeps = {
      store,
      resolveOwner: async () => { throw new Error("down"); },
      raisedFor: async () => { throw new Error("down"); },
    };
    await expect(listFundraisers(deps)).resolves.toEqual([]);
  });
});
