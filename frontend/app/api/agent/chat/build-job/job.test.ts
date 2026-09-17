/**
 * build-job tests: the async paid-build state machine.
 *
 * Covered: job-start token sign/verify (tamper, expiry, wrong secret),
 * start (token binding, payment gate, idempotent resume), and the
 * copy -> images -> finalize step flow with injected fakes (no network).
 *
 * Money invariants under test:
 * - the payment is consumed ONLY in finalize, after a valid draft exists;
 * - a failed finalize never double-spends (exactly-once via the spend
 *   mock, mirroring consumeBuild's atomic claim);
 * - failed/invalid builds never consume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_RACE_MESSAGE,
  BUILD_PAYWALL_UNPAID,
} from "../metering";
import { createMemoryKvStore, type KvStore } from "@/lib/server/store";
import { isValidPage, type VoicescapePage } from "@/lib/schema";
import {
  IMAGE_MARKERS,
  signJobStartToken,
  startBuildJob,
  stepBuildJob,
  verifyJobStartToken,
  type BuildJob,
} from "./job";

const SECRET = "test-secret-for-build-job";
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function validPage(username = "testpage"): VoicescapePage {
  const page = {
    version: 1,
    username,
    theme: {
      background: "#0b0e17",
      foreground: "#f2f4fa",
      accent: "#8259ef",
      fontFamily: "Inter",
    },
    blocks: [
      { type: "hero", title: username, subtitle: "test tagline" },
      { type: "bio", text: "test bio" },
      { type: "tipJar", message: "tip me" },
    ],
  };
  if (!isValidPage(page)) throw new Error("test fixture page is invalid");
  return page;
}

/** Copy text: prose + ```json draft + optional ```artwork block. */
function copyText(page: unknown, artwork: unknown[] = []): string {
  return (
    `Here is your page.\n\n\`\`\`json\n${JSON.stringify(page)}\n\`\`\`\n\n` +
    `\`\`\`artwork\n${JSON.stringify(artwork)}\n\`\`\``
  );
}

function signFor(wallet: string, u = "coolpage") {
  return signJobStartToken({ wallet, u, b: "my bio", v: "minimal dark" });
}

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("BUDDY_OPERATOR", "1"); // checkBuildAccess/consumeBuild bypass
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("signJobStartToken / verifyJobStartToken", () => {
  it("round-trips a claim and lowercases the wallet", () => {
    const token = signFor(WALLET_A.toUpperCase());
    const claim = verifyJobStartToken(token);
    expect(claim).not.toBeNull();
    expect(claim!.wallet).toBe(WALLET_A);
    expect(claim!.u).toBe("coolpage");
    expect(claim!.b).toBe("my bio");
    expect(claim!.v).toBe("minimal dark");
  });

  it("rejects a tampered payload", () => {
    const token = signFor(WALLET_A);
    const [, payload, sig] = token.split(".");
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    parsed.u = "evilpage";
    const tampered =
      "bj1." +
      Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url") +
      "." +
      sig;
    expect(verifyJobStartToken(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signFor(WALLET_A);
    vi.stubEnv("SESSION_SECRET", "a-different-secret");
    expect(verifyJobStartToken(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = signFor(WALLET_A);
      expect(verifyJobStartToken(token)).not.toBeNull();
      vi.setSystemTime(new Date("2026-01-01T00:11:00Z")); // past the 10m TTL
      expect(verifyJobStartToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects garbage and non-strings", () => {
    expect(verifyJobStartToken("")).toBeNull();
    expect(verifyJobStartToken("not-a-token")).toBeNull();
    expect(verifyJobStartToken("bj1.onlyonepart")).toBeNull();
    expect(verifyJobStartToken(null)).toBeNull();
    expect(verifyJobStartToken(undefined)).toBeNull();
    expect(verifyJobStartToken(42)).toBeNull();
  });

  it("refuses to sign without a secret", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(signFor(WALLET_A)).toBe("");
  });
});

describe("startBuildJob", () => {
  it("rejects a bad token", async () => {
    const store = createMemoryKvStore();
    const r = await startBuildJob("garbage", WALLET_A, store);
    expect(r).toEqual({ ok: false, error: "bad_token" });
  });

  it("rejects a token bound to a different wallet", async () => {
    const store = createMemoryKvStore();
    const r = await startBuildJob(signFor(WALLET_A), WALLET_B, store);
    expect(r).toEqual({ ok: false, error: "bad_token" });
  });

  it("starts a job for a paid wallet", async () => {
    const store = createMemoryKvStore();
    const r = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jobId).toBeTruthy();
      expect(r.step).toBe("copy");
      expect(r.resumed).toBe(false);
    }
  });

  it("resumes an in-flight job instead of duplicating it", async () => {
    const store = createMemoryKvStore();
    const first = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const second = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.jobId).toBe(first.jobId);
      expect(second.resumed).toBe(true);
    }
  });

  it("refuses an unpaid wallet without consuming anything", async () => {
    vi.stubEnv("BUDDY_OPERATOR", ""); // no bypass: real (mocked) mirror check
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ logs: [] }) }))
    );
    const store = createMemoryKvStore();
    const r = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("unpaid");
      expect(r.reason).toBe(BUILD_PAYWALL_UNPAID);
    }
  });

  it("reports store_unavailable when the store is down", async () => {
    const broken: KvStore = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
      setNx: async () => {
        throw new Error("down");
      },
      incr: async () => {
        throw new Error("down");
      },
      clearPrefix: async () => {
        throw new Error("down");
      },
    };
    const r = await startBuildJob(signFor(WALLET_A), WALLET_A, broken);
    expect(r).toEqual({ ok: false, error: "store_unavailable" });
  });
});

describe("stepBuildJob", () => {
  it("returns job_not_found for an unknown id", async () => {
    const store = createMemoryKvStore();
    const r = await stepBuildJob("nope", WALLET_A, { store });
    expect(r).toEqual({ ok: false, error: "job_not_found" });
  });

  it("returns forbidden when the session wallet does not own the job", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    expect(started.ok).toBe(true);
    const r = await stepBuildJob(
      started.ok ? started.jobId : "",
      WALLET_B,
      { store }
    );
    expect(r).toEqual({ ok: false, error: "forbidden" });
  });

  it("runs copy -> images -> finalize and consumes exactly once", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    expect(started.ok).toBe(true);
    const jobId = started.ok ? started.jobId : "";

    const page = validPage();
    (page.blocks[0] as { avatarImage?: string }).avatarImage =
      IMAGE_MARKERS.avatar;

    let spendCalls = 0;
    const deps = {
      store,
      runCopy: async () =>
        copyText(page, [
          {
            slot: IMAGE_MARKERS.avatar,
            kind: "avatar",
            prompt: "a vivid square avatar, wholesome",
          },
        ]),
      runImage: async () => ({ url: "https://ipfs.io/ipfs/QmTestAvatar" }),
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    };

    // copy -> images
    const s1 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s1.ok && !s1.done && s1.step).toEqual("images");
    expect(spendCalls).toBe(0); // copy never consumes

    // images -> finalize (marker replaced with the real URL)
    const s2 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s2.ok && !s2.done && s2.step).toEqual("finalize");
    expect(spendCalls).toBe(0); // images never consume

    // finalize -> done, payment consumed exactly once
    const s3 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s3.ok && s3.done).toBe(true);
    expect(spendCalls).toBe(1);
    if (s3.ok && s3.done) {
      expect(s3.draft.username).toBe("testpage");
      const hero = s3.draft.blocks[0] as { avatarImage?: string };
      expect(hero.avatarImage).toBe("https://ipfs.io/ipfs/QmTestAvatar");
    }

    // Replay: a finished job re-delivers without spending again.
    const s4 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s4.ok && s4.done).toBe(true);
    expect(spendCalls).toBe(1);
  });

  it("goes straight to finalize when the copy uses no artwork", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    let spendCalls = 0;
    const s1 = await stepBuildJob(jobId, WALLET_A, {
      store,
      runCopy: async () => copyText(validPage()),
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    });
    expect(s1.ok && !s1.done && s1.step).toBe("finalize");
    const s2 = await stepBuildJob(jobId, WALLET_A, {
      store,
      runCopy: async () => copyText(validPage()),
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    });
    expect(s2.ok && s2.done).toBe(true);
    expect(spendCalls).toBe(1);
  });

  it("keeps the copy step active (no consumption) when the draft is invalid", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    let spendCalls = 0;
    const r = await stepBuildJob(jobId, WALLET_A, {
      store,
      runCopy: async () => "no fenced json here, just prose",
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    });
    expect(r.ok && !r.done && r.step).toBe("copy");
    expect(spendCalls).toBe(0);
  });

  it("keeps the copy step active (no consumption) when the provider throws", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    let spendCalls = 0;
    const r = await stepBuildJob(jobId, WALLET_A, {
      store,
      runCopy: async () => {
        throw new Error("groq HTTP 500");
      },
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    });
    // Transient provider failure: job stays active for retry, nothing spent.
    expect(r.ok && !r.done && r.step).toBe("copy");
    expect(spendCalls).toBe(0);
  });

  it("fails the build without consuming when the payment was already spent", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    const deps = {
      store,
      runCopy: async () => copyText(validPage()),
      spend: async () => false, // another request won the atomic claim
    };
    const s1 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s1.ok && !s1.done && s1.step).toBe("finalize");
    const s2 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s2.ok).toBe(false);
    if (!s2.ok) {
      expect(s2.error).toBe("failed");
      expect(s2.reason).toBe(BUILD_RACE_MESSAGE);
    }
  });

  it("fails without consuming when the job reaches finalize with no draft", async () => {
    // Defensive path: a finalize record with a null draft can only arise
    // from store corruption — it must fail safe, never spend.
    const store = createMemoryKvStore();
    let spendCalls = 0;
    const job: BuildJob = {
      v: 1,
      id: "corrupt-job",
      wallet: WALLET_A,
      username: "coolpage",
      bio: "b",
      vibe: "v",
      step: "finalize",
      status: "active",
      draft: null,
      artwork: [],
      artworkTotal: 0,
      createdAt: Date.now(),
    };
    await store.set("buddy:buildjob:corrupt-job", JSON.stringify(job), 60000);
    const r = await stepBuildJob("corrupt-job", WALLET_A, {
      store,
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    });
    expect(r.ok).toBe(false);
    expect(spendCalls).toBe(0);
  });

  it("retries a failed artwork slot and keeps the credit untouched", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    const page = validPage();
    (page.blocks[0] as { avatarImage?: string }).avatarImage =
      IMAGE_MARKERS.avatar;
    let spendCalls = 0;
    let imageCalls = 0;
    const deps = {
      store,
      runCopy: async () =>
        copyText(page, [
          {
            slot: IMAGE_MARKERS.avatar,
            kind: "avatar",
            prompt: "a vivid square avatar, wholesome",
          },
        ]),
      runImage: async () => {
        imageCalls += 1;
        if (imageCalls === 1) return { error: "image service hiccup" };
        return { url: "https://ipfs.io/ipfs/QmAvatarReal" };
      },
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    };
    await stepBuildJob(jobId, WALLET_A, deps); // copy -> images
    const retry = await stepBuildJob(jobId, WALLET_A, deps); // image fails -> retry
    expect(retry.ok && !retry.done && retry.step).toBe("images");
    expect(retry.ok && (retry as { note?: string }).note).toMatch(/retrying/);
    expect(spendCalls).toBe(0);
    const s3 = await stepBuildJob(jobId, WALLET_A, deps); // image succeeds
    expect(s3.ok && !s3.done && s3.step).toBe("finalize");
    const s4 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(s4.ok && s4.done).toBe(true);
    expect(spendCalls).toBe(1);
    const draft = s4.ok && s4.done ? (s4 as { draft: unknown }).draft : null;
    expect(JSON.stringify(draft)).toContain("https://ipfs.io/ipfs/QmAvatarReal");
    expect(JSON.stringify(draft)).not.toContain(IMAGE_MARKERS.avatar);
  });

  it("fails the job without consuming after repeated artwork failures", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    const page = validPage();
    (page.blocks[0] as { avatarImage?: string }).avatarImage =
      IMAGE_MARKERS.avatar;
    let spendCalls = 0;
    const deps = {
      store,
      runCopy: async () =>
        copyText(page, [
          {
            slot: IMAGE_MARKERS.avatar,
            kind: "avatar",
            prompt: "a vivid square avatar, wholesome",
          },
        ]),
      runImage: async () => ({ error: "image service down" }),
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    };
    await stepBuildJob(jobId, WALLET_A, deps); // copy -> images
    const r1 = await stepBuildJob(jobId, WALLET_A, deps); // attempt 1
    expect(r1.ok && !r1.done && r1.step).toBe("images");
    const r2 = await stepBuildJob(jobId, WALLET_A, deps); // attempt 2
    expect(r2.ok && !r2.done && r2.step).toBe("images");
    const r3 = await stepBuildJob(jobId, WALLET_A, deps); // attempt 3 -> failed
    expect(r3.ok).toBe(false);
    expect(r3.ok ? "" : r3.error).toBe("failed");
    expect(r3.ok ? "" : (r3 as { reason?: string }).reason).toMatch(
      /nothing was charged/i
    );
    expect(spendCalls).toBe(0);
    // The failed job stays failed: no draft is delivered, nothing consumed.
    const r4 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(r4.ok).toBe(false);
    expect(spendCalls).toBe(0);
  });

  it("retries slow art-service timeouts without burning hard-error strikes", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    const page = validPage();
    (page.blocks[0] as { avatarImage?: string }).avatarImage =
      IMAGE_MARKERS.avatar;
    let calls = 0;
    const deps = {
      store,
      runCopy: async () =>
        copyText(page, [
          {
            slot: IMAGE_MARKERS.avatar,
            kind: "avatar",
            prompt: "a vivid square avatar, wholesome",
          },
        ]),
      // First two polls time out (slow art service), third succeeds.
      runImage: async () => {
        calls += 1;
        if (calls < 3) return { error: "image service unreachable", timedOut: true };
        return { url: "https://ipfs.io/ipfs/QmTestAvatar" };
      },
      spend: async () => true,
    };
    await stepBuildJob(jobId, WALLET_A, deps); // copy -> images
    const r1 = await stepBuildJob(jobId, WALLET_A, deps); // timeout 1
    expect(r1.ok && !r1.done && r1.step).toBe("images");
    expect(r1.ok && !r1.done ? r1.note : "").toMatch(/slow right now/i);
    const r2 = await stepBuildJob(jobId, WALLET_A, deps); // timeout 2
    expect(r2.ok && !r2.done && r2.step).toBe("images");
    // Timeouts must not count as hard-error strikes: a single real error
    // afterwards is still strike 1 of 3, not strike 3.
    const errDeps = { ...deps, runImage: async () => ({ error: "boom" }) };
    const r3 = await stepBuildJob(jobId, WALLET_A, errDeps);
    expect(r3.ok && !r3.done && r3.step).toBe("images");
    expect(r3.ok && !r3.done ? r3.note : "").toMatch(/1\/3/);
    // And the job still completes once the art service delivers.
    const r4 = await stepBuildJob(jobId, WALLET_A, deps);
    expect(r4.ok && !r4.done && r4.step).toBe("finalize");
  });

  it("fails the job with credit preserved after too many slow timeouts", async () => {
    const store = createMemoryKvStore();
    const started = await startBuildJob(signFor(WALLET_A), WALLET_A, store);
    const jobId = started.ok ? started.jobId : "";
    const page = validPage();
    (page.blocks[0] as { avatarImage?: string }).avatarImage =
      IMAGE_MARKERS.avatar;
    let spendCalls = 0;
    const deps = {
      store,
      runCopy: async () =>
        copyText(page, [
          {
            slot: IMAGE_MARKERS.avatar,
            kind: "avatar",
            prompt: "a vivid square avatar, wholesome",
          },
        ]),
      runImage: async () => ({ error: "image service unreachable", timedOut: true }),
      spend: async () => {
        spendCalls += 1;
        return true;
      },
    };
    await stepBuildJob(jobId, WALLET_A, deps); // copy -> images
    let last: unknown = null;
    for (let i = 0; i < 8; i++) {
      last = await stepBuildJob(jobId, WALLET_A, deps);
      if (i < 7) {
        expect((last as { ok: boolean }).ok).toBe(true);
        expect((last as { done?: boolean }).done ?? false).toBe(false);
      }
    }
    expect((last as { ok: boolean }).ok).toBe(false);
    expect((last as { error?: string }).error).toBe("failed");
    expect((last as { reason?: string }).reason).toMatch(/nothing was charged/i);
    expect(spendCalls).toBe(0);
  });
});
