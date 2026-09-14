/**
 * A2A AgentCard shape tests — required fields per A2A v1.0.0 §4.4.1.
 */
import { describe, expect, it } from "vitest";
import { buildAgentCard } from "./card";

const ORIGIN = "https://voicescape.vercel.app";

describe("buildAgentCard", () => {
  const card = buildAgentCard(ORIGIN);

  it("has every required top-level field", () => {
    expect(typeof card.name).toBe("string");
    expect(card.name.length).toBeGreaterThan(0);
    expect(typeof card.description).toBe("string");
    expect(card.description.length).toBeGreaterThan(0);
    expect(typeof card.version).toBe("string");
    expect(typeof card.capabilities).toBe("object");
    expect(Array.isArray(card.defaultInputModes)).toBe(true);
    expect(card.defaultInputModes.length).toBeGreaterThan(0);
    expect(Array.isArray(card.defaultOutputModes)).toBe(true);
    expect(card.defaultOutputModes.length).toBeGreaterThan(0);
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it("declares a JSONRPC interface at an absolute HTTPS URL on this origin", () => {
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect(card.supportedInterfaces.length).toBeGreaterThan(0);
    const first = card.supportedInterfaces[0];
    expect(first.url).toBe(`${ORIGIN}/api/a2a`);
    expect(first.url.startsWith("https://")).toBe(true);
    expect(first.protocolBinding).toBe("JSONRPC");
    expect(first.protocolVersion).toBe("1.0");
  });

  it("gives every skill the required id/name/description/tags", () => {
    for (const skill of card.skills) {
      expect(typeof skill.id).toBe("string");
      expect(skill.id.length).toBeGreaterThan(0);
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(Array.isArray(skill.tags)).toBe(true);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  it("includes an onboarding skill grounded in real routes", () => {
    const ids = card.skills.map((s) => s.id);
    expect(ids).toContain("voicescape-onboard");
    const onboard = card.skills.find((s) => s.id === "voicescape-onboard");
    expect(onboard?.description).toMatch(/registerPage/);
  });

  it("points documentation at the real agent join page", () => {
    expect(card.documentationUrl).toBe(`${ORIGIN}/agents/join`);
  });

  it("strips trailing slashes from the origin", () => {
    const withSlash = buildAgentCard("https://voicescape.vercel.app/");
    expect(withSlash.supportedInterfaces[0].url).toBe(`${ORIGIN}/api/a2a`);
  });

  it("stays honest: no claims about live agent users or traffic", () => {
    const text = JSON.stringify(card).toLowerCase();
    expect(text).not.toMatch(/thousands|millions|live users|active agents|growing network of agents/);
    expect(card.description).toMatch(/read-only/i);
  });

  it("declares streaming support and no push notifications", () => {
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it("identifies as danny, the agent liaison, with verifiable on-chain facts", () => {
    expect(card.name).toBe("danny");
    expect(card.description).toMatch(/0\.0\.10857765/);
    expect(card.description).toMatch(/'danny'/);
    expect(card.description).toMatch(/\/danny/);
    expect(card.description).toMatch(/liaison/i);
    expect(card.description).toMatch(/ownerType AGENT/i);
  });
});
