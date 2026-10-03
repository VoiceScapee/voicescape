/**
 * fetch() with a timeout. A bare fetch() can hang forever on a stalled
 * mobile connection, leaving the UI stuck in a loading state with no
 * error — seen on real devices. Every network call behind a user-visible
 * loading state should go through here.
 *
 * On timeout the promise rejects with a DOMException named "AbortError",
 * exactly like a manual abort — callers can treat it as "unavailable"
 * through their existing error paths.
 */
export async function fetchWithTimeout(
  url: string,
  ms: number,
  init: RequestInit = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
