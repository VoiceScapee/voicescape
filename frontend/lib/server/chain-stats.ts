/**
 * Live community-pulse numbers for the landing page, read straight from the
 * official Hedera mainnet mirror node (proven Hedera-native path):
 *   - pages: successful contract results on the Voicescape Registry
 *     (0.0.10854058) whose calldata opens with the registerPage selector —
 *     i.e. blockpages registered on chain.
 *   - tips: successful contract results on the Tips contract
 *     (0.0.10854060) — tips (and marketplace purchases) settled on chain.
 */

export const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
export const REGISTRY_ID = "0.0.10854058";
export const TIPS_ID = "0.0.10854060";
export const PAGE_LIMIT = 100;
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * keccak selector of registerPage(string,string,uint8,address,string).
 * Hard-coded (verified: keccak256("registerPage(string,string,uint8,address,string)")[0:4]
 * = 0xc02fdb27) — no hashing library needed at runtime. The test asserts the
 * constant equals 0xc02fdb27.
 */
export const REGISTER_PAGE_SELECTOR = "0xc02fdb27";

interface MirrorResultRow {
  result?: string;
  function_parameters?: string | null;
}

interface MirrorResultsPage {
  results?: MirrorResultRow[];
  links?: { next?: string | null };
}

/**
 * Paginate the mirror node's contract-results list and count the successful
 * rows (optionally restricted to calls whose calldata opens with
 * `functionSelector`). fetch is injectable so tests can drive this with
 * fixture pages instead of the live mirror node.
 *
 * Throws on any transport or HTTP failure — the route handler turns that
 * into the fail-soft null payload.
 */
export async function countSuccessfulResults(
  fetchFn: typeof fetch,
  contractId: string,
  functionSelector: string | null,
): Promise<number> {
  let count = 0;
  let url: string | null =
    `${MIRROR_BASE}/contracts/${contractId}/results?limit=${PAGE_LIMIT}&order=asc`;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) break; // defensive: never loop on a bad `next`
    seen.add(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`mirror node GET ${url}: HTTP ${res.status}`);
      const body = (await res.json()) as MirrorResultsPage;
      for (const row of body.results ?? []) {
        if (row.result !== "SUCCESS") continue;
        if (functionSelector) {
          const params = (row.function_parameters ?? "").toLowerCase();
          if (!params.startsWith(functionSelector.toLowerCase())) continue;
        }
        count++;
      }
      const next = body.links?.next ?? null;
      // Mirror `next` links are relative (/api/v1/contracts/...); resolve
      // against the base to an absolute URL.
      url = next ? new URL(next, MIRROR_BASE).toString() : null;
    } finally {
      clearTimeout(timer);
    }
  }
  return count;
}
