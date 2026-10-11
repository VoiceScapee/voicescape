/**
 * Seasonal UI system — the dapp shell wears the season; user blockpages
 * are sovereign and always keep their owner's theme.
 *
 * How it works:
 * - `ACTIVE_SEASON` is the single switch. Changing it to a new season name
 *   (with a matching `app/seasons/<name>.css` imported in the root layout)
 *   re-skins the whole shell. Set to `"none"` to run the default theme.
 * - `SeasonalTheme` (client component in the root layout) writes
 *   `data-season` and `data-season-page` onto `<html>`. All seasonal CSS
 *   is scoped under `html[data-season="<name>"]`, so it inherits through
 *   the DOM only where we want it.
 * - Sovereignty: `PageRenderer`'s root carries `data-sovereign`, and each
 *   season stylesheet re-pins every `--vs-*` token to its default inside
 *   `[data-sovereign]`. Blockpage content styles itself from `--pv-*`
 *   owner-theme vars and inline styles, so a season can never restyle it.
 */

export const ACTIVE_SEASON = "october";

export type SeasonPage =
  | "home"
  | "discover"
  | "townhall"
  | "marketplace"
  | "voice"
  | "agents"
  | "default"
  | "sovereign";

/**
 * Line-by-line rollout (Brandon 2026-10-10: "slowly line by line").
 * Pages opt in one at a time. 2026-10-10 night Brandon said "wire the
 * rest of it up except demo page" — the full dapp shell now wears
 * October. "sovereign" NEVER rolls out: the Amazon demo page and user
 * blockpages are permanently exempt.
 */
const SEASON_ROLLOUT: SeasonPage[] = [
  "default",
  "discover",
  "townhall",
  "marketplace",
  "voice",
  "agents",
  "home",
];

/** First path segments that belong to the dapp shell (not a /[username]).
 * NOTE: alexa-demo is deliberately NOT here — Brandon's directive
 * 2026-10-10: the Amazon demo page is never re-skinned. */
const SHELL_ROOTS = new Set([
  "",
  "admin",
  "agents",
  "ai-agent",
  "builder",
  "console",
  "dmca",
  "explore",
  "following",
  "fundraiser",
  "intros",
  "marketplace",
  "mcp",
  "messages",
  "mining-depin",
  "new-to-web3",
  "privacy",
  "privacy-request",
  "status",
  "terms",
  "townhall",
  "trust",
  "workshop",
]);

/** Link/claim/preview routes whose pages are user-owned, never shell. */
const SOVEREIGN_PREFIX = /^\/(p|t|c|v|embed)\//;

/**
 * The season to apply for a pathname: the active season when the page is
 * in the rollout list, otherwise "none" (default theme). Keeps the rollout
 * line-by-line — a page only re-skins after its mockup is approved.
 */
export function seasonForPath(pathname: string): string {
  const page = seasonPageForPath(pathname);
  return SEASON_ROLLOUT.includes(page) ? ACTIVE_SEASON : "none";
}

/**
 * Map a pathname to its seasonal page motif. Anything that isn't a known
 * shell route is treated as a sovereign blockpage (`/[username]`).
 */
export function seasonPageForPath(pathname: string): SeasonPage {
  const path = (pathname ?? "/").split("?")[0].split("#")[0] || "/";
  if (SOVEREIGN_PREFIX.test(path)) return "sovereign";
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "home";
  const [first] = segments;
  if (!SHELL_ROOTS.has(first)) return "sovereign";
  switch (first) {
    case "explore":
      return "discover";
    case "townhall":
      return "townhall";
    case "marketplace":
      return "marketplace";
    case "builder":
      return "voice";
    case "agents":
      return "agents";
    default:
      return "default";
  }
}
