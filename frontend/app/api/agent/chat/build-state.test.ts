/**
 * build-state tests: HMAC sign/verify, tamper resistance, slot-by-slot
 * advancement, intent gating, and the model-facing progress note.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

import {
  advanceBuildState,
  buildStateNote,
  signBuildState,
  verifyBuildState,
  type BuildState,
} from "./build-state";

const SECRET = "test-secret-for-build-state";

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
});

describe("signBuildState / verifyBuildState", () => {
  it("round-trips a state", () => {
    const s: BuildState = { active: true, u: "coolpage", b: "my bio" };
    const token = signBuildState(s);
    expect(token).toContain(".");
    expect(verifyBuildState(token)).toEqual(s);
  });

  it("rejects a tampered payload", () => {
    const token = signBuildState({ active: true, u: "coolpage" });
    const [payload] = token.split(".");
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    parsed.u = "evilpage";
    const tampered =
      Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url") +
      "." +
      token.split(".")[1];
    expect(verifyBuildState(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signBuildState({ active: true });
    vi.stubEnv("SESSION_SECRET", "a-different-secret");
    expect(verifyBuildState(token)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyBuildState("")).toBeNull();
    expect(verifyBuildState("not-a-token")).toBeNull();
    expect(verifyBuildState(null)).toBeNull();
    expect(verifyBuildState(undefined)).toBeNull();
    expect(verifyBuildState(42)).toBeNull();
  });

  it("sanitizes out-of-range fields even with a valid signature", () => {
    // Craft a signed state with an invalid username by signing raw JSON
    // directly (signBuildState only accepts typed input).
    const payload = Buffer.from(
      JSON.stringify({ active: true, u: "WAY TOO LONG USERNAME!!!", b: "ok bio here" }),
      "utf8"
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    const verified = verifyBuildState(`${payload}.${sig}`);
    expect(verified?.u).toBeUndefined();
    expect(verified?.b).toBe("ok bio here");
  });

  it("is inert without a secret (feature off, no throw)", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(signBuildState({ active: true })).toBe("");
    expect(verifyBuildState("whatever.token")).toBeNull();
  });
});

describe("advanceBuildState", () => {
  it("stays idle on ordinary chat", () => {
    expect(advanceBuildState(null, "cool")).toEqual({ active: false });
    expect(advanceBuildState(null, "what's the treasury?")).toEqual({
      active: false,
    });
  });

  it("activates on build intent", () => {
    const s = advanceBuildState(null, "I want to build my own blockpage");
    expect(s.active).toBe(true);
    expect(s.u).toBeUndefined();
  });

  it("activates on the short replies visitors actually type", () => {
    // Seen live 2026-09-16: "What you built" never matched, so the server
    // state stayed idle while the model looped from stripped history.
    expect(advanceBuildState(null, "What you built").active).toBe(true);
    expect(advanceBuildState(null, "let's build").active).toBe(true);
    expect(advanceBuildState(null, "set up my page").active).toBe(true);
  });

  it("fills username -> bio -> vibe, one slot per turn", () => {
    let s = advanceBuildState(null, "i want to build a page");
    s = advanceBuildState(s, "testpilotbuddy");
    expect(s).toEqual({ active: true, u: "testpilotbuddy" });
    s = advanceBuildState(s, "I make chiptune music and collect consoles");
    expect(s.b).toBe("I make chiptune music and collect consoles");
    expect(s.v).toBeUndefined();
    s = advanceBuildState(s, "neon arcade, dark purple and cyan");
    expect(s.v).toBe("neon arcade, dark purple and cyan");
  });

  it("lowercases the username", () => {
    const s = advanceBuildState({ active: true }, "CoolPage");
    expect(s.u).toBe("coolpage");
  });

  it("takes 'Name X' / 'call me X' as the username once asked for", () => {
    // The server just asked for a username (active, slot empty), so an
    // explicit naming phrase IS the answer. Seen live 2026-09-16.
    expect(advanceBuildState({ active: true }, "Name KimmyPossible")).toEqual({
      active: true,
      u: "kimmypossible",
    });
    expect(advanceBuildState({ active: true }, "call me coolpage")).toEqual({
      active: true,
      u: "coolpage",
    });
  });

  it("does not take naming phrases as a username in ordinary chat", () => {
    // No active build: "call me X" stays conversational, never a slot fill.
    const s = advanceBuildState(null, "call me coolpage");
    expect(s.u).toBeUndefined();
    expect(s.active).toBe(false);
  });

  it("does not take 'what should I pick?' as a username", () => {
    const s = advanceBuildState({ active: true }, "what should I pick?");
    expect(s.u).toBeUndefined();
  });

  it("tracks the full live 2026-09-16 onboarding without derailing", () => {
    let s = advanceBuildState(null, "What you built");
    expect(s.active).toBe(true);
    s = advanceBuildState(s, "Name KimmyPossible");
    expect(s.u).toBe("kimmypossible");
    s = advanceBuildState(s, "The human behind Bacon the Dino");
    expect(s.b).toBe("The human behind Bacon the Dino");
    // Repeating the bio must not reset or derail the flow.
    const s2 = advanceBuildState(s, "The human behind bacon the dino");
    expect(s2.u).toBe("kimmypossible");
    expect(s2.b).toBe("The human behind Bacon the Dino");
    const note = buildStateNote(s2)!;
    expect(note).toContain("Ask ONLY for the vibe/layout next");
    expect(note).not.toContain("username: MISSING");
    expect(note).not.toContain("bio: MISSING");
  });

  it("does not mistake a mid-flow question for a bio", () => {
    const s = advanceBuildState({ active: true, u: "coolpage" }, "what does it cost?");
    expect(s.b).toBeUndefined();
  });

  it("rejects too-short answers", () => {
    const s = advanceBuildState({ active: true, u: "coolpage" }, "ok");
    expect(s.b).toBeUndefined();
  });

  it("restarts a finished build on 'build another one'", () => {
    const full: BuildState = {
      active: true,
      u: "coolpage",
      b: "a proper bio",
      v: "a proper vibe",
    };
    const s = advanceBuildState(full, "build another one for my band");
    expect(s).toEqual({ active: true });
  });

  it("keeps a finished build when the user just chats", () => {
    const full: BuildState = {
      active: true,
      u: "coolpage",
      b: "a proper bio",
      v: "a proper vibe",
    };
    const s = advanceBuildState(full, "thanks!");
    expect(s).toEqual(full);
  });

  it("never throws on weird input", () => {
    expect(() => advanceBuildState(null, "")).not.toThrow();
    expect(() => advanceBuildState({ active: true }, "x".repeat(5000))).not.toThrow();
  });
});

describe("buildStateNote", () => {
  it("returns null when no build is active", () => {
    expect(buildStateNote({ active: false })).toBeNull();
  });

  it("names the next missing item and forbids re-asking", () => {
    const note = buildStateNote({ active: true, u: "coolpage" })!;
    expect(note).toContain("username (collected)");
    expect(note).toContain("bio: MISSING");
    expect(note).toContain("Ask ONLY for the bio next");
    expect(note).toContain("NEVER re-ask");
  });

  it("tells the model to generate when all three are collected", () => {
    const note = buildStateNote({
      active: true,
      u: "coolpage",
      b: "bio here",
      v: "vibe here",
    })!;
    expect(note).toContain("All three are collected");
    expect(note).toContain("output the complete JSON page");
    expect(note).toContain("Do not ask any more questions");
  });

  it("states the 5 HBAR price FIRST when no slots are collected yet", () => {
    const note = buildStateNote({ active: true })!;
    expect(note).toContain("State the price FIRST");
    expect(note).toContain("5 HBAR");
    expect(note).toContain("one-time");
    expect(note).toContain("username");
    expect(note).toContain("one-line bio");
    expect(note).toContain("vibe");
  });

  it("offers the DIY builder alongside the upfront price", () => {
    const note = buildStateNote({ active: true })!;
    expect(note).toContain("/builder");
    expect(note).toContain("just gas fees");
  });

  it("does not repeat the price-first opener once slots are being collected", () => {
    const note = buildStateNote({ active: true, u: "coolpage" })!;
    expect(note).not.toContain("State the price FIRST");
    expect(note).toContain("Ask ONLY for the bio next");
  });
});
