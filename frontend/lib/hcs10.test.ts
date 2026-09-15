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
  buildHcs14Uaid,
  buildVoicescapeAgentProfile,
  buildVoicescapeAgentProfileWithUaid,
  mapCapabilitiesToSkills,
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

  it("emits HCS-11 canonical fields", () => {
    const p = JSON.parse(buildVoicescapeAgentProfile(base));
    expect(p.version).toBe("1.0");
    expect(p.type).toBe(1);
    expect(p.display_name).toBe("Helper Bot");
    expect(p.name).toBe("Helper Bot"); // back-compat
    expect(p.skills).toEqual([0]); // "text-generation" -> skill 0
  });

  it("omits uaid when the account is unknown rather than faking it", () => {
    const p = JSON.parse(buildVoicescapeAgentProfile(base));
    expect(p.uaid).toBeUndefined();
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

describe("mapCapabilitiesToSkills", () => {
  it("maps keywords to HCS-14 skill ids, sorted and deduped", () => {
    expect(mapCapabilitiesToSkills(["text-generation"])).toEqual([0]);
    expect(mapCapabilitiesToSkills(["tipping", "hedera"])).toEqual([33]);
    expect(mapCapabilitiesToSkills(["chat", "text generation"])).toEqual([0]);
    expect(mapCapabilitiesToSkills(["mystery-capability-xyz"])).toEqual([]);
    expect(mapCapabilitiesToSkills([])).toEqual([]);
  });
});

describe("buildHcs14Uaid", () => {
  const base = {
    name: "Helper Bot",
    accountId: "0.0.10862061",
    network: "mainnet" as const,
    capabilities: ["text-generation"],
  };

  it("builds a well-formed uaid:aid: identifier", async () => {
    const uaid = await buildHcs14Uaid(base);
    expect(uaid).toMatch(
      /^uaid:aid:[1-9A-HJ-NP-Za-km-z]+;uid=0\.0\.10862061;registry=voicescape;proto=hcs-10;nativeId=hedera:mainnet:0\.0\.10862061$/,
    );
  });

  it("is deterministic — same inputs, same uaid", async () => {
    expect(await buildHcs14Uaid(base)).toBe(await buildHcs14Uaid(base));
  });

  it("changes when the account changes", async () => {
    const other = await buildHcs14Uaid({ ...base, accountId: "0.0.999" });
    expect(other).not.toBe(await buildHcs14Uaid(base));
    expect(other).toContain("nativeId=hedera:mainnet:0.0.999");
  });

  it("rejects malformed account ids", async () => {
    await expect(
      buildHcs14Uaid({ ...base, accountId: "not-an-account" }),
    ).rejects.toThrow(/malformed account id/);
  });
});

describe("buildVoicescapeAgentProfileWithUaid", () => {
  it("embeds a verifiable uaid anyone can recompute", async () => {
    const json = await buildVoicescapeAgentProfileWithUaid({
      name: "Helper Bot",
      description: "Answers questions about Voicescape.",
      voicescapeUsername: "helper-bot",
      voicescapePageUrl: "https://voicescape.vercel.app/helper-bot",
      capabilities: ["text-generation"],
      accountId: "0.0.10862061",
      network: "mainnet",
    });
    const p = JSON.parse(json);
    expect(p.version).toBe("1.0");
    expect(p.type).toBe(1);
    expect(p.display_name).toBe("Helper Bot");
    // The uaid recomputed from the same inputs must match — no trust needed.
    const recomputed = await buildHcs14Uaid({
      name: "Helper Bot",
      accountId: "0.0.10862061",
      network: "mainnet",
      capabilities: ["text-generation"],
    });
    expect(p.uaid).toBe(recomputed);
  });
});

describe("getHcs10RegistryTopic", () => {
  it("returns the known testnet registry", () => {
    expect(getHcs10RegistryTopic("testnet")).toBe("0.0.7311321");
  });

  it("returns null for mainnet rather than guessing", () => {
    expect(getHcs10RegistryTopic("mainnet")).toBeNull();
  });

  it("HCS10_REGISTRY_TOPIC env override wins on both networks", () => {
    const prev = process.env.HCS10_REGISTRY_TOPIC;
    process.env.HCS10_REGISTRY_TOPIC = "0.0.999999";
    try {
      expect(getHcs10RegistryTopic("mainnet")).toBe("0.0.999999");
      expect(getHcs10RegistryTopic("testnet")).toBe("0.0.999999");
    } finally {
      if (prev === undefined) delete process.env.HCS10_REGISTRY_TOPIC;
      else process.env.HCS10_REGISTRY_TOPIC = prev;
    }
  });

  it("ignores a malformed HCS10_REGISTRY_TOPIC override", () => {
    const prev = process.env.HCS10_REGISTRY_TOPIC;
    process.env.HCS10_REGISTRY_TOPIC = "not-a-topic";
    try {
      expect(getHcs10RegistryTopic("mainnet")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.HCS10_REGISTRY_TOPIC;
      else process.env.HCS10_REGISTRY_TOPIC = prev;
    }
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

  it("step-1 inbound memo uses indexed=0, matching the unsigned transaction bytes", () => {
    // Regression: the checklist once said indexed=1 while
    // buildHcs10TopicTransactions emits indexed=0 — the words must match
    // the bytes we hand the agent.
    const steps = hcs10RegistrationSteps({
      agentName: "Helper Bot",
      accountId: "0.0.222",
      network: "testnet",
    });
    expect(steps[0]).toContain("hcs-10:0:0:0:0.0.222");
    expect(steps[0]).not.toContain("hcs-10:0:1:0:0.0.222");
  });
});
