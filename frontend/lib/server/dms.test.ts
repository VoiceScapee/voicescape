import { describe, it, expect } from "vitest";
import { createMemoryKvStore } from "./store";
import { createMemoryQuotaStore } from "./quota";
import {
  ADDR_RE,
  getBlocked,
  getInbox,
  getThread,
  isBlockedBy,
  listDmReports,
  reportDm,
  sendDm,
  setBlocked,
  type DmSendDeps,
} from "./dms";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function deps(dmLimit = 50, reportLimit = 10) {
  const store = createMemoryKvStore();
  const quota = createMemoryQuotaStore();
  const d: DmSendDeps = { store, quota, dmLimit };
  return { store, quota, d, reportLimit };
}

describe("dms", () => {
  it("sends and both sides see the thread + inbox", async () => {
    const { d, store } = deps();
    const res = await sendDm(d, ALICE, BOB, "hello bob");
    expect(res.ok).toBe(true);

    const thread = await getThread(store, BOB, ALICE);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ from: ALICE, to: BOB, message: "hello bob" });

    const inboxBob = await getInbox(store, BOB);
    expect(inboxBob).toHaveLength(1);
    expect(inboxBob[0].with).toBe(ALICE);

    // reply
    await sendDm(d, BOB, ALICE, "hey alice");
    expect(await getThread(store, ALICE, BOB)).toHaveLength(2);
  });

  it("rejects invalid recipient, empty, oversized, and self-DM", async () => {
    const { d } = deps();
    expect(await sendDm(d, ALICE, "nope", "hi")).toMatchObject({ ok: false, status: 400 });
    expect(await sendDm(d, ALICE, BOB, "   ")).toMatchObject({ ok: false, status: 400 });
    expect(await sendDm(d, ALICE, BOB, "x".repeat(1001))).toMatchObject({ ok: false, status: 400 });
    expect(await sendDm(d, ALICE, ALICE, "hi me")).toMatchObject({ ok: false, status: 400 });
  });

  it("blocks phone numbers and emails (PII rule)", async () => {
    const { d, store } = deps();
    const r1 = await sendDm(d, ALICE, BOB, "call me at 555-123-4567");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.status).toBe(400);
    const r2 = await sendDm(d, ALICE, BOB, "email me at test@example.com");
    expect(r2.ok).toBe(false);
    expect((await getThread(store, ALICE, BOB))).toHaveLength(0);
  });

  it("allows normal messages that merely contain digits", async () => {
    const { d, store } = deps();
    const res = await sendDm(d, ALICE, BOB, "see you at 7pm, bring 2 pizzas");
    expect(res.ok).toBe(true);
    expect(await getThread(store, ALICE, BOB)).toHaveLength(1);
  });

  it("enforces the per-wallet daily quota", async () => {
    const { d } = deps(2);
    expect((await sendDm(d, ALICE, BOB, "one")).ok).toBe(true);
    expect((await sendDm(d, ALICE, BOB, "two")).ok).toBe(true);
    const third = await sendDm(d, ALICE, BOB, "three");
    expect(third).toMatchObject({ ok: false, status: 429 });
  });

  it("blocked senders get a 403", async () => {
    const { d, store } = deps();
    await setBlocked(store, BOB, ALICE, true);
    expect(await isBlockedBy(store, BOB, ALICE)).toBe(true);
    const res = await sendDm(d, ALICE, BOB, "you can't see this");
    expect(res).toMatchObject({ ok: false, status: 403 });

    // unblock restores delivery
    await setBlocked(store, BOB, ALICE, false);
    expect(await isBlockedBy(store, BOB, ALICE)).toBe(false);
    expect((await sendDm(d, ALICE, BOB, "now you can")).ok).toBe(true);
  });

  it("block list round-trips and rejects bad input", async () => {
    const { store } = deps();
    await expect(setBlocked(store, ALICE, BOB, true)).resolves.toEqual([BOB]);
    await expect(setBlocked(store, ALICE, BOB, true)).resolves.toEqual([BOB]); // idempotent
    expect(await getBlocked(store, ALICE)).toEqual([BOB]);
    await expect(setBlocked(store, ALICE, "junk", true)).rejects.toThrow("invalid-address");
    await expect(setBlocked(store, ALICE, ALICE, true)).rejects.toThrow("cannot-block-self");
  });

  it("does not lose messages under concurrent sends", async () => {
    const { d, store } = deps(100);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? sendDm(d, ALICE, BOB, `a${i}`) : sendDm(d, BOB, ALICE, `b${i}`),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await getThread(store, ALICE, BOB)).toHaveLength(10);
  });

  it("stores reports for founder review and rate-limits them", async () => {
    const { store, quota, reportLimit } = deps(50, 1);
    const depsR = { store, quota, reportLimit };
    const r1 = await reportDm(depsR, ALICE, BOB, "sending me spam links nonstop");
    expect(r1.ok).toBe(true);
    const r2 = await reportDm(depsR, ALICE, BOB, "another one");
    expect(r2).toMatchObject({ ok: false, status: 429 });

    const reports = await listDmReports(store);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reporter: ALICE, reported: BOB });
  });

  it("rejects short report reasons", async () => {
    const { store, quota, reportLimit } = deps();
    const r = await reportDm({ store, quota, reportLimit }, ALICE, BOB, "spam");
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("ADDR_RE matches 0x EVM addresses", () => {
    expect(ADDR_RE.test(ALICE)).toBe(true);
    expect(ADDR_RE.test("0x123")).toBe(false);
  });
});
