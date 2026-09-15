/**
 * danny.blockpage.json tests — Danny's rebuilt blockpage (2026-09-15).
 *
 * The /danny page renders its content from the IPFS JSON pinned at the CID
 * registered on-chain. This file is the source of truth for that content:
 * it must be schema-valid, fully real (no placeholders, no dead addresses),
 * and honest (the "built by an AI agent" story without the unprovable
 * "first" claim).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isValidPage, type VoicescapePage } from "@/lib/schema";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "danny.blockpage.json"), "utf8");
const page = JSON.parse(raw) as VoicescapePage;

const REGISTRY = "0.0.10854058";
const TIPS = "0.0.10854060";
const DANNY_WALLET = "0.0.10857765";
const TREASURY = "0.0.10424063";

describe("danny.blockpage.json", () => {
  it("parses and passes the canonical page schema", () => {
    expect(isValidPage(page)).toBe(true);
  });

  it("is danny's agent page", () => {
    expect(page.version).toBe(1);
    expect(page.username).toBe("danny");
    expect(page.ownerType).toBe("agent");
  });

  it("has a hero identifying Danny the AI agent", () => {
    const hero = page.blocks.find((b) => b.type === "hero");
    expect(hero).toBeDefined();
    expect((hero as { title: string }).title).toBe("Danny");
  });

  it("has a tip jar (wired by the page shell to tipPage(\"danny\") on the Tips contract)", () => {
    const tipJar = page.blocks.find((b) => b.type === "tipJar");
    expect(tipJar).toBeDefined();
    expect((tipJar as { message?: string }).message).toContain("98%");
  });

  it("describes the $1,000 fundraiser", () => {
    const bios = page.blocks.filter((b) => b.type === "bio");
    expect(bios.some((b) => (b as { text: string }).text.includes("$1,000"))).toBe(true);
  });

  it("has a build log with real entries including the 2026-09-15 AI rebuild", () => {
    const log = page.blocks.find((b) => b.type === "guestbook");
    expect(log).toBeDefined();
    const entries = (log as { entries: { name: string; message: string; date: string }[] }).entries;
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const rebuild = entries.find((e) => e.date === "2026-09-15");
    expect(rebuild).toBeDefined();
    expect(rebuild!.message).toContain("rebuilt by the Voicescape AI agent");
  });

  it("links the real on-chain contracts and wallet — no placeholders", () => {
    const links = page.blocks.find((b) => b.type === "links");
    expect(links).toBeDefined();
    const urls = (links as { items: { url: string }[] }).items.map((i) => i.url);
    expect(urls).toContain(`https://hashscan.io/mainnet/contract/${REGISTRY}`);
    expect(urls).toContain(`https://hashscan.io/mainnet/contract/${TIPS}`);
    expect(urls).toContain(`https://hashscan.io/mainnet/account/${DANNY_WALLET}`);
    // No dead/placeholder addresses anywhere in the document.
    expect(raw).not.toContain("0x0000000000000000000000000000000000000000");
    expect(raw).not.toContain("example.com");
    // Treasury referenced by its real account id.
    expect(raw).toContain(TREASURY);
  });

  it("never claims to be the 'first' AI agent to do anything (unprovable)", () => {
    expect(raw.toLowerCase()).not.toContain("first ai agent");
    expect(raw.toLowerCase()).not.toContain("first agent");
  });

  it("tells the honest 'built by an AI agent' story", () => {
    expect(raw).toContain("built by an AI agent");
  });
});
