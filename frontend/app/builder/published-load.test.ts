/**
 * Builder published-page load regression tests (source assertions).
 *
 * When the connected wallet owns a registered page on-chain, the builder
 * hydrates the editor with the published page JSON (IPFS via /api/resolve)
 * so republishing calls updatePage — never a duplicate registration.
 *
 * The load must NOT clobber: an explicit ?draft= shared link, or a
 * just-completed onboarding draft. The fetched JSON is validated with
 * isValidPage() before it touches the editor.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "page.tsx"), "utf8");

describe("builder published-page load", () => {
  it("reverse-resolves the wallet's page and fetches its JSON from IPFS", () => {
    expect(src).toContain("fetchRegisteredUsername(account)");
    expect(src).toContain("/api/resolve?username=");
    expect(src).toContain("fetchPageJson(");
  });

  it("validates the fetched page with isValidPage before applying", () => {
    expect(src).toMatch(/isValidPage\(pageJson\)[\s\S]{0,300}editPage/);
  });

  it("never clobbers an explicit ?draft= link or onboarding draft", () => {
    expect(src).toMatch(/searchParams\.get\(["']draft["']\)[\s\S]{0,120}return/);
    expect(src).toContain("ONBOARD_DRAFT_KEY");
  });

  it("syncs the published username so republish updates, not re-registers", () => {
    expect(src).toContain("setPublishedUsername");
    expect(src).toContain("draftVanity ?? publishedUsername");
  });

  it("shows a loaded-published notice in the builder header", () => {
    expect(src).toContain("setLoadedPublished(true)");
    expect(src).toContain("loadedPublished");
  });
});
