/**
 * Pin UTF-8 on HTTP responses at the boundary.
 *
 * Clearance second pass (2026-11-28, finding E): the MCP SSE transport
 * shipped `Content-Type: text/event-stream` with no charset, and
 * header-decoding clients (requests/httpx default a charset-less
 * text/* response to ISO-8859-1) mojibake every non-ASCII byte — the
 * wire bytes are valid UTF-8, the decode is wrong. Same gap on plain
 * JSON responses. Safe to apply to a streaming body: the new Response
 * takes over the same stream.
 */
export function withUtf8Charset(res: Response): Response {
  const ct = res.headers.get("content-type") ?? "";
  if (!/text\/event-stream|application\/json/.test(ct)) return res;
  if (/charset=/i.test(ct)) return res;
  const headers = new Headers(res.headers);
  headers.set("content-type", `${ct.split(";")[0].trim()}; charset=utf-8`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
