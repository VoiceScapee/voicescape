/**
 * Slice-1 liaison handler tests: tip verification (incl. anti-replay),
 * paid chat (no free tier), deterministic drafts, publish confirmation,
 * and the revenue sweep hook. Mirror node is stubbed; KV is the real
 * in-memory store.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { createMemoryKvStore } from "../store";
import {
  LIAISON_OWNER_EVM,
  LIAISON_TIPS_CONTRACT_ID,
  liaisonDraftKey,
  liaisonEntKey,
  liaisonUsernameTopic,
} from "../../liaison";
import { TIPSENT_TOPIC } from "../../leaderboard";
import { PAGEREGISTERED_TOPIC } from "../../registry-topics";
import {
  handleChat,
  handleDraftDelete,
  handleDraftGet,
  handleDraftPost,
  handlePublishConfirm,
  handleStatus,
  handleVerifyTip,
  type LiaisonDeps,
  type MirrorGetResult,
} from "./handlers";

const SESSION = "0x1111111111111111111111111111111111111111";
const NOW = 1_789_350_068_000;
const PRICE = 5;
const TIP_TX = "0.0.999-1789350068-813732104";

function word(addr: string): string {
  return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
}

function tipLog(from: string = SESSION, txHash?: string) {
  const amountTinybar = BigInt(5) * BigInt(100_000_000);
  const log: Record<string, unknown> = {
    topics: [TIPSENT_TOPIC, liaisonUsernameTopic(), word(from), word(LIAISON_OWNER_EVM)],
    data: "0x" + amountTinybar.toString(16).padStart(64, "0"),
    timestamp: "1789350068.813732104",
  };
  if (txHash) log.transaction_hash = txHash;
  return log;
}

const REGISTER_IFACE = new ethers.Interface([
  "function registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);

function pageRegisteredLog(username: string, owner: string) {
  return {
    topics: [
      PAGEREGISTERED_TOPIC,
      ethers.keccak256(ethers.toUtf8Bytes(username)),
      word(owner),
    ],
    data: "0x",
    timestamp: "1789350068.9",
  };
}

function makeDeps(overrides: Partial<LiaisonDeps> = {}): LiaisonDeps {
  const routes = new Map<string, MirrorGetResult>();
  routes.set(`/api/v1/transactions/${TIP_TX}`, {
    ok: true,
    status: 200,
    json: { transactions: [{ result: "SUCCESS", name: "CONTRACT_CALL" }] },
  });
  routes.set(`/api/v1/contracts/results/${TIP_TX}`, {
    ok: true,
    status: 200,
    json: { logs: [tipLog()] },
  });
  routes.set(
    `/api/v1/contracts/${LIAISON_TIPS_CONTRACT_ID}/results/logs?order=desc&limit=50`,
    { ok: true, status: 200, json: { logs: [tipLog(SESSION, `0x${"aa".repeat(32)}`)] } },
  );
  return {
    kv: createMemoryKvStore(),
    nowMs: () => NOW,
    chatPriceHbar: PRICE,
    buildPriceHbar: PRICE,
    mirrorGet: async (path: string) => {
      const hit = routes.get(path);
      if (hit) return hit;
      return { ok: false, status: 404, json: null };
    },
    ...overrides,
  };
}

async function grant(deps: LiaisonDeps, addr = SESSION) {
  await deps.kv.set(
    liaisonEntKey(addr),
    JSON.stringify({ chatLeft: 50, buildsLeft: 1, expMs: NOW + 7 * 86_400_000 }),
    7 * 86_400_000,
  );
}

describe("handleVerifyTip", () => {
  it("rejects a missing product (400)", async () => {
    const r = await handleVerifyTip(makeDeps(), SESSION, { txHash: "0.0.999@1789350068.813732104" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("product");
  });

  it("rejects a malformed txHash", async () => {
    const r = await handleVerifyTip(makeDeps(), SESSION, { txHash: "nope", product: "chat" });
    expect(r.status).toBe(400);
  });

  it("grants 50 chat messages for a chat tip (no build credit)", async () => {
    const deps = makeDeps();
    const r = await handleVerifyTip(deps, SESSION, {
      txHash: "0.0.999@1789350068.813732104",
      product: "chat",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, product: "chat", chatLeft: 50, buildsLeft: 0 });
    const ent = JSON.parse((await deps.kv.get(liaisonEntKey(SESSION)))!);
    expect(ent.chatLeft).toBe(50);
    expect(ent.buildsLeft).toBe(0);
  });

  it("grants 1 page build for a build tip (no chat credit)", async () => {
    const deps = makeDeps();
    const r = await handleVerifyTip(deps, SESSION, { txHash: TIP_TX, product: "build" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, product: "build", chatLeft: 0, buildsLeft: 1 });
  });

  it("credits a tip logged under the wallet's key-derived EVM address", async () => {
    // Real-world case (2026-09-14): the session is keyed by the long-zero
    // address, but the TipSent log carries msg.sender — the account's
    // key-derived EVM address. The verifier must bridge the alias.
    const longZero = "0x000000000000000000000000000000000000007b"; // 0.0.123
    const keyDerived = "0x0c243aae85131bf396d3fc4c6005a0f885bd7734";
    const deps = makeDeps({
      mirrorGet: async (path: string) => {
        if (path === `/api/v1/transactions/${TIP_TX}`) {
          return {
            ok: true,
            status: 200,
            json: { transactions: [{ result: "SUCCESS", name: "CONTRACT_CALL" }] },
          };
        }
        if (path === `/api/v1/contracts/results/${TIP_TX}`) {
          return { ok: true, status: 200, json: { logs: [tipLog(keyDerived)] } };
        }
        if (path === "/api/v1/accounts/0.0.123") {
          return { ok: true, status: 200, json: { evm_address: keyDerived } };
        }
        return { ok: false, status: 404, json: null };
      },
    });
    const r = await handleVerifyTip(deps, longZero, { txHash: TIP_TX, product: "build" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, product: "build", buildsLeft: 1 });
  });

  it("accumulates on top of an existing entitlement", async () => {
    const deps = makeDeps();
    await deps.kv.set(
      liaisonEntKey(SESSION),
      JSON.stringify({ chatLeft: 10, buildsLeft: 1, expMs: NOW + 86_400_000 }),
      86_400_000,
    );
    const r = await handleVerifyTip(deps, SESSION, {
      txHash: "0.0.999@1789350068.813732104",
      product: "chat",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ chatLeft: 60, buildsLeft: 1 });
  });

  it("enforces the per-product price (a chat-priced tip can't buy a build)", async () => {
    const deps = makeDeps({ buildPriceHbar: 10 });
    // The fixture tip is 5 HBAR — enough for chat, not for a 10 HBAR build.
    const r = await handleVerifyTip(deps, SESSION, { txHash: TIP_TX, product: "build" });
    expect(r.status).toBe(404);
  });

  it("rejects replay of the same tip (409)", async () => {
    const deps = makeDeps();
    const first = await handleVerifyTip(deps, SESSION, { txHash: TIP_TX, product: "chat" });
    expect(first.status).toBe(200);
    const second = await handleVerifyTip(deps, SESSION, { txHash: TIP_TX, product: "chat" });
    expect(second.status).toBe(409);
  });

  it("404s when the transaction holds no qualifying tip", async () => {
    const deps = makeDeps({
      mirrorGet: async (path: string) => {
        if (path === `/api/v1/transactions/${TIP_TX}`) {
          return { ok: true, status: 200, json: { transactions: [{ result: "SUCCESS", name: "CONTRACT_CALL" }] } };
        }
        // Logs show a tip from someone else — not this wallet.
        return { ok: true, status: 200, json: { logs: [tipLog("0x2222222222222222222222222222222222222222")] } };
      },
    });
    const r = await handleVerifyTip(deps, SESSION, { txHash: TIP_TX, product: "chat" });
    expect(r.status).toBe(404);
  });

  it("scan:true requires a product and finds the newest unused tip", async () => {
    const deps = makeDeps();
    const missing = await handleVerifyTip(deps, SESSION, { scan: true });
    expect(missing.status).toBe(400);
    const r = await handleVerifyTip(deps, SESSION, { scan: true, product: "build" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body).toMatchObject({ product: "build", buildsLeft: 1 });
  });

  it("runs the revenue sweep after verification (best-effort)", async () => {
    const deps = makeDeps({ afterTipVerified: async () => "0.0.1@2.3" });
    const r = await handleVerifyTip(deps, SESSION, {
      txHash: "0.0.999@1789350068.813732104",
      product: "chat",
    });
    expect(r.status).toBe(200);
    expect(r.body.forwarded).toBe(true);
    expect(r.body.sweepTxId).toBe("0.0.1@2.3");
  });

  it("still verifies when the sweep hook is absent or fails", async () => {
    const missing = await handleVerifyTip(makeDeps(), SESSION, { txHash: TIP_TX, product: "chat" });
    expect(missing.status).toBe(200);
    expect(missing.body.forwarded).toBe(false);
    const failing = await handleVerifyTip(
      makeDeps({
        afterTipVerified: async () => {
          throw new Error("node unreachable");
        },
      }),
      SESSION,
      { scan: true, product: "chat" },
    );
    expect(failing.status).toBe(200);
    expect(failing.body.forwarded).toBe(false);
  });
});

describe("handleStatus", () => {
  it("returns the public prices without a session", async () => {
    const r = await handleStatus(makeDeps(), null);
    expect(r.status).toBe(200);
    expect(r.body.chatPriceHbar).toBe(PRICE);
    expect(r.body.buildPriceHbar).toBe(PRICE);
    expect(r.body.chatLeft).toBeUndefined();
  });

  it("returns credits for an entitled wallet (no free tier)", async () => {
    const deps = makeDeps();
    await grant(deps);
    const r = await handleStatus(deps, SESSION);
    expect(r.body).toMatchObject({ chatLeft: 50, buildsLeft: 1 });
    expect(r.body.freeLeft).toBeUndefined();
    expect(r.body.freeMessages).toBeUndefined();
  });
});

describe("handleChat", () => {
  it("402s on the very first message without a paid session (no free tier)", async () => {
    const r = await handleChat(makeDeps(), SESSION, { message: "what is voicescape" });
    expect(r.status).toBe(402);
    expect(r.body.chatPriceHbar).toBe(PRICE);
    expect(r.body.error).toContain("50 messages");
  });

  it("spends paid chat credits", async () => {
    const deps = makeDeps();
    await grant(deps);
    const r = await handleChat(deps, SESSION, { message: "how do tips work" });
    expect(r.status).toBe(200);
    expect(r.body.chatLeft).toBe(49);
    expect(r.body.freeLeft).toBeUndefined();
  });

  it("answers from the knowledge base, honestly falls back otherwise", async () => {
    const deps = makeDeps();
    await grant(deps);
    const known = await handleChat(deps, SESSION, { message: "how do tips work on voicescape" });
    expect(known.status).toBe(200);
    expect(known.body.answer).toContain("98");
    const unknown = await handleChat(deps, SESSION, { message: "what is the weather on mars" });
    expect(unknown.status).toBe(200);
    expect(unknown.body.answer).toContain("Discord");
  });

  it("rejects empty and overlong messages", async () => {
    const deps = makeDeps();
    expect((await handleChat(deps, SESSION, { message: "" })).status).toBe(400);
    expect((await handleChat(deps, SESSION, { message: "x".repeat(1001) })).status).toBe(400);
  });
});

describe("handleDraftPost/Get/Delete", () => {
  const form = {
    templateId: "business-card",
    displayName: "Test User",
    heroTitle: "Builder of things",
    bio: "Hello world",
    usernameHint: "test-user",
    accent: "#ff0000",
  };

  it("402s without a paid build credit (names the build price)", async () => {
    const r = await handleDraftPost(makeDeps(), SESSION, form);
    expect(r.status).toBe(402);
    expect(r.body.buildPriceHbar).toBe(PRICE);
    expect(r.body.error).toContain("per build");
  });

  it("assembles a human, wallet-bound draft", async () => {
    const deps = makeDeps();
    await grant(deps);
    const r = await handleDraftPost(deps, SESSION, form);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, templateId: "business-card", usernameHint: "test-user" });

    const got = await handleDraftGet(deps, SESSION);
    expect(got.status).toBe(200);
    const draft = got.body.draft as {
      pageJson: { ownerType?: string; blocks: { type: string }[]; theme: { accent: string } };
      usernameHint: string | null;
    };
    // Non-custody: liaison drafts are always human pages, no operator block.
    expect(draft.pageJson.ownerType).toBe("human");
    expect(draft.pageJson.blocks.some((b) => b.type === "operator")).toBe(false);
    expect(draft.pageJson.theme.accent).toBe("#ff0000");
    expect(draft.usernameHint).toBe("test-user");
  });

  it("refuses agent templates", async () => {
    const deps = makeDeps();
    await grant(deps);
    const r = await handleDraftPost(deps, SESSION, { templateId: "agent-personal" });
    expect(r.status).toBe(400);
  });

  it("refuses unknown templates and PII", async () => {
    const deps = makeDeps();
    await grant(deps);
    expect((await handleDraftPost(deps, SESSION, { templateId: "nope" })).status).toBe(400);
    // PII can never reach a draft (it would be pinned to immutable IPFS).
    const pii = await handleDraftPost(deps, SESSION, { ...form, bio: "email me at bob@example.com" });
    expect(pii.status).toBe(400);
  });

  it("keeps one active draft per wallet (overwrite) and deletes cleanly", async () => {
    const deps = makeDeps();
    await deps.kv.set(
      liaisonEntKey(SESSION),
      JSON.stringify({ chatLeft: 50, buildsLeft: 5, expMs: NOW + 7 * 86_400_000 }),
      7 * 86_400_000,
    );
    const first = await handleDraftPost(deps, SESSION, form);
    const second = await handleDraftPost(deps, SESSION, { ...form, displayName: "Second" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const got = await handleDraftGet(deps, SESSION);
    expect((got.body.draft as { draftId: string }).draftId).toBe(second.body.draftId);

    const del = await handleDraftDelete(deps, SESSION);
    expect(del.status).toBe(200);
    expect((await handleDraftGet(deps, SESSION)).status).toBe(404);
    // Another wallet sees nothing.
    expect((await handleDraftGet(deps, "0x9999999999999999999999999999999999999999")).status).toBe(404);
  });
});

describe("handlePublishConfirm", () => {
  const PUB_TX = "0.0.555-1789350068-900000000";

  function pubDeps(): LiaisonDeps {
    const data = REGISTER_IFACE.encodeFunctionData("registerPage", [
      "my-page",
      "bafycid",
      0,
      "0x0000000000000000000000000000000000000000",
      "",
    ]);
    return makeDeps({
      mirrorGet: async (path: string) => {
        if (path === `/api/v1/transactions/${PUB_TX}`) {
          return { ok: true, status: 200, json: { transactions: [{ result: "SUCCESS", name: "CONTRACT_CALL" }] } };
        }
        if (path === `/api/v1/contracts/results/${PUB_TX}`) {
          return {
            ok: true,
            status: 200,
            json: { function_parameters: data, logs: [pageRegisteredLog("my-page", SESSION)] },
          };
        }
        return { ok: false, status: 404, json: null };
      },
    });
  }

  it("rejects bad usernames and tx refs", async () => {
    const deps = pubDeps();
    expect((await handlePublishConfirm(deps, SESSION, { username: "Bad Name!", txHash: PUB_TX })).status).toBe(400);
    expect((await handlePublishConfirm(deps, SESSION, { username: "my-page", txHash: "junk" })).status).toBe(400);
  });

  it("confirms the wallet's own registration and deletes the draft", async () => {
    const deps = pubDeps();
    await deps.kv.set(liaisonDraftKey(SESSION), JSON.stringify({ draftId: "d_1" }), 3_600_000);
    const r = await handlePublishConfirm(deps, SESSION, { username: "my-page", txHash: PUB_TX });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, username: "my-page" });
    expect(await deps.kv.get(liaisonDraftKey(SESSION))).toBeNull();
  });

  it("confirms a registration logged under the key-derived EVM address", async () => {
    // Same aliasing as verify-tip: PageRegistered carries msg.sender.
    const longZero = "0x000000000000000000000000000000000000007b"; // 0.0.123
    const keyDerived = "0x0c243aae85131bf396d3fc4c6005a0f885bd7734";
    const data = REGISTER_IFACE.encodeFunctionData("registerPage", [
      "my-page",
      "bafycid",
      0,
      "0x0000000000000000000000000000000000000000",
      "",
    ]);
    const deps = makeDeps({
      mirrorGet: async (path: string) => {
        if (path === `/api/v1/transactions/${PUB_TX}`) {
          return {
            ok: true,
            status: 200,
            json: { transactions: [{ result: "SUCCESS", name: "CONTRACT_CALL" }] },
          };
        }
        if (path === `/api/v1/contracts/results/${PUB_TX}`) {
          return {
            ok: true,
            status: 200,
            json: { function_parameters: data, logs: [pageRegisteredLog("my-page", keyDerived)] },
          };
        }
        if (path === "/api/v1/accounts/0.0.123") {
          return { ok: true, status: 200, json: { evm_address: keyDerived } };
        }
        return { ok: false, status: 404, json: null };
      },
    });
    const r = await handlePublishConfirm(deps, longZero, { username: "my-page", txHash: PUB_TX });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, username: "my-page" });
  });

  it("records the celebration flag on publish confirm", async () => {
    const deps = pubDeps();
    const r = await handlePublishConfirm(deps, SESSION, { username: "my-page", txHash: PUB_TX });
    expect(r.status).toBe(200);
    const raw = await deps.kv.get(`liaison:celebrate:${SESSION.toLowerCase()}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ username: "my-page" });
  });

  it("status returns and clears the celebration flag once", async () => {
    const deps = pubDeps();
    await deps.kv.set(
      `liaison:celebrate:${SESSION.toLowerCase()}`,
      JSON.stringify({ username: "my-page", atMs: 1 }),
      3_600_000,
    );
    const first = await handleStatus(deps, SESSION);
    expect(first.body).toMatchObject({ celebratedUsername: "my-page" });
    // Second read: flag is gone.
    const second = await handleStatus(deps, SESSION);
    expect(second.body).not.toHaveProperty("celebratedUsername");
  });

  it("rejects a registration owned by someone else", async () => {
    const deps = makeDeps({
      mirrorGet: async (path: string) => {
        if (path === `/api/v1/transactions/${PUB_TX}`) {
          return { ok: true, status: 200, json: { transactions: [{ result: "SUCCESS", name: "CONTRACT_CALL" }] } };
        }
        const data = REGISTER_IFACE.encodeFunctionData("registerPage", [
          "my-page", "bafycid", 0, "0x0000000000000000000000000000000000000000", "",
        ]);
        return {
          ok: true,
          status: 200,
          json: {
            function_parameters: data,
            logs: [pageRegisteredLog("my-page", "0x2222222222222222222222222222222222222222")],
          },
        };
      },
    });
    const r = await handlePublishConfirm(deps, SESSION, { username: "my-page", txHash: PUB_TX });
    expect(r.status).toBe(400);
  });
});
