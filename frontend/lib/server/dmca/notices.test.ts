import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDmcaAgentContact,
  getNotice,
  listNotices,
  setNoticeStatus,
  submitNotice,
  validateNotice,
  type DmcaNoticeInput,
} from "./notices";
import { resetKvStoreSingleton } from "../store";

const VALID: DmcaNoticeInput = {
  kind: "notice",
  work: "My song 'Neon Harbor'",
  location: "https://voicescape.example/u/someone",
  contactName: "Jane Doe",
  contact: "jane@example.com",
  goodFaith: true,
  perjuryStatement: true,
  signature: "Jane Doe",
};

describe("dmca notice validation", () => {
  it("accepts a complete notice", () => {
    expect(validateNotice(VALID)).toEqual([]);
  });

  it("requires the perjury statement on notices but not counter-notices", () => {
    expect(validateNotice({ ...VALID, perjuryStatement: false }).map((e) => e.field)).toContain(
      "perjuryStatement",
    );
    const counter = { ...VALID, kind: "counter-notice" as const, perjuryStatement: false };
    expect(validateNotice(counter).map((e) => e.field)).not.toContain("perjuryStatement");
  });

  it("requires good-faith confirmation, identity, location and signature", () => {
    const errs = validateNotice({ ...VALID, goodFaith: false, contactName: " ", location: "", signature: "" });
    const fields = errs.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["goodFaith", "contactName", "location", "signature"]));
  });

  it("rejects an invalid reported wallet", () => {
    expect(validateNotice({ ...VALID, reportedWallet: "nope" }).map((e) => e.field)).toContain(
      "reportedWallet",
    );
    expect(validateNotice({ ...VALID, reportedWallet: "0.0.12345" })).toEqual([]);
  });
});

describe("dmca notice log", () => {
  beforeEach(() => {
    resetKvStoreSingleton();
    vi.stubEnv("DMCA_AGENT_CONTACT", "");
  });

  it("stores a notice with an id and receipt timestamp", async () => {
    const n = await submitNotice(VALID, "site");
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(n.receivedAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(n.status).toBe("pending");
    const back = await getNotice(n.id);
    expect(back?.work).toBe(VALID.work);
  });

  it("lists notices newest-first", async () => {
    const a = await submitNotice({ ...VALID, work: "first" });
    const b = await submitNotice({ ...VALID, work: "second" });
    const list = await listNotices();
    expect(list.map((n) => n.id)).toEqual([b.id, a.id]);
  });

  it("updates status with an audit trail", async () => {
    const n = await submitNotice(VALID);
    const updated = await setNoticeStatus(n.id, "actioned", "0.0.999");
    expect(updated?.status).toBe("actioned");
    expect(updated?.statusBy).toBe("0.0.999");
    expect(updated?.statusAt).toBeDefined();
    expect((await getNotice(n.id))?.status).toBe("actioned");
  });

  it("rejects malformed ids and missing notices", async () => {
    expect(await getNotice("../evil")).toBeNull();
    expect(await getNotice("0".repeat(36))).toBeNull();
    expect(await setNoticeStatus("0".repeat(36), "dismissed", "x")).toBeNull();
  });

  it("throws on invalid input", async () => {
    await expect(submitNotice({ ...VALID, work: " " })).rejects.toThrow(/invalid notice/);
  });
});

describe("dmca agent contact", () => {
  it("defaults to Discord #customer-support until the official agent is registered", () => {
    vi.stubEnv("DMCA_AGENT_CONTACT", "");
    expect(getDmcaAgentContact()).toContain("Discord #customer-support");
  });

  it("uses the env contact when set", () => {
    vi.stubEnv("DMCA_AGENT_CONTACT", "agent@example.com");
    expect(getDmcaAgentContact()).toBe("agent@example.com");
  });
});
