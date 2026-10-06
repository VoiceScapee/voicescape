# Scripts

## stub-host-harness.mjs

Standalone SEP-1865 (MCP Apps) protocol verifier. Point it at any widget and
it plays the host side: handshake, tool-result delivery, button clicks, then
asserts the transcript against the spec.

```bash
# Test our reference widget (no args needed beyond this)
node stub-host-harness.mjs --reference-widget

# Test a widget from a URL
node stub-host-harness.mjs --widget-url https://example.com/widget

# Test a widget from a local HTML file
node stub-host-harness.mjs --widget-file ./widget.html

# Point the reference widget at YOUR bridge/host to verify your host impl
node stub-host-harness.mjs --reference-widget --bridge-url https://your-bridge.example/
```

Requires `puppeteer-core` and `@sparticuz/chromium` (same stack as CI).
From the repo root: `ln -s ../frontend/node_modules scripts/node_modules`
(don't commit the symlink).

Checks:
- Effect-based: widget actually renders on tool-result (not just method names)
- Spec allowlist: every emitted method is SEP-1865
- Handshake order: initialize -> initialized
- open-link URLs are origin-pinned, kebab-case (no `ui/openLink` leakage)
- Prints the full JSON-RPC transcript for pasting into a thread
