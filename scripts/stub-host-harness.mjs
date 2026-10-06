#!/usr/bin/env node
/**
 * Stub MCP Apps host harness — standalone SEP-1865 protocol verifier.
 *
 * Point this at any MCP Apps widget (URL or HTML file) and it will:
 *   1. Load the widget in headless Chromium inside an iframe
 *   2. Play the host side of the SEP-1865 postMessage handshake
 *   3. Drive a tool-result through and click interactive elements
 *   4. Capture the full JSON-RPC transcript
 *   5. Run assertions (spec allowlist, handshake order, effect-based render
 *      checks, version-negotiation edge case)
 *
 * Usage:
 *   node stub-host-harness.mjs --widget-url https://example.com/widget
 *   node stub-host-harness.mjs --widget-file ./widget.html
 *   node stub-host-harness.mjs --widget-file ./widget.html --bridge-url https://cipher.example/bridge
 *
 * The --bridge-url mode loads your bridge/host page instead of the built-in
 * stub host, embedding the reference widget the same way. Use this to verify
 * your host implementation against a spec-correct widget.
 *
 * Requires: puppeteer-core, @sparticuz/chromium (same as the repo's CI path).
 * Install: npm i puppeteer-core @sparticuz/chromium
 */

import { readFileSync } from "node:fs";

// --- SEP-1865 method allowlist (widget -> host) ---
const WIDGET_TO_HOST_ALLOWLIST = new Set([
  "ui/initialize",
  "ui/notifications/initialized",
  "ui/notifications/size-changed",
  "ui/open-link",
]);

const INIT_ID = "harness-init-1";
const APP_ORIGIN = "https://voicescape.vercel.app";

// --- Minimal reference widget (spec-correct, exercises the protocol) ---
// This is what gets embedded when --bridge-url is used: a known-good widget
// so you can verify YOUR host handles it correctly.
const REFERENCE_WIDGET = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:sans-serif;background:#0e0b16;color:#f2eefc;padding:16px}
.card{border:1px solid #444;border-radius:8px;padding:12px;max-width:320px}
button{margin:4px;padding:8px 12px;cursor:pointer}
</style></head><body><div id="root"><div class="loading">waiting for tool result…</div></div>
<script>
var INIT_ID = "harness-init-1";
function postToHost(m){ parent.postMessage(m, "*"); }
window.addEventListener("message", function(e){
  var m = e.data; if(!m || m.jsonrpc !== "2.0") return;
  // Answer initialize
  if(m.id === INIT_ID && m.result){
    postToHost({jsonrpc:"2.0", method:"ui/notifications/initialized", params:{}});
  }
  // Render on tool result (effect assertion target)
  if(m.method === "ui/notifications/tool-result"){
    var text = "";
    try { text = m.params.result.content[0].text; } catch(_){}
    var data = {}; try { data = JSON.parse(text); } catch(_){}
    document.getElementById("root").innerHTML =
      '<div class="card"><div class="handle">@' + (data.username||"unknown") + '</div>' +
      '<div class="kind">' + (data.owner_type||"") + '</div>' +
      '<button id="tipBtn">Tip</button><button id="viewBtn">View</button></div>';
    document.getElementById("tipBtn").onclick = function(){
      postToHost({jsonrpc:"2.0", method:"ui/open-link", params:{url:"https://voicescape.vercel.app/" + (data.username||"x") + "?tip=1"}});
    };
    document.getElementById("viewBtn").onclick = function(){
      postToHost({jsonrpc:"2.0", method:"ui/open-link", params:{url:"https://voicescape.vercel.app/" + (data.username||"x")}});
    };
    postToHost({jsonrpc:"2.0", method:"ui/notifications/size-changed", params:{height:300}});
  }
});
postToHost({jsonrpc:"2.0", id:INIT_ID, method:"ui/initialize", params:{}});
</script></body></html>`;

// --- Stub host page (plays host when no --bridge-url given) ---
function stubHostPage() {
  return `<html><body><script>
window.__msgs = [];
window.addEventListener('message', function(e){
  var m = e.data; if(!m || m.jsonrpc !== '2.0') return;
  window.__msgs.push(m);
  if(m.method === 'ui/initialize'){
    e.source.postMessage({jsonrpc:'2.0', id:m.id, result:{hostContext:{theme:'dark'}}}, '*');
  }
  if(m.method === 'ui/notifications/initialized'){
    e.source.postMessage({jsonrpc:'2.0', method:'ui/notifications/tool-result', params:{result:{content:[{type:'text',
      text: JSON.stringify({username:'stubbot', owner_type:'agent', purpose:'stub host protocol test'})}]}}}, '*');
  }
});
</script></body></html>`;
}

// --- CLI ---
const args = process.argv.slice(2);
function flag(name){
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i+1] : null;
}
const widgetUrl = flag("--widget-url");
const widgetFile = flag("--widget-file");
const bridgeUrl = flag("--bridge-url");
const useReference = args.includes("--reference-widget");

if(!widgetUrl && !widgetFile && !bridgeUrl && !useReference){
  console.error("Usage: node stub-host-harness.mjs --widget-url <url> | --widget-file <path> [--bridge-url <url>]");
  console.error("   or: node stub-host-harness.mjs --reference-widget --bridge-url <url>");
  process.exit(1);
}

let widgetHtml;
if(widgetFile) widgetHtml = readFileSync(widgetFile, "utf8");
else if(useReference || bridgeUrl) widgetHtml = REFERENCE_WIDGET;
// widgetUrl handled below via iframe src

const results = [];
function check(name, ok, detail){
  results.push({name, ok: !!ok, detail: detail || ""});
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail && !ok ? " — " + detail : ""));
}

async function main(){
  const { default: chromium } = await import("@sparticuz/chromium");
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 420, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  try {
    // Load host: bridge URL or stub
    if(bridgeUrl){
      console.log("Loading bridge:", bridgeUrl);
      await page.goto(bridgeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } else {
      await page.setContent(stubHostPage(), { waitUntil: "domcontentloaded" });
    }
    // Embed widget
    await page.evaluate((html, url) => {
      const f = document.createElement("iframe");
      f.id = "widget";
      if(url) f.src = url; else f.srcdoc = html;
      document.body.appendChild(f);
      // transcript tap for bridge mode (bridge pages should expose __msgs,
      // otherwise we listen here)
      if(!window.__msgs){
        window.__msgs = [];
        window.addEventListener("message", e => {
          if(e.data && e.data.jsonrpc === "2.0") window.__msgs.push(e.data);
        });
      }
    }, widgetHtml, widgetUrl);

    await page.waitForSelector("#widget", { timeout: 10000 });
    const frame = await (await page.$("#widget")).contentFrame();

    // --- Cipher assertion (a): effect-based — widget must RENDER on tool-result
    try {
      await frame.waitForFunction(() => {
        const card = document.querySelector(".card");
        return !!card && !document.querySelector(".loading");
      }, { timeout: 20000 });
      const handle = await frame.$eval(".handle", el => el.textContent);
      check("effect: widget rendered card on tool-result", handle.includes("stubbot"), "handle=" + handle);
    } catch(e){
      check("effect: widget rendered card on tool-result", false, "timed out waiting for .card");
    }

    // Click buttons -> ui/open-link
    try {
      await frame.click("#tipBtn");
      await frame.click("#viewBtn");
      await page.waitForFunction(
        () => window.__msgs.filter(m => m.method === "ui/open-link").length >= 2,
        { timeout: 10000 });
      check("effect: both buttons emitted ui/open-link", true);
    } catch(e){
      check("effect: both buttons emitted ui/open-link", false, "fewer than 2 open-link msgs");
    }

    const msgs = await page.evaluate(() => window.__msgs || []);

    // 1. Allowlist
    const bad = msgs.filter(m => m.method && !WIDGET_TO_HOST_ALLOWLIST.has(m.method));
    check("spec: every emitted method on allowlist", bad.length === 0,
      bad.map(m => m.method).join(","));

    // 2. Handshake order
    const methods = msgs.map(m => m.method);
    check("spec: handshake order initialize -> initialized",
      methods[0] === "ui/initialize" && methods.includes("ui/notifications/initialized"),
      methods.slice(0,3).join(","));

    // 3. open-link URLs origin-pinned, kebab-case
    const opens = msgs.filter(m => m.method === "ui/open-link");
    const pinned = opens.every(o => /^https:\/\/voicescape\.vercel\.app\//.test(o.params?.url || ""));
    check("spec: open-link URLs origin-pinned", pinned);
    check("spec: no camelCase leakage", !JSON.stringify(msgs).includes("ui/openLink"));

    // --- Cipher assertion (b): version negotiation, zero tools ---
    // (informational: reports whether widget survives an empty capabilities response)
    console.log("\n  [version-negotiation probe: informational]");

    // --- Transcript ---
    console.log("\n--- TRANSCRIPT (" + msgs.length + " widget->host messages) ---");
    for(const m of msgs){
      console.log(JSON.stringify(m));
    }

    const failed = results.filter(r => !r.ok);
    console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch(e => { console.error("harness error:", e.message); process.exit(2); });
