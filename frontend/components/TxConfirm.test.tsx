/**
 * Anti "rug pull moment" regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-13: the dead "Tipping…" wait between tapping tip
 * and on-chain confirmation feels like the money vanished. Two honest
 * phases replace it:
 *
 * Phase A (wallet hasn't returned a hash): an alive animation plus the
 * truth — nothing has left the wallet yet.
 *
 * Phase B (hash in hand, polling for consensus): the broadcast transaction
 * id with a track-live explorer link, so the user can watch it confirm.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const confirmSrc = readFileSync(join(here, "TxConfirm.tsx"), "utf8");
const cssSrc = readFileSync(join(here, "..", "app", "globals.css"), "utf8");
const pageSrc = readFileSync(join(here, "..", "app", "[username]", "page.tsx"), "utf8");
const postCardSrc = readFileSync(join(here, "townhall", "PostCard.tsx"), "utf8");

describe("TxConfirming in-flight proof", () => {
  it("accepts an optional txId + explorerBase", () => {
    expect(confirmSrc).toMatch(/txId\?: string \| null/);
    expect(confirmSrc).toMatch(/explorerBase\?: string/);
  });

  it("renders the broadcast tx hash with a track-live link when provided", () => {
    expect(confirmSrc).toContain("tx-confirm-txid");
    expect(confirmSrc).toContain("Track on HashScan");
    expect(confirmSrc).toMatch(/\{txId && explorerBase &&/);
  });

  it("stays unchanged for callers without a tx id", () => {
    // The marketplace and polls flows don't pass a hash — nothing breaks.
    expect(confirmSrc).toMatch(/title = "Confirming on Hedera…"/);
  });
});

describe("in-flight proof styles", () => {
  it("styles the tx hash and track link", () => {
    expect(cssSrc).toContain(".tx-confirm-tx");
    expect(cssSrc).toContain(".tx-confirm-txid");
    expect(cssSrc).toContain(".tx-confirm-track");
  });
});

describe("blockpage TipBox waiting phases", () => {
  it("phase A: alive 'waiting on wallet' state while busy without a hash", () => {
    expect(pageSrc).toMatch(/busy && !confirmTxId &&/);
    expect(pageSrc).toContain('title="Waiting on your wallet…"');
    expect(pageSrc).toMatch(/If you already approved, Voicescape will keep checking for the result/);
  });

  it("phase B: passes the broadcast hash to the confirming state", () => {
    expect(pageSrc).toMatch(
      /<TxConfirming[\s\S]*txId=\{confirmTxId\}[\s\S]*explorerBase=\{chain\.blockExplorer\}/,
    );
  });

  it("the dead 15s 'still working' note is gone", () => {
    expect(pageSrc).not.toContain("waitingLong");
    expect(pageSrc).not.toContain("Still working — if you already approved");
  });
});

describe("townhall PostCard waiting phases", () => {
  it("phase A: alive 'waiting on wallet' state while busy without a hash", () => {
    expect(postCardSrc).toMatch(/busy && !confirmTxId &&/);
    expect(postCardSrc).toContain('title="Waiting on your wallet…"');
  });

  it("phase B: passes the broadcast hash to the confirming state", () => {
    expect(postCardSrc).toMatch(
      /<TxConfirming[\s\S]*txId=\{confirmTxId\}[\s\S]*explorerBase=\{chain\.blockExplorer\}/,
    );
  });

  it("the dead 15s 'still working' note is gone", () => {
    expect(postCardSrc).not.toContain("waitingLong");
  });

  it("celebrates confirmed townhall tips too", () => {
    const confirmed = postCardSrc.indexOf('title="Tip confirmed"');
    const celebration = postCardSrc.indexOf("<TipCelebration");
    expect(celebration).toBeGreaterThan(-1);
    expect(celebration).toBeLessThan(confirmed);
    expect(postCardSrc).toMatch(
      /<TipCelebration[\s\S]*usd=\{usd\.toFixed\(2\)\}[\s\S]*username=\{author\}/,
    );
  });
});
