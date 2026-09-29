/**
 * Builder onboarding fixes (2026-09-28, Brandon: "Do all") — source
 * assertions, repo convention: the name-first flow, human default, plain
 * language, email-wallet path, checklist, and share reward are structural
 * properties of the builder source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const builderSrc = readFileSync(join(here, "page.tsx"), "utf8");
const profileSrc = readFileSync(
  join(here, "..", "[username]", "page.tsx"),
  "utf8"
);
const templatesSrc = readFileSync(join(here, "..", "..", "lib", "templates.ts"), "utf8");
const hashpackRouteSrc = readFileSync(
  join(here, "..", "api", "hashpack-profile", "route.ts"),
  "utf8"
);

describe("name-first claim", () => {
  it("picks the name in step 1 (customize tab), not only at publish", () => {
    // The shared UsernameField renders in the customize tab…
    const customizeIdx = builderSrc.indexOf('tab === "customize"');
    const publishIdx = builderSrc.indexOf('tab === "publish"');
    const fieldUses = [...builderSrc.matchAll(/<UsernameField/g)].map((m) => m.index ?? -1);
    expect(fieldUses.length).toBeGreaterThanOrEqual(2);
    expect(fieldUses.some((i) => i > customizeIdx && i < publishIdx)).toBe(true);
  });

  it("checks availability inline against the on-chain registry", () => {
    expect(builderSrc).toContain("useUsernameAvailability");
    expect(builderSrc).toContain("/api/resolve?username=");
    expect(builderSrc).toContain("is available — it");
    expect(builderSrc).toContain("That name is taken — try another.");
  });

  it("no longer gates the name field behind the wallet", () => {
    expect(builderSrc).not.toContain("connect your wallet…");
    expect(builderSrc).toContain('placeholder="your-name"');
  });

  it("never clobbers a typed name when the wallet connects", () => {
    expect(builderSrc).toContain("nameTouchedRef");
    expect(builderSrc).toContain("A typed name is never clobbered");
  });

  it("blocks publish on a taken name", () => {
    expect(builderSrc).toContain('availability === "taken"');
  });
});

describe("human default", () => {
  it("defaults the owner type to human", () => {
    expect(builderSrc).toContain('useState<"human" | "agent">(');
    expect(builderSrc).toMatch(/initialOwnerType \?\? page\.ownerType \?\? "human"/);
  });

  it("keeps the agent path behind a quiet toggle, not a rival button", () => {
    expect(builderSrc).toContain("Making this for an AI agent? Add disclosure →");
    expect(builderSrc).not.toContain("AI-operated · disclosure required");
  });
});

describe("plain-language publish", () => {
  it("explains the signature moment without rail/gas/contract jargon", () => {
    expect(builderSrc).toContain(
      "Your wallet will ask you to approve one transaction — nothing else happens."
    );
  });

  it("mentions the email path for wallet newcomers", () => {
    expect(builderSrc).toContain("just an email — no seed");
  });
});

describe("hashpack profile import", () => {
  it("offers a skippable one-tap import from the free Profile API", () => {
    expect(builderSrc).toContain("HashpackProfileImport");
    expect(builderSrc).toContain("Import my HashPack profile");
    expect(builderSrc).toContain("/api/hashpack-profile?account=");
  });

  it("proxies api.hashpack.app server-side with a trimmed response", () => {
    expect(hashpackRouteSrc).toContain("https://api.hashpack.app/user-profile/get");
    expect(hashpackRouteSrc).toContain("twitterHandle");
    expect(hashpackRouteSrc).toContain("status: 502");
  });
});

describe("dismissable checklist", () => {
  it("renders an endowed-progress checklist that can be dismissed", () => {
    expect(builderSrc).toContain("ChecklistCard");
    expect(builderSrc).toContain("vs-builder-checklist-dismissed");
    expect(builderSrc).toContain("Your blockpage");
  });

  it("everything on it is honest state, nothing decorative", () => {
    expect(builderSrc).toContain('label: "Pick a template", done: true');
    expect(builderSrc).toContain('label: "Connect your wallet to claim it"');
  });
});

describe("shareable-URL reward", () => {
  it("stashes a one-time flag before redirecting to the live page", () => {
    expect(builderSrc).toContain('sessionStorage.setItem("vs-just-published"');
  });

  it("the public page shows a one-time live + share card", () => {
    expect(profileSrc).toContain("JustPublishedBanner");
    expect(profileSrc).toContain("vs-just-published");
    expect(profileSrc).toContain("Your page is live!");
    expect(profileSrc).toContain("Copy link");
  });
});

describe("seeded templates", () => {
  it("templates ship with editable example content, not blank pages", () => {
    expect(templatesSrc).toContain("Alex Rivera");
    expect(templatesSrc).toContain("Building decentralized apps. Open to collabs.");
  });
});
