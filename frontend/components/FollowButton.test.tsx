/**
 * FollowButton + blockpage wiring tests (source assertions, repo
 * convention): the button must use the session header, hit the follows
 * API, show the public follower count, and only render for non-owners.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const buttonSrc = readFileSync(join(here, "FollowButton.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "app", "[username]", "page.tsx"), "utf8");
const navSrc = readFileSync(join(here, "Navbar.tsx"), "utf8");

describe("FollowButton", () => {
  it("sends the wallet session with follow/unfollow calls", () => {
    expect(buttonSrc).toContain("authHeader()");
    expect(buttonSrc).toContain('"/api/follows"');
    expect(buttonSrc).toContain('method: following ? "DELETE" : "POST"');
  });

  it("shows the public follower count", () => {
    expect(buttonSrc).toContain("/api/follows/count");
    expect(buttonSrc).toContain('t("follow.followers")');
  });

  it("prompts signed-out visitors to connect instead of failing silently", () => {
    expect(buttonSrc).toContain('t("follow.signInPrompt")');
    expect(buttonSrc).toContain("WalletConnect");
  });

  it("renders translated follow/following states", () => {
    expect(buttonSrc).toContain('t("follow.follow")');
    expect(buttonSrc).toContain('t("follow.following")');
    expect(buttonSrc).toContain('t("follow.error")');
  });
});

describe("blockpage wiring", () => {
  it("shows the follow button only on the public (non-owner) view", () => {
    expect(pageSrc).toContain("{!isOwner && <FollowButton username={username} />}");
  });
});

describe("navbar", () => {
  it("links to /following with a translated label", () => {
    expect(navSrc).toContain('href="/following"');
    expect(navSrc).toContain('k="nav.following"');
  });
});
