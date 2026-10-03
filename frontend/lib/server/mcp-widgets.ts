/**
 * MCP Apps widgets — interactive UI resources rendered inside AI chat clients.
 *
 * Per the finalized MCP Apps spec (SEP-1865, io.modelcontextprotocol/ui,
 * stable 2026-01-26): the server registers ui:// resources (self-contained
 * HTML, MIME text/html;profile=mcp-app) and links them from render tools
 * via _meta.ui.resourceUri. The host (Claude, ChatGPT, etc.) renders the
 * HTML in a sandboxed iframe; the widget talks back over postMessage
 * JSON-RPC using kebab-case extension methods (ui/open-link — never the
 * camelCase ui/openLink, which spec-compliant hosts silently ignore).
 *
 * Bridge lifecycle (all widgets must follow it):
 *   widget --ui/initialize--> host --result--> widget
 *     --ui/notifications/initialized--> host
 *     --ui/notifications/tool-input / tool-result--> widget
 * Widgets also report ui/notifications/size-changed as content resizes and
 * store ui/notifications/host-context-changed (theme/display) for render
 * decisions. The declared WIDGET_CSP below is published via _meta.ui.csp
 * on every ui:// resource — explicit beats assumed.
 *
 * Security: the widget is untrusted by design — no keys, no signing, no
 * wallet APIs. All money actions hand off to the user's own wallet via
 * ui/open-link. Widgets are display + decision; the wallet is authority.
 */

export const BLOCKPAGE_PREVIEW_URI = "ui://voicescape/blockpage-preview";

/**
 * Declared Content Security Policy for Voicescape MCP Apps widgets,
 * published via _meta.ui.csp on every ui:// resource (SEP-1865). The
 * widgets are fully self-contained: inline script + inline style only —
 * no images, no network fetches, no forms. Stated explicitly so hosts
 * apply this instead of guessing from defaults.
 */
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

/**
 * Self-contained blockpage preview card. Receives the lookup_blockpage
 * result via the MCP Apps bridge (ui/notifications/tool-result) and renders
 * a visual card: username, owner type badge, purpose, tip + view buttons.
 * Falls back to a static message if opened outside a host.
 *
 * Pass `preload` to embed blockpage data directly — the card renders
 * immediately on load with no postMessage handshake. Used by the
 * server-side screenshot path (render_blockpage_image) so headless agents
 * can see the same card as an image.
 */
export function blockpagePreviewHtml(
  preload?: {
    username: string;
    owner_type: string;
    purpose?: string | null;
  },
  appOrigin = "https://voicescape.vercel.app",
): string {
  // Links must stay on our own https origin — never javascript: or a
  // foreign host, even if a caller passes a bad value.
  const safeOrigin =
    typeof appOrigin === "string" && /^https:\/\/[^/\s]+$/.test(appOrigin)
      ? appOrigin
      : "https://voicescape.vercel.app";
  const preloadJson = preload
    ? JSON.stringify({
        username: preload.username,
        owner_type: preload.owner_type,
        purpose: preload.purpose ?? "",
      }).replace(/</g, "\\u003c")
    : "null";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blockpage preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0e0b16; color: #f2eefc;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; padding: 16px;
  }
  .card {
    width: 100%; max-width: 340px;
    background: linear-gradient(160deg, #1c1428, #120d1d);
    border: 1px solid rgba(180, 92, 240, .35);
    border-radius: 16px; padding: 20px;
    box-shadow: 0 8px 32px rgba(123, 63, 242, .25);
  }
  .handle { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
  .badge {
    display: inline-block; font-size: 11px; font-weight: 700;
    padding: 3px 10px; border-radius: 20px; margin-bottom: 12px;
    letter-spacing: .4px; text-transform: uppercase;
  }
  .badge.agent { background: rgba(123, 63, 242, .25); color: #c9a6ff; border: 1px solid rgba(123,63,242,.5); }
  .badge.human { background: rgba(80, 200, 160, .15); color: #7fe0c3; border: 1px solid rgba(80,200,160,.4); }
  .purpose { font-size: 14px; line-height: 1.55; opacity: .85; margin-bottom: 16px; }
  .row { display: flex; gap: 10px; }
  .btn {
    flex: 1; text-align: center; padding: 12px; border-radius: 10px;
    font-size: 14px; font-weight: 700; cursor: pointer; border: none;
    text-decoration: none; display: inline-block;
    min-height: 44px; line-height: 20px; /* 44px touch target (Pixel/mobile) */
  }
  .btn.primary { background: linear-gradient(135deg, #7b3ff2, #b45cf0); color: #fff; }
  .btn.ghost { background: rgba(255,255,255,.08); color: #f2eefc; border: 1px solid rgba(255,255,255,.15); }
  .meta { font-size: 11px; opacity: .5; margin-top: 14px; text-align: center; }
  .loading { text-align: center; opacity: .6; font-size: 14px; }
</style>
</head>
<body>
<div class="card" id="card"><div class="loading">Loading blockpage…</div></div>
<script>
window.__VOICESCAPE_PRELOAD__ = __PRELOAD_JSON__;
(function () {
  var card = document.getElementById('card');
  var appOrigin = __APP_ORIGIN__;
  var data = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(bp) {
    var isAgent = bp.owner_type === 'agent';
    var pageUrl = appOrigin + '/' + encodeURIComponent(bp.username);
    card.innerHTML =
      '<div class="handle">@' + esc(bp.username) + '</div>' +
      '<span class="badge ' + (isAgent ? 'agent' : 'human') + '">' +
        (isAgent ? 'AI Agent' : 'Human') + '</span>' +
      (bp.purpose ? '<div class="purpose">' + esc(bp.purpose) + '</div>' : '') +
      '<div class="row">' +
        '<a class="btn primary" href="#" id="tipBtn">Tip</a>' +
        '<a class="btn ghost" href="#" id="viewBtn">View page</a>' +
      '</div>' +
      '<div class="meta">98% of tips go to the creator · verified on Hedera</div>';
    document.getElementById('viewBtn').addEventListener('click', function (e) {
      e.preventDefault(); openLink(pageUrl);
    });
    document.getElementById('tipBtn').addEventListener('click', function (e) {
      e.preventDefault(); openLink(pageUrl + '?tip=1');
    });
  }

  // MCP Apps bridge (SEP-1865): JSON-RPC 2.0 over window.postMessage.
  // Lifecycle: we send ui/initialize -> host answers -> we send
  // ui/notifications/initialized -> host delivers tool-input/tool-result.
  // All extension methods are kebab-case (ui/open-link, never ui/openLink).
  var INIT_ID = 'voicescape-init-1';
  var bridgeReady = false;
  var hostContext = null;
  var lastSizeKey = '';

  function postToHost(msg) {
    if (window.parent === window) return;
    // Target is the host frame (Claude, ChatGPT, …): its origin is not
    // knowable in advance, so '*' is required here. Payloads carry no
    // sensitive data — links are already origin-pinned below.
    window.parent.postMessage(msg, '*');
  }

  function reportSize() {
    // Dynamic sizing: tell the host our rendered size so the frame fits.
    if (!bridgeReady || window.parent === window) return;
    var rect = card.getBoundingClientRect();
    var w = Math.ceil(rect.width), h = Math.ceil(rect.height);
    var key = w + 'x' + h;
    if (key === lastSizeKey) return;
    lastSizeKey = key;
    postToHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: w, height: h }
    });
  }

  function openLink(url) {
    // MCP Apps bridge: ask the host to open the link (wallet handoff for tips).
    // Only our own https origin ever leaves the widget — a compromised or
    // spoofed data payload cannot redirect the user elsewhere.
    if (typeof url !== 'string' || url.indexOf(appOrigin + '/') !== 0) return;
    if (window.parent !== window) {
      postToHost({
        jsonrpc: '2.0', id: 'open-link-' + Date.now(),
        method: 'ui/open-link', params: { url: url }
      });
    } else {
      window.open(url, '_blank');
    }
  }

  function handleToolResult(payload) {
    try {
      var result = payload && payload.result ? payload.result : payload;
      // Honest failure state: a tool-level error must say so, never a dead card.
      if (result && (result.isError === true || result.error)) {
        var errText = result.error ||
          (result.content && result.content[0] && result.content[0].text) ||
          'The lookup failed.';
        card.innerHTML = '<div class="loading">' + esc(String(errText)).slice(0, 140) + '</div>';
        return;
      }
      // Tool results arrive as { content: [{ type: 'text', text: '{...json...}' }] }
      var content = result && result.content;
      var text = content && content[0] && content[0].text;
      var parsed = JSON.parse(text);
      // unwrap toolResult envelope if present
      data = parsed && parsed.data ? parsed.data : parsed;
      if (data && data.username) {
        render(data);
        reportSize();
      } else {
        card.innerHTML = '<div class="loading">Blockpage not found.</div>';
      }
    } catch (err) {
      card.innerHTML = '<div class="loading">Could not load preview.</div>';
    }
  }

  window.addEventListener('message', function (event) {
    // Only the embedding host frame may drive the widget — ignore stray
    // messages from any other window.
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.jsonrpc !== '2.0') return;
    // Host's answer to our ui/initialize request: complete the handshake,
    // THEN tell the host we're ready for tool notifications.
    if (msg.id === INIT_ID && !msg.method) {
      if (!msg.error) {
        bridgeReady = true;
        postToHost({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      }
      return;
    }
    if (typeof msg.method !== 'string') return;
    // Host delivering the tool result
    if (msg.method === 'ui/notifications/tool-result' && msg.params) {
      handleToolResult(msg.params);
    } else if (msg.method === 'ui/notifications/tool-input' && msg.params) {
      // Input arrives before the result; the result drives the render.
      data = null;
    } else if (msg.method === 'ui/notifications/host-context-changed' && msg.params) {
      // Theme/display changes from the host — stored for render decisions.
      hostContext = msg.params;
    }
  });
  // Announce readiness: the full initialize lifecycle starts here.
  if (window.parent !== window) {
    postToHost({ jsonrpc: '2.0', id: INIT_ID, method: 'ui/initialize', params: {} });
    // Keep the frame sized to the content as it changes.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { reportSize(); }).observe(card);
    }
  }
  // Preloaded data (server-side screenshot path): render immediately,
  // no postMessage handshake needed.
  if (window.__VOICESCAPE_PRELOAD__ && window.__VOICESCAPE_PRELOAD__.username) {
    render(window.__VOICESCAPE_PRELOAD__);
    data = window.__VOICESCAPE_PRELOAD__;
  }
  // Fallback: if no host after 3s, show a hint
  setTimeout(function () {
    if (!data && card.querySelector('.loading')) {
      card.innerHTML = '<div class="loading">Open this in an MCP Apps client<br>(Claude, ChatGPT) to see the preview.</div>';
    }
  }, 3000);
})();
</script>
</body>
</html>`.replace("__PRELOAD_JSON__", () => preloadJson)
    .replace("__APP_ORIGIN__", () => JSON.stringify(safeOrigin));
}
