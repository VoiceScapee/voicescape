import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSanctionsBlocklist,
  isSanctionsScreeningEnabled,
  screenAddress,
} from "./sanctions";

describe("sanctions screening (env-gated, default off)", () => {
  beforeEach(() => {
    vi.stubEnv("SANCTIONS_SCREENING_ENABLED", "");
    vi.stubEnv("SANCTIONS_BLOCKLIST_ADDRESSES", "");
  });

  it("is OFF by default and never blocks", () => {
    expect(isSanctionsScreeningEnabled()).toBe(false);
    const r = screenAddress("0.0.12345");
    expect(r).toEqual({ allowed: true, screened: false });
  });

  it("parses truthy flag values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      vi.stubEnv("SANCTIONS_SCREENING_ENABLED", v);
      expect(isSanctionsScreeningEnabled()).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", ""]) {
      vi.stubEnv("SANCTIONS_SCREENING_ENABLED", v);
      expect(isSanctionsScreeningEnabled()).toBe(false);
    }
  });

  it("canonicalizes blocklist entries (0.0.x and 0x forms dedupe)", () => {
    vi.stubEnv("SANCTIONS_BLOCKLIST_ADDRESSES", "0.0.999, 0xABCDEF0000000000000000000000000000000009, junk, ");
    const list = getSanctionsBlocklist();
    // 0.0.999 canonicalizes to its long-zero 0x form; junk is dropped
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.startsWith("0x"))).toBe(true);
  });

  it("blocks a listed address when enabled, in either address form", () => {
    vi.stubEnv("SANCTIONS_SCREENING_ENABLED", "true");
    vi.stubEnv("SANCTIONS_BLOCKLIST_ADDRESSES", "0.0.4242");
    const blocked = screenAddress("0.0.4242");
    expect(blocked.allowed).toBe(false);
    expect(blocked.screened).toBe(true);
    expect(blocked.reason).toMatch(/blocklist/);
    // A different address still passes
    expect(screenAddress("0.0.4243")).toEqual({ allowed: true, screened: true });
  });

  it("fails open with a logged warning when enabled but no blocklist is configured", () => {
    vi.stubEnv("SANCTIONS_SCREENING_ENABLED", "true");
    const r = screenAddress("0.0.1");
    expect(r.allowed).toBe(true);
    expect(r.screened).toBe(true);
    expect(r.reason).toMatch(/no blocklist/);
  });

  it("rejects invalid addresses when enabled", () => {
    vi.stubEnv("SANCTIONS_SCREENING_ENABLED", "true");
    vi.stubEnv("SANCTIONS_BLOCKLIST_ADDRESSES", "0.0.1");
    expect(screenAddress("not-an-address").allowed).toBe(false);
  });
});
