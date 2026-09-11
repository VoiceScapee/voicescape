/**
 * HCS-10 memo / register-message unit tests.
 *
 * Guarantees:
 * 1. Memo build/parse round-trips for all three topic types.
 * 2. Malformed memos are rejected, never silently accepted.
 * 3. Register messages always carry p:"hcs-10", op:"register", and a
 *    well-formed operator_id.
 * 4. Voicescape agent profiles require a name, description, valid
 *    username, and at least one capability.
 * 5. Registry topic resolution never fabricates a mainnet id.
 */
import { describe, expect, it } from "vitest";
import {
  HCS10_OP,
  HCS10_TOPIC_TYPE,
  buildHcs10RegisterMessage,
  buildHcs10TopicMemo,
  buildVoicescapeAgentProfile,
  getHcs10RegistryTopic,
  hcs10RegistrationSteps,
  isHcs10TopicMemo,
  parseHcs10TopicMemo,
} from "./hcs10";

describe("buildHcs10TopicMemo", () => {
  it("builds the canonical memo format", () => {
    expect(
      buildHcs10TopicMemo({
        indexed: 1,
        ttl: 0,
        type: HCS10_TOPIC_TYPE.INBOUND,
        params: "0.0.1234",
      }),
    ).toBe("hcs-10:1:0:0:0.0.1234");
  });

  it("omits the params segment when absent", () => {
    expect(
      buildHcs10TopicMemo({
        indexed: 0,
        ttl: 86400,
        type: HCS10_TOPIC_TYPE.OUTBOUND,
      }),
    ).toBe("hcs-10:0:86400:1");
  });

  it("rejects an unknown topic type", () => {
    expect(() =>
      buildHcs10TopicMemo({ indexed: 1, ttl: 0, type: 9 as never }),
    ).toThrow(/unknown topic type/);
  });

  it("rejects params containing a colon", () => {
    expect(() =>
      buildHcs10TopicMemo({
        indexed: 1,
        ttl: 0,
        type: HCS10_TOPIC_TYPE.INBOUND,
        params: "a:b",
      }),
    ).toThrow(/must not contain ':'/);
  });

  it("rejects memos over 100 bytes (Hedera topic memo limit)", () => {
    expect(() =>
      buildHcs10TopicMemo({
        indexed: 1,
        ttl: 0,
        type: HCS10_TOPIC_TYPE.INBOUND,
        params: "x".repeat(200),
      }),
    ).toThrow(/exceeds 100 bytes/);
  });
});

describe("parseHcs10TopicMemo", () => {
  it("round-trips build output for every topic type", () => {
    for (const type of Object.values(HCS10_TOPIC_TYPE)) {
      const memo = buildHcs10TopicMemo({ indexed: 1, ttl: 3600, type });
      const parsed = parseHcs10TopicMemo(memo);
      expect(parsed).toEqual({ indexed: 1, ttl: 3600, type });
    }
  });

  it("preserves params", () => {
    const parsed = parseHcs10TopicMemo("hcs-10:0:0:2:0.0.999");
    expect(parsed).toEqual({
      indexed: 0,
      ttl: 0,
      type: HCS10_TOPIC_TYPE.CONNECTION,
      params: "0.0.999",
    });
  });

  it("returns null for non-HCS-10 memos", () => {
    expect(parseHcs10TopicMemo("hello world")).toBeNull();
    expect(parseHcs10TopicMemo("hcs-10:2:0:0")).toBeNull(); // bad indexed
    expect(parseHcs10TopicMemo("hcs-10:1:0:5")).toBeNull(); // bad type
    expect(parseHcs10TopicMemo("")).toBeNull();
  });
});

describe("isHcs10TopicMemo", () => {
  it("accepts valid memos, rejects the rest", () => {
    expect(isHcs10TopicMemo("hcs-10:1:0:0:0.0.1")).toBe(true);
    expect(isHcs10TopicMemo("not a memo")).toBe(false);
  });
});

describe("buildHcs10RegisterMessage", () => {
  it("builds a valid register message", () => {
    const msg = buildHcs10RegisterMessage({
      inboundTopicId: "0.0.111",
      accountId: "0.0.222",
      profileData: '{"name":"Test"}',
    });
    expect(msg).toEqual({
      p: "hcs-10",
      op: HCS10_OP.REGISTER,
      operator_id: "0.0.111@0.0.222",
      data: '{"name":"Test"}',
    });
  });

  it("includes an optional memo", () => {
    const msg = buildHcs10RegisterMessage({
      inboundTopicId: "0.0.111",
      accountId: "0.0.222",
      profileData: "{}",
      memo: "voicescape agent",
    });
    expect(msg.m).toBe("voicescape agent");
  });

  it("rejects malformed topic/account ids", () => {
    expect(() =>
      buildHcs10RegisterMessage({
        inboundTopicId: "nope",
        accountId: "0.0.222",
        profileData: "{}",
      }),
    ).toThrow(/malformed operator_id/);
  });

  it("rejects empty profile data", () => {
    expect(() =>
      buildHcs10RegisterMessage({
        inboundTopicId: "0.0.111",
        accountId: "0.0.222",
        profileData: "   ",
      }),
    ).toThrow(/must not be empty/);
  });
});

describe("buildVoicescapeAgentProfile", () => {
  const base = {
    name: "Helper Bot",
    description: "Answers questions about Voicescape.",
    voicescapeUsername: "helper-bot",
    voicescapePageUrl: "https://voicescape.vercel.app/helper-bot",
    capabilities: ["text-generation"],
  };

  it("serializes a valid profile with the Voicescape link", () => {
    const json = buildVoicescapeAgentProfile(base);
    const p = JSON.parse(json);
    expect(p.name).toBe("Helper Bot");
    expect(p.voicescape.username).toBe("helper-bot");
    expect(p.voicescape.pageUrl).toContain("helper-bot");
    expect(p.capabilities).toEqual(["text-generation"]);
  });

  it("normalizes @-prefixed usernames", () => {
    const p = JSON.parse(
      buildVoicescapeAgentProfile({ ...base, voicescapeUsername: "@Helper-Bot" }),
    );
    expect(p.voicescape.username).toBe("helper-bot");
  });

  it("rejects invalid usernames", () => {
    expect(() =>
      buildVoicescapeAgentProfile({ ...base, voicescapeUsername: "bad name!" }),
    ).toThrow(/invalid Voicescape username/);
  });

  it("requires name, description, and capabilities", () => {
    expect(() =>
      buildVoicescapeAgentProfile({ ...base, name: " " }),
    ).toThrow(/name must not be empty/);
    expect(() =>
      buildVoicescapeAgentProfile({ ...base, capabilities: [] }),
    ).toThrow(/at least one capability/);
  });
});

describe("getHcs10RegistryTopic", () => {
  it("returns the known testnet registry", () => {
    expect(getHcs10RegistryTopic("testnet")).toBe("0.0.7311321");
  });

  it("returns null for mainnet rather than guessing", () => {
    expect(getHcs10RegistryTopic("mainnet")).toBeNull();
  });
});

describe("hcs10RegistrationSteps", () => {
  it("produces a 5-step checklist mentioning the agent name", () => {
    const steps = hcs10RegistrationSteps({
      agentName: "Helper Bot",
      accountId: "0.0.222",
      network: "testnet",
    });
    expect(steps).toHaveLength(5);
    expect(steps.join("\n")).toContain("Helper Bot");
    expect(steps.join("\n")).toContain("0.0.7311321");
  });

  it("tells mainnet users to resolve the registry via the SDK", () => {
    const steps = hcs10RegistrationSteps({
      agentName: "Helper Bot",
      accountId: "0.0.222",
      network: "mainnet",
    });
    expect(steps.join("\n")).toContain("@hashgraphonline/standards-sdk");
  });
});
