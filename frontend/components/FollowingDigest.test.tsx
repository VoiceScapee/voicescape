/**
 * FollowingDigest component tests.
 *
 * Source assertions (repo convention) plus a real server-render of the
 * signed-out branch: the digest must prompt for sign-in instead of
 * leaking anything, and must never frame itself as ranked/suggested.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToString } from "react-dom/server";
import React from "react";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "FollowingDigest.tsx"), "utf8");

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "signed-out",
    session: null,
    isAuthenticated: false,
    authHeader: () => ({}),
  }),
}));

vi.mock("@/lib/i18n/LanguageContext", () => ({
  useLanguage: () => ({ lang: "en", setLang: () => {}, t: (k: string) => k }),
}));

vi.mock("@/components/WalletConnect", async () => {
  const React = await import("react");
  return {
    WalletConnect: () => React.createElement("div", { id: "wallet-connect-stub" }),
  };
});

import { FollowingDigest } from "./FollowingDigest";

describe("FollowingDigest", () => {
  it("prompts signed-out visitors to connect instead of showing a feed", () => {
    const html = renderToString(React.createElement(FollowingDigest));
    expect(html).toContain("following.connectTitle");
    expect(html).toContain("following.connectBody");
    expect(html).toContain("wallet-connect-stub");
  });

  it("never uses ranked/suggested framing (source)", () => {
    const outsideComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outsideComments).not.toMatch(/suggested/i);
    expect(outsideComments).not.toMatch(/trending/i);
    expect(outsideComments).not.toMatch(/rank/i);
  });

  it("labels every row human/agent (source)", () => {
    expect(src).toContain("OwnerBadge");
    expect(src).toContain("following.human");
    expect(src).toContain("following.agent");
  });

  it("links tips to on-chain proof and rows to blockpages (source)", () => {
    expect(src).toContain("following.viewTx");
    expect(src).toContain("following.visitPage");
  });
});
