import { describe, expect, it } from "vitest";
import {
  deriveUsername,
  isAccountId,
  isValidUsername,
  normalizeUsername,
} from "./identity";

describe("deriveUsername", () => {
  it("derives user-10424063 from 0.0.10424063", () => {
    expect(deriveUsername("0.0.10424063")).toBe("user-10424063");
  });

  it("handles small account numbers", () => {
    expect(deriveUsername("0.0.2")).toBe("user-2");
  });

  it("trims whitespace", () => {
    expect(deriveUsername("  0.0.123  ")).toBe("user-123");
  });

  it("returns null for non-Hedera formats", () => {
    expect(deriveUsername("0x1234567890123456789012345678901234567890")).toBeNull();
    expect(deriveUsername("brandon")).toBeNull();
    expect(deriveUsername("")).toBeNull();
    expect(deriveUsername("0.0")).toBeNull();
    expect(deriveUsername("0.1.123")).toBeNull();
  });

  it("returns null when the derived name would be too long", () => {
    // user- + 20 digits = 25 chars > 24-char username cap
    expect(deriveUsername("0.0.12345678901234567890")).toBeNull();
  });
});

describe("normalizeUsername", () => {
  it("maps an account id to its derived username", () => {
    expect(normalizeUsername("0.0.10424063")).toBe("user-10424063");
  });

  it("passes plain usernames through lowercased and trimmed", () => {
    expect(normalizeUsername("  0xCreator ")).toBe("0xcreator");
    expect(normalizeUsername("user-10424063")).toBe("user-10424063");
  });
});

describe("isAccountId", () => {
  it("accepts 0.0.x", () => {
    expect(isAccountId("0.0.10424063")).toBe(true);
    expect(isAccountId(" 0.0.2 ")).toBe(true);
  });

  it("rejects other formats", () => {
    expect(isAccountId("0xcreator")).toBe(false);
    expect(isAccountId("user-10424063")).toBe(false);
    expect(isAccountId("")).toBe(false);
  });
});

describe("isValidUsername", () => {
  it("matches the on-chain charset rules", () => {
    expect(isValidUsername("0xcreator")).toBe(true);
    expect(isValidUsername("user-10424063")).toBe(true);
    expect(isValidUsername("ab")).toBe(false); // too short
    expect(isValidUsername("a".repeat(25))).toBe(false); // too long
    expect(isValidUsername("UPPER")).toBe(false);
    expect(isValidUsername("with space")).toBe(false);
    expect(isValidUsername("with_underscore")).toBe(false);
  });
});
