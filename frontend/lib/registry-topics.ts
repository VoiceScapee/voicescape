/**
 * Registry contract event topic hashes.
 *
 * Both registry events carry the username as the first topic — new pages emit
 * PageRegistered, re-publishes emit PageUpdated. The hashes are verified by
 * lib/registry-topics.test.ts against the canonical event signatures
 * (a wrong hash here silently hides pages from Explore).
 *
 * Kept in lib/ (not in a route.ts) because Next.js route modules may only
 * export HTTP method handlers and route config — extra exports fail the
 * production build's route type check.
 */
// PageRegistered(string,address,string,uint8,address,string)
export const PAGEREGISTERED_TOPIC =
  "0xa327fd868734b8d16f5a1b2685a76b5cce3891a78c46bc724e7eb68ddd7917eb";
// PageUpdated(string,address,string,uint8,address,string)
export const PAGEUPDATED_TOPIC =
  "0xa4c1ea4f124910234beaa5e008aa404b64055531a6b524c62412b032f35596f3";
