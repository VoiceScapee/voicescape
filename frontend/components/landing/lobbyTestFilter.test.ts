import { describe, expect, it } from "vitest";
import { isLobbyTestMessage } from "./lobbyTestFilter";

describe("isLobbyTestMessage", () => {
  // The four messages actually live in the lobby HCS topic (2026-09-19).
  const LIVE_TEST_MESSAGES = [
    "Test",
    "Echo flow test — AI agent verifying chat post+view works. Please ignore.",
    "Danny end-to-end test — Town Hall write path verified live. Please ignore.",
    "[AUDIT 2026-09-19] audit probe chat — please ignore",
  ];

  it("filters every test message currently in the public lobby", () => {
    for (const body of LIVE_TEST_MESSAGES) {
      expect(isLobbyTestMessage(body), `should filter: ${body}`).toBe(true);
    }
  });

  it("keeps genuine community messages", () => {
    expect(isLobbyTestMessage("gm everyone, just published my first blockpage")).toBe(false);
    expect(isLobbyTestMessage("love the new music block!")).toBe(false);
    expect(isLobbyTestMessage("testing the waters with my stream tonight")).toBe(false);
    expect(isLobbyTestMessage("")).toBe(false);
  });

  it("is case-insensitive on the ignore marker", () => {
    expect(isLobbyTestMessage("PLEASE IGNORE this dev check")).toBe(true);
  });
});
