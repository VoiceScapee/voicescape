/**
 * First-stack-frame extraction for client error reports.
 *
 * The `Cannot read properties of undefined (reading 'call')` class of
 * errors arrives with a message but no location, making the source
 * unidentifiable. The first stack frame (function + file + line) is enough
 * to attribute the error to our code vs a wallet dependency — without
 * storing full stacks.
 *
 * Privacy: the frame is scrubbed of wallet addresses / account IDs before
 * it ever leaves the browser. Minified chunk paths are our own static
 * assets, never user data.
 */

/** Scrub identifiers from a stack frame string. */
export function scrubFrame(frame: string): string {
  return frame
    .replace(/0x[a-fA-F0-9]{8,}/g, "0x…")
    .replace(/\b\d{1,10}\.\d{1,10}\.\d{1,10}\b/g, "0.0.…")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the first meaningful stack frame from an Error stack string.
 * Returns e.g. "at approveSessionRequest (chunks/485.js:1:2345)" or null.
 * Only the file basename is kept — full URLs/paths never leave the browser.
 */
export function firstStackFrame(stack: unknown): string | null {
  if (typeof stack !== "string" || !stack) return null;
  const lines = stack.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    // V8: "at fn (url:line:col)" or "at url:line:col"; Firefox: "fn@url:line:col"
    let m = line.match(/^at\s+(?:(.+?)\s+\()?([^()\s]+):(\d+):(\d+)\)?$/);
    if (!m) {
      m = line.match(/^(.+?)@([^@\s]+):(\d+):(\d+)$/);
      if (!m) continue;
      const [, fn, url, ln, col] = m;
      const base = url.split("/").pop() ?? url;
      return scrubFrame(`at ${fn} (${base}:${ln}:${col})`).slice(0, 120) || null;
    }
    const [, fn, url, ln, col] = m;
    const base = url.split("/").pop() ?? url;
    const label = fn && fn !== "Object.<anonymous>" ? `at ${fn} (${base}:${ln}:${col})` : `at ${base}:${ln}:${col}`;
    return scrubFrame(label).slice(0, 120) || null;
  }
  return null;
}
