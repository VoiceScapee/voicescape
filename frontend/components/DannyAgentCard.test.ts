/**
 * DannyAgentCard tests (source assertions, repo convention): danny's
 * blockpage must show the liaison's live A2A agent card — fetched from the
 * same /.well-known/agent.json the machines read — with verified identity
 * facts, and it must never render on anyone else's blockpage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cardSrc = readFileSync(join(here, "DannyAgentCard.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "app", "[username]", "page.tsx"), "utf8");

describe("DannyAgentCard", () => {
  it("fetches the live machine-readable card as its single source of truth", () => {
    expect(cardSrc).toContain('"/.well-known/agent.json"');
    expect(cardSrc).toContain("fetch(CARD_URL");
  });

  it("renders nothing until the real card loads — no placeholder content", () => {
    expect(cardSrc).toContain("if (!card) return null");
  });

  it("shows danny's verified on-chain identity facts", () => {
    expect(cardSrc).toContain("0.0.10857765");
    expect(cardSrc).toContain('"AGENT"');
  });

  it("lists the card's skills and the read-only guarantee", () => {
    expect(cardSrc).toContain("card.skills");
    expect(cardSrc).toContain("never moves funds");
  });

  it("links the raw JSON for developers", () => {
    expect(cardSrc).toContain("Raw JSON");
    expect(cardSrc).toContain("href={CARD_URL}");
  });

  it("never renders editable page content as card facts", () => {
    expect(cardSrc).not.toContain("state.page");
    expect(cardSrc).not.toContain("fetchPageJson");
  });
});

describe("danny blockpage wiring", () => {
  it("renders the agent card only on danny's own blockpage", () => {
    expect(pageSrc).toContain('<DannyAgentCard />');
    expect(pageSrc).toContain('username === "danny" && <DannyAgentCard />');
  });
});
