/**
 * Tests for the Agent Workshop core (lib/server/agent-workshop.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 * The on-chain agent check is injected (no RPC in tests).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { KvStore } from "./store";
import {
  postWorkshopReport,
  getWorkshopReport,
  listWorkshopReports,
  listOpenBugs,
  setWorkshopStatus,
  addWorkshopReply,
  listWorkshopReplies,
  replyWorkshopReport,
  deleteWorkshopReply,
  upvoteWorkshopReport,
  normalizeSignature,
  normalizeUsername,
  stripStackTraces,
  validateWorkshopInput,
  isValidStatusTransition,
  WORKSHOP_DAILY_LIMIT,
  type WorkshopDeps,
} from "./agent-workshop";

class FakeStore implements KvStore {
  private data = new Map<string, { value: string; expiresAt: number }>();

  private alive(key: string): boolean {
    const e = this.data.get(key);
    if (!e) return false;
    if (e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return false;
    }
    return true;
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    const cur = this.alive(key) ? Number(this.data.get(key)!.value) : 0;
    const next = cur + 1;
    this.data.set(key, { value: String(next), expiresAt: Date.now() + ttlMs });
    return next;
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.alive(key)) return false;
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (!(ttlMs > 0)) throw new Error("ttlMs must be positive");
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key) ? this.data.get(key)!.value : null;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const k of [...this.data.keys()]) {
      if (k.startsWith(prefix)) this.data.delete(k);
    }
  }
}

function agentDeps(store: KvStore): WorkshopDeps {
  return {
    store,
    resolveAgentPage: async (u: string) => (u === "forge" || u === "thechomps" ? 1 : u === "somehuman" ? 0 : null),
  };
}

describe("normalizeSignature", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeSignature("  Stale   WALLET pairing ")).toBe("stale wallet pairing");
  });
  it("strips volatile tx ids and nonces so identical bugs cluster", () => {
    const a = normalizeSignature("stale pairing for tx 0.0.123@1790905896.123456789");
    const b = normalizeSignature("STALE pairing for tx 0.0.123@1790909999.987654321");
    expect(a).toBe(b);
    expect(a).toContain("…tx…");
  });
  it("returns null for empty input", () => {
    expect(normalizeSignature("")).toBeNull();
    expect(normalizeSignature("   ")).toBeNull();
    expect(normalizeSignature(null)).toBeNull();
  });
  it("strips pasted stack frames so traces cluster on the message", () => {
    const sig = normalizeSignature(
      "Error: stale wallet pairing\n    at checkPairing (pair.ts:42:10)\n    at async approve (wallet.ts:7:3)",
    );
    expect(sig).toBe("error: stale wallet pairing");
  });
});

describe("stripStackTraces", () => {
  it("strips JS/TS frames but keeps the message and prose", () => {
    const out = stripStackTraces(
      "Pairing dies after app-switch.\nError: stale wallet pairing\n    at checkPairing (pair.ts:42:10)\n    at async approve (wallet.ts:7:3)",
    );
    expect(out).toContain("Pairing dies after app-switch.");
    expect(out).toContain("Error: stale wallet pairing");
    expect(out).not.toContain("at checkPairing");
    expect(out).not.toContain("wallet.ts");
  });
  it("strips Python tracebacks but keeps the exception line", () => {
    const out = stripStackTraces(
      'Traceback (most recent call last):\n  File "x.py", line 3, in main\n    run()\nValueError: bad literal',
    );
    expect(out).not.toContain("Traceback");
    expect(out).not.toContain('File "x.py"');
    expect(out).toContain("ValueError: bad literal");
  });
  it("strips Java noise lines", () => {
    const out = stripStackTraces("boom\nCaused by: java.lang.NullPointer\n    ... 5 more");
    expect(out).toBe("boom");
  });
  it("keeps prose that merely starts with the word at", () => {
    expect(stripStackTraces("at the moment the probe times out")).toBe(
      "at the moment the probe times out",
    );
  });
  it("returns empty for an all-frames paste", () => {
    expect(stripStackTraces("    at a (b.ts:1:2)\n    at c (d.ts:3:4)")).toBe("");
  });
  it("catches frames even when the first line lost its indentation", () => {
    // validateWorkshopInput used to trim before stripping, which erased the
    // indentation marking the first frame line.
    expect(stripStackTraces("at a (b.ts:1:2)\n    at c (d.ts:3:4)")).toBe("");
    expect(stripStackTraces("at /app/dist/x.js:10:5\nboom")).toBe("boom");
  });
});

describe("validateWorkshopInput", () => {
  it("accepts a good bug report", () => {
    const r = validateWorkshopInput({ category: "bug", title: "Wallet pairing dies", body: "details here" });
    expect(r.ok).toBe(true);
  });
  it("rejects bad categories and empty fields", () => {
    expect(validateWorkshopInput({ category: "rant", title: "x", body: "y" }).ok).toBe(false);
    expect(validateWorkshopInput({ category: "bug", title: "", body: "y" }).ok).toBe(false);
    expect(validateWorkshopInput({ category: "idea", title: "x", body: "" }).ok).toBe(false);
  });
  it("rejects over-long titles and bodies", () => {
    expect(validateWorkshopInput({ category: "bug", title: "x".repeat(121), body: "y" }).ok).toBe(false);
    expect(validateWorkshopInput({ category: "bug", title: "x", body: "y".repeat(2001) }).ok).toBe(false);
  });
  it("rejects a body that is only a pasted stack trace", () => {
    const r = validateWorkshopInput({
      category: "bug",
      title: "x",
      body: "    at a (b.ts:1:2)\n    at c (d.ts:3:4)",
    });
    expect(r.ok).toBe(false);
  });
  it("strips stack frames from body and repro, never stores them raw", () => {
    const r = validateWorkshopInput({
      category: "bug",
      title: "x",
      body: "Pairing dies.\n    at checkPairing (pair.ts:42:10)",
      repro: "1. pair\n    at tap (ui.ts:9:1)",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.clean.body).toBe("Pairing dies.");
      expect(r.clean.repro).toBe("1. pair");
    }
  });
});

describe("isValidStatusTransition", () => {
  it("only allows forward movement", () => {
    expect(isValidStatusTransition("new", "confirmed")).toBe(true);
    expect(isValidStatusTransition("new", "shipped")).toBe(true);
    expect(isValidStatusTransition("confirmed", "new")).toBe(false);
    expect(isValidStatusTransition("shipped", "fixing")).toBe(false);
    expect(isValidStatusTransition("new", "new")).toBe(false);
  });
});

describe("postWorkshopReport", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("posts a bug report for a registered agent", async () => {
    const res = await postWorkshopReport(
      {
        category: "bug",
        title: "Pairing probe times out",
        body: "After app-switch pairing the liveness probe fails.",
        agent_username: "forge",
        tool: "prepare_agent_claim",
        error_signature: "stale wallet pairing for prepared tx",
        repro: "1. Pair 2. Switch apps 3. Tap approve",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(true);
    expect(res.report?.status).toBe("new");
    expect(res.report?.affected_agents).toBe(1);
    expect(res.report?.error_signature).toBe("stale wallet pairing for prepared tx");
    expect(res.merged).toBeFalsy();
  });

  it("rejects unregistered usernames (fail closed)", async () => {
    const res = await postWorkshopReport(
      { category: "bug", title: "x", body: "y", agent_username: "nobody" },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a registered agent blockpage/);
  });

  it("rejects human pages", async () => {
    const res = await postWorkshopReport(
      { category: "idea", title: "x", body: "y", agent_username: "somehuman" },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/human page/);
  });

  it("enforces the 20/day free quota", async () => {
    const deps = agentDeps(store);
    for (let i = 0; i < WORKSHOP_DAILY_LIMIT; i++) {
      const r = await postWorkshopReport(
        { category: "idea", title: `idea ${i}`, body: "body", agent_username: "forge" },
        deps,
      );
      expect(r.ok).toBe(true);
    }
    const over = await postWorkshopReport(
      { category: "idea", title: "one too many", body: "body", agent_username: "forge" },
      deps,
    );
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/20 free posts/);
  });

  it("clusters identical bug signatures into one record", async () => {
    const deps = agentDeps(store);
    const first = await postWorkshopReport(
      {
        category: "bug",
        title: "Stale pairing",
        body: "probe failed",
        agent_username: "forge",
        error_signature: "stale wallet pairing for tx 0.0.1@111.222",
      },
      deps,
    );
    expect(first.ok).toBe(true);
    const second = await postWorkshopReport(
      {
        category: "bug",
        title: "Stale pairing again",
        body: "probe failed again",
        agent_username: "thechomps",
        error_signature: "STALE WALLET pairing for tx 0.0.1@999.888",
      },
      deps,
    );
    expect(second.ok).toBe(true);
    expect(second.merged).toBe(true);
    expect(second.report?.id).toBe(first.report?.id);
    expect(second.report?.affected_agents).toBe(2);
    expect(second.report?.reporters).toEqual(["forge", "thechomps"]);
    // Still one report in the index, not two.
    const list = await listWorkshopReports({}, deps);
    expect(list).toHaveLength(1);
  });

  it("does not cluster ideas, and does not absorb into shipped bugs", async () => {
    const deps = agentDeps(store);
    const bug = await postWorkshopReport(
      { category: "bug", title: "b", body: "b", agent_username: "forge", error_signature: "sig one" },
      deps,
    );
    await setWorkshopStatus(bug.report!.id, "shipped", deps);
    const again = await postWorkshopReport(
      { category: "bug", title: "b2", body: "b2", agent_username: "thechomps", error_signature: "sig one" },
      deps,
    );
    expect(again.merged).toBeFalsy(); // possible regression → fresh report
    const idea1 = await postWorkshopReport(
      { category: "idea", title: "same title", body: "x", agent_username: "forge" },
      deps,
    );
    const idea2 = await postWorkshopReport(
      { category: "idea", title: "same title", body: "y", agent_username: "thechomps" },
      deps,
    );
    expect(idea1.report?.id).not.toBe(idea2.report?.id);
  });
});

describe("setWorkshopStatus", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("walks the lifecycle and compacts on ship", async () => {
    const deps = agentDeps(store);
    const posted = await postWorkshopReport(
      {
        category: "bug",
        title: "x",
        body: "y".repeat(600),
        agent_username: "forge",
        repro: "repro steps here",
        error_signature: "sig",
      },
      deps,
    );
    const id = posted.report!.id;
    for (const s of ["confirmed", "fixing", "shipped"] as const) {
      const r = await setWorkshopStatus(id, s, deps);
      expect(r.ok).toBe(true);
      expect(r.report?.status).toBe(s);
    }
    const shipped = await getWorkshopReport(id, deps);
    expect(shipped?.credit).toMatch(/Fixed thanks to @forge/);
    expect(shipped?.repro).toBeUndefined(); // compacted
    expect(shipped!.body.length).toBeLessThanOrEqual(501);
    expect(shipped?.error_signature).toBe("sig"); // signature kept for the knowledge base
  });

  it("rejects backwards transitions and unknown reports", async () => {
    const deps = agentDeps(store);
    const posted = await postWorkshopReport(
      { category: "idea", title: "x", body: "y", agent_username: "forge" },
      deps,
    );
    const back = await setWorkshopStatus(posted.report!.id, "new", deps);
    expect(back.ok).toBe(false);
    const missing = await setWorkshopStatus("wr_000000000000000000", "confirmed", deps);
    expect(missing.ok).toBe(false);
  });
});

describe("listOpenBugs", () => {
  it("excludes shipped bugs", async () => {
    const store = new FakeStore();
    const deps = agentDeps(store);
    const a = await postWorkshopReport(
      { category: "bug", title: "open bug", body: "b", agent_username: "forge", error_signature: "s1" },
      deps,
    );
    await postWorkshopReport(
      { category: "idea", title: "an idea", body: "b", agent_username: "forge" },
      deps,
    );
    let open = await listOpenBugs(20, deps);
    expect(open.map((r) => r.id)).toContain(a.report!.id);
    await setWorkshopStatus(a.report!.id, "shipped", deps);
    open = await listOpenBugs(20, deps);
    expect(open.map((r) => r.id)).not.toContain(a.report!.id);
  });
});

describe("replies and upvotes", () => {
  it("stores capped replies and counts one upvote per voter", async () => {
    const store = new FakeStore();
    const deps = agentDeps(store);
    const posted = await postWorkshopReport(
      { category: "idea", title: "x", body: "y", agent_username: "forge" },
      deps,
    );
    const id = posted.report!.id;
    const r1 = await addWorkshopReply(id, { author: "brandon", author_kind: "human", body: "Looking into it." }, deps);
    expect(r1.ok).toBe(true);
    const replies = await listWorkshopReplies(id, deps);
    expect(replies).toHaveLength(1);
    const u1 = await upvoteWorkshopReport(id, "brandon", deps);
    expect(u1.ok).toBe(true);
    expect(u1.upvotes).toBe(1);
    const u2 = await upvoteWorkshopReport(id, "brandon", deps);
    expect(u2.ok).toBe(false); // already upvoted
  });
});

describe("normalizeUsername", () => {
  it("accepts valid handles, rejects the rest", () => {
    expect(normalizeUsername("Forge")).toBe("forge");
    expect(normalizeUsername("ab")).toBeNull();
    expect(normalizeUsername("UPPER CASE")).toBeNull();
    expect(normalizeUsername(123)).toBeNull();
  });
});

describe("replyWorkshopReport", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it("posts a reply as a registered agent", async () => {
    // First create a report to reply to
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    expect(postRes.ok).toBe(true);
    const reportId = postRes.report!.id;

    const res = await replyWorkshopReport(
      {
        agent_username: "forge",
        report_id: reportId,
        content: "I can confirm this bug, here's a workaround...",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(true);
    expect(res.reply!.author).toBe("forge");
    expect(res.reply!.author_kind).toBe("agent");
  });

  it("rejects replies from unregistered usernames", async () => {
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;

    const res = await replyWorkshopReport(
      {
        agent_username: "notregistered",
        report_id: reportId,
        content: "Trying to reply",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not a registered agent");
  });

  it("rejects replies from human pages", async () => {
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;

    const res = await replyWorkshopReport(
      {
        agent_username: "somehuman",
        report_id: reportId,
        content: "Trying to reply",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("human page");
  });

  it("enforces 20/day rate limit for outside agents", async () => {
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;

    // Post 20 replies (should all succeed)
    for (let i = 0; i < 20; i++) {
      const res = await replyWorkshopReport(
        {
          agent_username: "forge",
          report_id: reportId,
          content: `Reply ${i}`,
        },
        agentDeps(store),
      );
      expect(res.ok).toBe(true);
    }

    // 21st should fail
    const res = await replyWorkshopReport(
      {
        agent_username: "forge",
        report_id: reportId,
        content: "One too many",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("20 free replies");
  });

  it("operator bypasses rate limit and identity gate with valid key", async () => {
    process.env.WORKSHOP_OPERATORS = "danny";
    process.env.WORKSHOP_OPERATOR_KEY = "test-operator-secret";
    try {
      const postRes = await postWorkshopReport(
        {
          category: "bug",
          title: "Test bug",
          body: "Something broke",
          agent_username: "thechomps",
        },
        agentDeps(store),
      );
      const reportId = postRes.report!.id;

      // Operator can post more than 20 (no rate limit)
      for (let i = 0; i < 25; i++) {
        const res = await replyWorkshopReport(
          {
            agent_username: "danny",
            report_id: reportId,
            content: `Operator reply ${i}`,
            operator_key: "test-operator-secret",
          },
          agentDeps(store),
        );
        expect(res.ok).toBe(true);
      }
    } finally {
      delete process.env.WORKSHOP_OPERATORS;
      delete process.env.WORKSHOP_OPERATOR_KEY;
    }
  });

  it("rejects operator username without a valid key (no impersonation)", async () => {
    process.env.WORKSHOP_OPERATOR_KEY = "test-operator-secret";
    try {
      const postRes = await postWorkshopReport(
        {
          category: "bug",
          title: "Test bug",
          body: "Something broke",
          agent_username: "thechomps",
        },
        agentDeps(store),
      );
      const reportId = postRes.report!.id;

      // Built-in danny_engine name with no key: rejected, not fallen through
      const noKey = await replyWorkshopReport(
        {
          agent_username: "danny_engine",
          report_id: reportId,
          content: "Trying to impersonate the operator",
        },
        agentDeps(store),
      );
      expect(noKey.ok).toBe(false);
      expect(noKey.error).toContain("operator key");

      // Wrong key: also rejected
      const wrongKey = await replyWorkshopReport(
        {
          agent_username: "danny_engine",
          report_id: reportId,
          content: "Trying to impersonate the operator",
          operator_key: "wrong-secret",
        },
        agentDeps(store),
      );
      expect(wrongKey.ok).toBe(false);
      expect(wrongKey.error).toContain("operator key");
    } finally {
      delete process.env.WORKSHOP_OPERATOR_KEY;
    }
  });

  it("fail-closed: bypass unreachable when operator key is unset", async () => {
    delete process.env.WORKSHOP_OPERATOR_KEY;
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;

    const res = await replyWorkshopReport(
      {
        agent_username: "danny_engine",
        report_id: reportId,
        content: "No secret configured server-side",
        operator_key: "anything",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("operator key");
  });

  it("rejects empty content", async () => {
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;

    const res = await replyWorkshopReport(
      {
        agent_username: "forge",
        report_id: reportId,
        content: "   ",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("required");
  });

  it("rejects content over max length", async () => {
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;

    const res = await replyWorkshopReport(
      {
        agent_username: "forge",
        report_id: reportId,
        content: "x".repeat(1001),
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("too long");
  });

  it("rejects replies to nonexistent reports", async () => {
    const res = await replyWorkshopReport(
      {
        agent_username: "forge",
        report_id: "wr_nonexistent",
        content: "Reply to nothing",
      },
      agentDeps(store),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });
});

describe("deleteWorkshopReply", () => {
  let store: FakeStore;
  const OP_KEY = "test-operator-secret";

  beforeEach(() => {
    store = new FakeStore();
    process.env.WORKSHOP_OPERATOR_KEY = OP_KEY;
  });

  afterEach(() => {
    delete process.env.WORKSHOP_OPERATOR_KEY;
  });

  async function seedReportWithReplies(): Promise<{ reportId: string; replyIds: string[] }> {
    const postRes = await postWorkshopReport(
      {
        category: "bug",
        title: "Test bug",
        body: "Something broke",
        agent_username: "thechomps",
      },
      agentDeps(store),
    );
    const reportId = postRes.report!.id;
    const replyIds: string[] = [];
    for (const body of ["canonical reply", "test", "duplicate of canonical"]) {
      const r = await addWorkshopReply(
        reportId,
        { author: "danny_engine", author_kind: "agent", body },
        { store },
      );
      replyIds.push(r.reply!.id);
    }
    return { reportId, replyIds };
  }

  it("deletes an existing reply with a valid operator key", async () => {
    const { reportId, replyIds } = await seedReportWithReplies();

    const res = await deleteWorkshopReply(
      { report_id: reportId, reply_id: replyIds[1], operator_key: OP_KEY },
      { store },
    );
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(replyIds[1]);

    const remaining = await listWorkshopReplies(reportId, { store });
    expect(remaining.map((r) => r.id)).toEqual([replyIds[0], replyIds[2]]);
  });

  it("fails cleanly for a non-existent reply id", async () => {
    const { reportId } = await seedReportWithReplies();

    const res = await deleteWorkshopReply(
      { report_id: reportId, reply_id: "wrp_aaaaaaaaaaaaaaaaaa", operator_key: OP_KEY },
      { store },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reply not found");

    // Nothing was removed
    expect((await listWorkshopReplies(reportId, { store })).length).toBe(3);
  });

  it("fails cleanly for a non-existent report", async () => {
    const res = await deleteWorkshopReply(
      { report_id: "wr_aaaaaaaaaaaaaaaaaa", reply_id: "wrp_aaaaaaaaaaaaaaaaaa", operator_key: OP_KEY },
      { store },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("report not found");
  });

  it("rejects deletion without an operator key", async () => {
    const { reportId, replyIds } = await seedReportWithReplies();

    const res = await deleteWorkshopReply(
      { report_id: reportId, reply_id: replyIds[0] },
      { store },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("operator");

    // Nothing was removed
    expect((await listWorkshopReplies(reportId, { store })).length).toBe(3);
  });

  it("rejects deletion with a wrong operator key", async () => {
    const { reportId, replyIds } = await seedReportWithReplies();

    const res = await deleteWorkshopReply(
      { report_id: reportId, reply_id: replyIds[0], operator_key: "wrong-secret" },
      { store },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("operator");

    expect((await listWorkshopReplies(reportId, { store })).length).toBe(3);
  });

  it("fail-closed: deletion unreachable when operator key is unset", async () => {
    delete process.env.WORKSHOP_OPERATOR_KEY;
    const { reportId, replyIds } = await seedReportWithReplies();

    const res = await deleteWorkshopReply(
      { report_id: reportId, reply_id: replyIds[0], operator_key: "anything" },
      { store },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("operator");

    expect((await listWorkshopReplies(reportId, { store })).length).toBe(3);
  });

  it("rejects malformed ids", async () => {
    const badReport = await deleteWorkshopReply(
      { report_id: "nope", reply_id: "wrp_aaaaaaaaaaaaaaaaaa", operator_key: OP_KEY },
      { store },
    );
    expect(badReport.ok).toBe(false);
    expect(badReport.error).toContain("invalid report id");

    const badReply = await deleteWorkshopReply(
      { report_id: "wr_aaaaaaaaaaaaaaaaaa", reply_id: "nope", operator_key: OP_KEY },
      { store },
    );
    expect(badReply.ok).toBe(false);
    expect(badReply.error).toContain("invalid reply id");
  });

  it("deleting the same reply twice fails the second time", async () => {
    const { reportId, replyIds } = await seedReportWithReplies();

    const first = await deleteWorkshopReply(
      { report_id: reportId, reply_id: replyIds[0], operator_key: OP_KEY },
      { store },
    );
    expect(first.ok).toBe(true);

    const second = await deleteWorkshopReply(
      { report_id: reportId, reply_id: replyIds[0], operator_key: OP_KEY },
      { store },
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain("reply not found");
  });
});
