import { describe, expect, it } from "vitest";
import {
  decodeOwnerTypeFromLogData,
  identityPalette,
  IDENTITY_BAND,
} from "./identity-palette";

describe("identityPalette", () => {
  it("is deterministic: same seed + type → same palette, every time", () => {
    const a = identityPalette("danny", "agent");
    const b = identityPalette("danny", "agent");
    expect(b).toEqual(a);
  });

  it("keeps humans in the violet/ultraviolet band and agents in cobalt/azure", () => {
    for (const name of ["alice", "bob", "carol", "dave", "erin", "forge"]) {
      const human = identityPalette(name, "human");
      expect(human.hue).toBeGreaterThanOrEqual(243);
      expect(human.hue).toBeLessThanOrEqual(261);
      const agent = identityPalette(name, "agent");
      expect(agent.hue).toBeGreaterThanOrEqual(208);
      expect(agent.hue).toBeLessThanOrEqual(230);
    }
  });

  it("gives different identities different palettes (no single-color collapse)", () => {
    const primaries = new Set(
      ["alice", "bob", "carol", "dave", "erin", "forge", "echo", "bacon-the-dino"].map(
        (n) => identityPalette(n, "agent").primary,
      ),
    );
    expect(primaries.size).toBeGreaterThan(1);
  });

  it("separates the two communities for the same seed", () => {
    const human = identityPalette("danny", "human");
    const agent = identityPalette("danny", "agent");
    expect(human.primary).not.toBe(agent.primary);
  });
});

describe("IDENTITY_BAND", () => {
  it("uses Hedera's Ultraviolet for humans and Cobalt for agents", () => {
    expect(IDENTITY_BAND.human).toBe("#8259EF");
    expect(IDENTITY_BAND.agent).toBe("#2D84EB");
  });
});

describe("decodeOwnerTypeFromLogData", () => {
  const word = (n: number) => "0".repeat(64) + n.toString(16).padStart(64, "0");
  it("decodes 0 → human and 1 → agent from the 2nd word", () => {
    expect(decodeOwnerTypeFromLogData("0x" + word(0))).toBe("human");
    expect(decodeOwnerTypeFromLogData(word(1))).toBe("agent");
  });
  it("fails closed on missing, short, or unknown data", () => {
    expect(decodeOwnerTypeFromLogData(undefined)).toBeNull();
    expect(decodeOwnerTypeFromLogData("0x1234")).toBeNull();
    expect(decodeOwnerTypeFromLogData(word(7))).toBeNull();
  });
});
