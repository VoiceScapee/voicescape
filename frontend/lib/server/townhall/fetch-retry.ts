/**
 * Mirror Node fetch helpers: retry with exponential backoff + jitter.
 *
 * The Hedera Mirror Node rate-limits aggressively (429) under burst load.
 * These helpers retry 429s and transient network errors so a momentary
 * spike doesn't surface as a user-facing failure. Other 4xx responses are
 * permanent and returned immediately without retry.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter: baseMs * 2^attempt + random(0, baseMs). */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** attempt + Math.random() * baseMs;
}

export interface FetchRetryOptions {
  /** How many retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Base backoff delay in ms (default 500). */
  baseDelayMs?: number;
  /**
   * Also poll on 404 up to `indexingWaitAttempts` times with
   * `indexingWaitDelayMs` between attempts. The mirror node can lag a few
   * seconds behind consensus, so a just-submitted transaction may 404
   * briefly. Default 0 (no 404 polling).
   */
  indexingWaitAttempts?: number;
  indexingWaitDelayMs?: number;
}

/**
 * Fetch with retry for Mirror Node requests.
 *
 * - Retries HTTP 429 (rate limited) with exponential backoff + jitter.
 * - Retries transient network errors (fetch throwing) the same way.
 * - Optionally polls on 404 for mirror-node indexing lag.
 * - Returns other responses (including other 4xx/5xx) immediately.
 *
 * Uses the global `fetch` at call time so test stubs (vi.stubGlobal) work.
 */
export async function fetchMirrorWithRetry(
  url: string,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const waitAttempts = opts.indexingWaitAttempts ?? 0;
  const waitDelayMs = opts.indexingWaitDelayMs ?? 1500;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(backoffDelayMs(attempt, baseDelayMs));
      attempt++;
      continue;
    }
    if (res.status === 429 && attempt < maxRetries) {
      await sleep(backoffDelayMs(attempt, baseDelayMs));
      attempt++;
      continue;
    }
    if (res.status === 404 && waitAttempts > 0) {
      // Indexing lag: the tx was just submitted; give the mirror node a
      // few seconds to catch up before treating it as missing.
      for (let w = 0; w < waitAttempts; w++) {
        await sleep(waitDelayMs);
        const retryRes = await fetchMirrorWithRetry(url, {
          maxRetries,
          baseDelayMs,
        });
        if (retryRes.status !== 404) return retryRes;
      }
      return res;
    }
    return res;
  }
}
