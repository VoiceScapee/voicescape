/**
 * WeeklyLeaderboard + RecentActivity UI regression tests.
 *
 * The repo's component tests are source assertions (no testing-library),
 * so these verify the components render the translated copy keys, expose
 * the #leaderboard/#activity anchors the navbar links to, link creators
 * to their blockpages, and never use "trending"/algorithmic framing.
 * Dictionary assertions below verify the honest empty-state copy exists
 * and is non-empty in all 7 languages.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dictionaries, LANGS, type Lang } from "@/lib/i18n/dictionaries";

const here = dirname(fileURLToPath(import.meta.url));
const leaderboardSrc = readFileSync(join(here, "WeeklyLeaderboard.tsx"), "utf8");
const activitySrc = readFileSync(join(here, "RecentActivity.tsx"), "utf8");

describe("WeeklyLeaderboard", () => {
  it("is titled exactly 'Most tipped this week' (translated key), never 'trending'", () => {
    expect(leaderboardSrc).toMatch(/t\("leaderboard\.title"\)/);
    // No rendered heading/copy framed as a trending feed — the word only
    // appears once, inside this test's target doc comment.
    const outsideComments = leaderboardSrc.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outsideComments).not.toMatch(/trending/i);
  });

  it("renders an honest empty state via the translated key", () => {
    expect(leaderboardSrc).toMatch(/t\("leaderboard\.empty"\)/);
  });

  it("exposes an anchor id for deep-linking", () => {
    expect(leaderboardSrc).toMatch(/id="leaderboard"/);
  });

  it("is surfaced as a tab on the /leaderboard page", () => {
    const client = readFileSync(
      join(here, "..", "app", "(townhall)", "leaderboard", "LeaderboardClient.tsx"),
      "utf8",
    );
    expect(client).toMatch(/WeeklyLeaderboard/);
    expect(client).toMatch(/mostTipped/);
    expect(client).toMatch(/t\("leaderboard\.title"\)/);
  });

  it("links creators to their blockpage when a username resolved", () => {
    expect(leaderboardSrc).toMatch(/href=\{`\/\$\{l\.username\}`\}/);
  });

  it("labels the human-only scope", () => {
    expect(leaderboardSrc).toMatch(/t\("leaderboard\.humansOnly"\)/);
  });
});

describe("RecentActivity", () => {
  it("renders an honest empty state via the translated key (never hides)", () => {
    expect(activitySrc).toMatch(/t\("activity\.empty"\)/);
  });

  it("exposes the #activity anchor", () => {
    expect(activitySrc).toMatch(/id="activity"/);
  });

  it("links receipts to HashScan (no /tx route exists yet)", () => {
    expect(activitySrc).toMatch(/hashscan\.io\/mainnet\/transaction/);
    expect(activitySrc).not.toMatch(/\/tx\//);
  });

  it("shows usernames when resolvable", () => {
    expect(activitySrc).toMatch(/fromUsername/);
    expect(activitySrc).toMatch(/toUsername/);
  });
});

describe("slice 2 dictionary copy (all 7 languages)", () => {
  const keys = [
    "nav.leaderboard",
    "activity.title",
    "activity.subtitle",
    "activity.empty",
    "activity.loading",
    "activity.viewOnHashScan",
    "activity.timeJustNow",
    "activity.timeMinAgo",
    "activity.timeHourAgo",
    "activity.timeDayAgo",
    "leaderboard.title",
    "leaderboard.subtitle",
    "leaderboard.empty",
    "leaderboard.loading",
    "leaderboard.humansOnly",
    "leaderboard.rank",
    "leaderboard.creator",
    "leaderboard.total",
    "leaderboard.tips",
    "leaderboard.tipCountSingular",
    "leaderboard.tipCountPlural",
  ] as const;

  for (const lang of LANGS.map((l) => l.code)) {
    it(`[${lang}] every slice-2 key is present and non-empty`, () => {
      const dict: Record<string, string> = dictionaries[lang as Lang];
      for (const k of keys) {
        expect(dict[k], `${lang}.${k}`).toBeTruthy();
      }
    });
  }

  it("leaderboard title is never the word 'trending' in any language", () => {
    for (const lang of LANGS.map((l) => l.code)) {
      const title = dictionaries[lang as Lang]["leaderboard.title"].toLowerCase();
      expect(title).not.toContain("trending");
    }
  });

  it("empty-state copy is honest (no fabricated counts)", () => {
    for (const lang of LANGS.map((l) => l.code)) {
      const d = dictionaries[lang as Lang];
      expect(d["leaderboard.empty"]).not.toMatch(/\d+k|\d{3,}/);
      expect(d["activity.empty"]).not.toMatch(/\d+k|\d{3,}/);
    }
  });
});
