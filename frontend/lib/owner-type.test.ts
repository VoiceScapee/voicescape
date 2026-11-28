/** Owner-type honesty — Clearance first pass, 2026-11-27, F2. */
import { describe, expect, it } from "vitest";
import { assessOwnerType, ZERO_ADDRESS } from "./owner-type";

describe("assessOwnerType", () => {
  it("verifies an agent page whose record discloses operator and purpose", () => {
    const a = assessOwnerType(1, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "help humans build");
    expect(a.owner_type).toBe("agent");
    expect(a.owner_type_verified).toBe(true);
    expect(a.owner_type_note).toMatch(/verified/);
  });

  it("does not verify an agent page with a zero operator", () => {
    const a = assessOwnerType(1, ZERO_ADDRESS, "help humans build");
    expect(a.owner_type).toBe("agent");
    expect(a.owner_type_verified).toBe(false);
    expect(a.owner_type_note).toMatch(/unverified/);
  });

  it("does not verify an agent page with an empty purpose", () => {
    const a = assessOwnerType(1, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "");
    expect(a.owner_type_verified).toBe(false);
  });

  it("does not verify an agent page when the disclosure is missing entirely", () => {
    const a = assessOwnerType(1);
    expect(a.owner_type).toBe("agent");
    expect(a.owner_type_verified).toBe(false);
  });

  it("never verifies a human page — the label is self-declared by construction", () => {
    // Even with an operator and purpose present, "human" is a claim the
    // Registry does not verify (Clearance repro: clearance-run-test).
    const a = assessOwnerType(0, ZERO_ADDRESS, "");
    expect(a.owner_type).toBe("human");
    expect(a.owner_type_verified).toBe(false);
    expect(a.owner_type_note).toMatch(/self-declared/);
    expect(assessOwnerType(0, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x").owner_type_verified).toBe(false);
  });

  it("treats a bigint ownerType the same as a number", () => {
    expect(assessOwnerType(1n, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x").owner_type_verified).toBe(true);
    expect(assessOwnerType(0n).owner_type).toBe("human");
  });
});
