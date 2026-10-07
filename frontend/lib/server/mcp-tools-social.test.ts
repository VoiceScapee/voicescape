/**
 * Tests for the MCP social tools (lib/server/mcp-tools-social.ts).
 *
 * All network is mocked — no mirror node, no HCS, no real KV. The agent
 * identity check, topic ids, guards, and tx verification are injected
 * via vi.mock; the store is an in-memory fake (workshop pattern).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { KvStore } from "./store";
import { lookupBlockpage } from "./mcp-tools";
import { requireNotRestricted } from "./townhall/bans";
import { checkContent } from "./townhall/content-filter";
import { verifyUserHcsTx, queryChatRooms, defaultDeps } from "./townhall/handlers";
import { hasBuilderBadge } from "./badges";
import { getTopicId } from "./townhall/topics";
import { isGlobalMod } from "./townhall/mod";
import { countProposalVotes } from "./townhall/votes";
import {
  postForumTool,
  postChatTool,
  createPollTool,
  votePollTool,
  createEventTool,
  type SocialDeps,
} from "./mcp-tools-social";

vi.mock("./mcp-tools", () => ({ lookupBlockpage: vi.fn() }));
vi.mock("./townhall/handlers", () => ({
  defaultDeps: vi.fn(),
  verifyUserHcsTx: vi.fn(),
  queryChatRooms: vi.fn(),
  TOWNHALL_ID_RE: /^[a-z0-9-]{8,64}$/,
}));
vi.mock("./townhall/bans", () => ({ requireNotRestricted: vi.fn() }));
vi.mock("./townhall/content-filter", () => ({ checkContent: vi.fn() }));
vi.mock("./badges", () => ({
  BUILDERS_ROOM_ID: "builders",
  BUILDER_UNLOCK_MESSAGE: "publish a blockpage and receive your first tip to unlock builders chat",
  hasBuilderBadge: vi.fn(),
}));
vi.mock("./townhall/topics", () => ({ getTopicId: vi.fn() }));
vi.mock("./townhall/mod", () => ({ isGlobalMod: vi.fn() }));
vi.mock("./townhall/votes", () => ({ countProposalVotes: vi.fn() }));

class FakeStore implements KvStore {
  private data = new Map<string, { value: string; expiresAt: number }>();
  async incr(key: string, ttlMs: number): Promise<number> {
    const e = this.data.get(key);
    const cur = e && e.expiresAt > Date.now() ? Number(e.value) : 0;
    const next = cur + 1;
    this.data.set(key, { value: String(next), expiresAt: Date.now() + ttlMs });
    return next;
  }
  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const e = this.data.get(key);
    if (e && e.expiresAt > Date.now()) return false;
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  async get(key: string): Promise<string | null> {
    const e = this.data.get(key);
    return e && e.expiresAt > Date.now() ? e.value : null;
  }
  async del(key: string): Promise<void> {
    this.data.delete(key);
  }
  async clearPrefix(prefix: string): Promise<void> {
    for (const key of [...this.data.keys()]) {
      if (key.startsWith(prefix)) this.data.delete(key);
    }
  }
}

const AGENT_PAGE = {
  found: true,
  username: "forge",
  owner_evm: "0x1111111111111111111111111111111111111111",
  owner_account: "0.0.123456",
  owner_type: "agent" as const,
};

function deps(store?: KvStore): SocialDeps {
  return {
    store: store ?? new FakeStore(),
    townhall: { hcs: { queryAll: async () => [] } } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lookupBlockpage).mockResolvedValue(AGENT_PAGE);
  vi.mocked(requireNotRestricted).mockResolvedValue(null);
  vi.mocked(checkContent).mockReturnValue({ allowed: true, reason: null } as never);
  vi.mocked(getTopicId).mockImplementation(((domain: string) =>
    ({ forum: "0.0.1001", chat: "0.0.1002", governance: "0.0.1003" })[domain] ?? null) as never);
  vi.mocked(defaultDeps).mockReturnValue({} as never);
  vi.mocked(verifyUserHcsTx).mockResolvedValue(null);
  vi.mocked(queryChatRooms).mockResolvedValue({
    status: 200,
    json: { rooms: [{ id: "lobby" }, { id: "builders" }, { id: "agent-chat" }] },
  });
  vi.mocked(hasBuilderBadge).mockResolvedValue(true);
  vi.mocked(isGlobalMod).mockReturnValue(false);
  vi.mocked(countProposalVotes).mockReturnValue({ yes: 1, no: 0, abstain: 0 });
});

describe("identity gate", () => {
  it("rejects bad agent_username", async () => {
    const r = await postForumTool({ agent_username: "BAD NAME!!", body: "hi" }, deps());
    expect("error" in r && r.error).toMatch(/agent_username must be a registered blockpage username/);
  });

  it("rejects unregistered pages", async () => {
    vi.mocked(lookupBlockpage).mockResolvedValue({ found: false, username: "nobody" });
    const r = await postForumTool({ agent_username: "nobody", body: "hi" }, deps());
    expect("error" in r && r.error).toMatch(/not a registered blockpage/);
  });

  it("rejects human pages", async () => {
    vi.mocked(lookupBlockpage).mockResolvedValue({ ...AGENT_PAGE, owner_type: "human" as const });
    const r = await postForumTool({ agent_username: "forge", body: "hi" }, deps());
    expect("error" in r && r.error).toMatch(/registered as a human page/);
  });

  it("blocks restricted wallets before anything else", async () => {
    vi.mocked(requireNotRestricted).mockResolvedValue({
      status: 403,
      json: { error: "This wallet has been timed out" },
    });
    const r = await postForumTool({ agent_username: "forge", body: "hi" }, deps());
    expect("error" in r && r.error).toMatch(/timed out/);
    expect(vi.mocked(checkContent)).not.toHaveBeenCalled();
  });
});

describe("post_forum", () => {
  it("prepares a forum post with the exact expected HCS message", async () => {
    const r = await postForumTool(
      { agent_username: "forge", board: "agents", body: "hello town hall" },
      deps(),
    );
    expect(r).toMatchObject({ prepared: true, topic: "0.0.1001", board: "agents" });
    const p = r as { message: Record<string, unknown>; instructions: string };
    expect(p.message).toMatchObject({
      v: 1,
      kind: "post",
      author: "forge",
      board: "agents",
      wall: null,
      body: "hello town hall",
      replyTo: null,
    });
    expect(p.instructions).toMatch(/hcs_tx_id/);
  });

  it("defaults to the general board", async () => {
    const r = await postForumTool({ agent_username: "forge", body: "hi" }, deps());
    expect(r).toMatchObject({ prepared: true, board: "general" });
  });

  it("rejects unknown boards", async () => {
    const r = await postForumTool({ agent_username: "forge", board: "nope", body: "hi" }, deps());
    expect("error" in r && r.error).toMatch(/unknown board/);
  });

  it("blocks the agent-workshop board (use post_agent_feedback)", async () => {
    const r = await postForumTool(
      { agent_username: "forge", board: "agent-workshop", body: "hi" },
      deps(),
    );
    expect("error" in r && r.error).toMatch(/post_agent_feedback/);
  });

  it("blocks post-only boards for non-mods", async () => {
    const r = await postForumTool(
      { agent_username: "forge", board: "announcements", body: "hi" },
      deps(),
    );
    expect("error" in r && r.error).toMatch(/post-only for town hall moderators/);
  });

  it("allows post-only boards when the agent is a global mod", async () => {
    vi.mocked(isGlobalMod).mockReturnValue(true);
    const r = await postForumTool(
      { agent_username: "forge", board: "announcements", body: "hi" },
      deps(),
    );
    expect(r).toMatchObject({ prepared: true, board: "announcements" });
  });

  it("runs the content safety gate before preparing", async () => {
    vi.mocked(checkContent).mockReturnValue({ allowed: false, reason: "blocked category" } as never);
    const r = await postForumTool({ agent_username: "forge", body: "evil" }, deps());
    expect("error" in r && r.error).toMatch(/blocked category/);
  });

  it("enforces the 20/day per-agent rate limit", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 20; i++) {
      const r = await postForumTool({ agent_username: "forge", body: `post ${i}` }, deps(store));
      expect("error" in r).toBe(false);
    }
    const over = await postForumTool({ agent_username: "forge", body: "one more" }, deps(store));
    expect("error" in over && over.error).toMatch(/daily limit reached/);
  });

  it("confirms a signed post via hcs_tx_id verification", async () => {
    const prepared = (await postForumTool(
      { agent_username: "forge", body: "hello", reply_to: 7 },
      deps(),
    )) as { message: Record<string, unknown> };
    const r = await postForumTool(
      { agent_username: "forge", body: "hello", reply_to: 7, hcs_tx_id: "0.0.123456@1700000000.000000000" },
      deps(),
    );
    expect(r).toMatchObject({
      posted: true,
      topic: "0.0.1001",
      tx_id: "0.0.123456@1700000000.000000000",
      reply_to: 7,
    });
    // Content-bound: the verified tx must carry the prepared message.
    expect(vi.mocked(verifyUserHcsTx).mock.calls[0]?.[4]).toEqual(prepared.message);
  });

  it("surfaces verification failures", async () => {
    vi.mocked(verifyUserHcsTx).mockResolvedValue({ status: 400, json: { error: "content mismatch" } });
    const r = await postForumTool(
      { agent_username: "forge", body: "hello", hcs_tx_id: "0.0.123456@1700000000.000000000" },
      deps(),
    );
    expect("error" in r && r.error).toMatch(/content mismatch/);
  });
});

describe("post_chat", () => {
  it("prepares a chat message for an existing room", async () => {
    const r = await postChatTool({ agent_username: "forge", room: "agent-chat", body: "hey" }, deps());
    expect(r).toMatchObject({ prepared: true, topic: "0.0.1002", room: "agent-chat" });
    const p = r as { message: Record<string, unknown> };
    expect(p.message).toMatchObject({ v: 1, kind: "chat", author: "forge", room: "agent-chat", body: "hey" });
  });

  it("rejects unknown rooms", async () => {
    const r = await postChatTool({ agent_username: "forge", room: "void", body: "hey" }, deps());
    expect("error" in r && r.error).toMatch(/unknown chat room/);
  });

  it("requires the Builder badge for the builders room", async () => {
    vi.mocked(hasBuilderBadge).mockResolvedValue(false);
    const r = await postChatTool({ agent_username: "forge", room: "builders", body: "hey" }, deps());
    expect("error" in r && r.error).toMatch(/unlock builders chat/);
  });

  it("enforces the stricter 10/day chat limit", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 10; i++) {
      const r = await postChatTool({ agent_username: "forge", room: "lobby", body: `m${i}` }, deps(store));
      expect("error" in r).toBe(false);
    }
    const over = await postChatTool({ agent_username: "forge", room: "lobby", body: "one more" }, deps(store));
    expect("error" in over && over.error).toMatch(/daily limit reached/);
  });

  it("confirms a signed chat message", async () => {
    const r = await postChatTool(
      { agent_username: "forge", room: "lobby", body: "hey", hcs_tx_id: "0.0.123456@1700000000.000000001" },
      deps(),
    );
    expect(r).toMatchObject({ posted: true, room: "lobby" });
  });
});

describe("create_poll", () => {
  it("prepares a poll with a generated id bound in the message", async () => {
    const r = await createPollTool(
      {
        agent_username: "forge",
        title: "Best feature?",
        body: "pick one",
        closes_at: new Date(Date.now() + 86400000).toISOString(),
      },
      deps(),
    );
    expect(r).toMatchObject({ prepared: true, topic: "0.0.1003" });
    const p = r as { message: Record<string, unknown>; poll_id: string };
    expect(p.poll_id).toMatch(/^[a-z0-9-]{8,64}$/);
    expect(p.message).toMatchObject({
      v: 1,
      kind: "proposal",
      author: "forge",
      id: p.poll_id,
      title: "Best feature?",
      body: "pick one",
    });
  });

  it("rejects a bad closes_at", async () => {
    const r = await createPollTool(
      { agent_username: "forge", title: "t", body: "b", closes_at: "soon" },
      deps(),
    );
    expect("error" in r && r.error).toMatch(/ISO-8601/);
  });

  it("confirms the poll creation", async () => {
    const r = await createPollTool(
      {
        agent_username: "forge",
        title: "Best feature?",
        body: "pick one",
        closes_at: new Date(Date.now() + 86400000).toISOString(),
        poll_id: "best-feature-abc123",
        hcs_tx_id: "0.0.123456@1700000000.000000002",
      },
      deps(),
    );
    expect(r).toMatchObject({ posted: true, poll_id: "best-feature-abc123" });
  });
});

describe("vote_poll", () => {
  it("prepares a vote with the exact expected HCS message", async () => {
    const r = await votePollTool(
      { agent_username: "forge", poll_id: "best-feature-abc123", choice: "yes" },
      deps(),
    );
    expect(r).toMatchObject({ prepared: true, topic: "0.0.1003", poll_id: "best-feature-abc123", choice: "yes" });
    const p = r as { message: Record<string, unknown> };
    expect(p.message).toMatchObject({
      v: 1,
      kind: "proposal-vote",
      author: "forge",
      proposal: "best-feature-abc123",
      voter: "forge",
      choice: "yes",
    });
  });

  it("rejects bad choices", async () => {
    const r = await votePollTool(
      { agent_username: "forge", poll_id: "best-feature-abc123", choice: "maybe" as never },
      deps(),
    );
    expect("error" in r && r.error).toMatch(/"yes", "no" or "abstain"/);
  });

  it("rejects malformed poll ids", async () => {
    const r = await votePollTool({ agent_username: "forge", poll_id: "!!!", choice: "yes" }, deps());
    expect("error" in r && r.error).toMatch(/invalid poll_id/);
  });

  it("confirms the vote and returns the tally", async () => {
    const r = await votePollTool(
      {
        agent_username: "forge",
        poll_id: "best-feature-abc123",
        choice: "no",
        hcs_tx_id: "0.0.123456@1700000000.000000003",
      },
      deps(),
    );
    expect(r).toMatchObject({ voted: true, choice: "no", tally: { yes: 1, no: 0, abstain: 0 } });
  });
});

describe("create_event", () => {
  const eventArgs = {
    agent_username: "forge",
    title: "Agent meetup",
    description: "meet and build",
    starts_at: new Date(Date.now() + 86400000).toISOString(),
  };

  it("refuses non-moderator agents (moderator-only on the web)", async () => {
    const r = await createEventTool(eventArgs, deps());
    expect("error" in r && r.error).toMatch(/only town hall moderators/);
    expect(vi.mocked(verifyUserHcsTx)).not.toHaveBeenCalled();
  });

  it("prepares an event for a mod agent with the id bound in the message", async () => {
    vi.mocked(isGlobalMod).mockReturnValue(true);
    const r = await createEventTool({ ...eventArgs, event_id: "agent-meetup-xyz99" }, deps());
    expect(r).toMatchObject({ prepared: true, topic: "0.0.1003", event_id: "agent-meetup-xyz99" });
    const p = r as { message: Record<string, unknown> };
    expect(p.message).toMatchObject({
      v: 1,
      kind: "event",
      author: "forge",
      id: "agent-meetup-xyz99",
      room: "event-agent-meetup-xyz99",
    });
  });

  it("confirms the event creation", async () => {
    vi.mocked(isGlobalMod).mockReturnValue(true);
    const r = await createEventTool(
      { ...eventArgs, event_id: "agent-meetup-xyz99", hcs_tx_id: "0.0.123456@1700000000.000000004" },
      deps(),
    );
    expect(r).toMatchObject({ posted: true, event_id: "agent-meetup-xyz99" });
  });

  it("rejects a bad starts_at", async () => {
    vi.mocked(isGlobalMod).mockReturnValue(true);
    const r = await createEventTool({ ...eventArgs, starts_at: "yesterday-ish" }, deps());
    expect("error" in r && r.error).toMatch(/ISO-8601/);
  });
});
