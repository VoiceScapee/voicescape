/**
 * MCP Apps widgets — interactive UI resources rendered inside AI chat clients.
 *
 * Per the finalized MCP Apps spec (io.modelcontextprotocol/ui, Jan 2026):
 * the server registers ui:// resources (self-contained HTML, MIME
 * text/html;profile=mcp-app) and links them from render tools via
 * _meta.ui.resourceUri. The host (Claude, ChatGPT, etc.) renders the HTML
 * in a sandboxed iframe; the widget talks back over postMessage JSON-RPC.
 *
 * Security: the widget is untrusted by design — no keys, no signing, no
 * wallet APIs. All money actions hand off to the user's own wallet via
 * openLink. Widgets are display + decision; the wallet is authority.
 */

export const BLOCKPAGE_PREVIEW_URI = "ui://voicescape/blockpage-preview";

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
export function blockpagePreviewHtml(preload?: {
  username: string;
  owner_type: string;
  purpose?: string | null;
}): string {
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
  var appOrigin = 'https://voicescape.vercel.app';
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

  function openLink(url) {
    // MCP Apps bridge: ask the host to open the link (wallet handoff for tips).
    if (window.parent !== window) {
      window.parent.postMessage({
        jsonrpc: '2.0', id: Date.now(),
        method: 'ui/openLink', params: { url: url }
      }, '*');
    } else {
      window.open(url, '_blank');
    }
  }

  function handleToolResult(payload) {
    try {
      // Tool results arrive as { content: [{ type: 'text', text: '{...json...}' }] }
      var content = payload && payload.content;
      var text = content && content[0] && content[0].text;
      var parsed = JSON.parse(text);
      // unwrap toolResult envelope if present
      data = parsed && parsed.data ? parsed.data : parsed;
      if (data && data.username) render(data);
      else card.innerHTML = '<div class="loading">Blockpage not found.</div>';
    } catch (err) {
      card.innerHTML = '<div class="loading">Could not load preview.</div>';
    }
  }

  // MCP Apps bridge handshake
  var initialized = false;
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    // Host delivering the tool result
    if (msg.method === 'ui/notifications/tool-result' && msg.params) {
      handleToolResult(msg.params.result || msg.params);
    }
  });
  // Announce readiness to the host
  if (window.parent !== window) {
    window.parent.postMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }, '*');
    initialized = true;
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
</html>`.replace("__PRELOAD_JSON__", () => preloadJson);
}
