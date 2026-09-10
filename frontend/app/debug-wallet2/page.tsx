"use client";

import { useState } from "react";

export default function DebugWallet2() {
  const [log, setLog] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);

  function addLog(msg: string) {
    setLog((prev) => [...prev, `${new Date().toISOString().substr(11, 8)} ${msg}`]);
  }

  async function runTest() {
    setTesting(true);
    setLog([]);
    try {
      addLog("Step 1: Starting dynamic import...");
      const start = Date.now();
      const [{ HashConnect }, { LedgerId }] = await Promise.all([
        import("hashconnect"),
        import("@hashgraph/sdk"),
      ]);
      addLog(`Step 1 OK: Import succeeded in ${Date.now() - start}ms`);

      addLog("Step 2: Checking env var...");
      const pid = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
      addLog(`Step 2: Project ID ${pid ? "is SET (length " + pid.length + ")" : "is MISSING"}`);
      if (!pid) {
        addLog("ERROR: Cannot proceed without Project ID");
        return;
      }

      addLog("Step 3: Creating HashConnect instance...");
      const hc = new HashConnect(
        LedgerId.MAINNET,
        pid,
        {
          name: "Voicescape",
          description: "Test",
          icons: [`${window.location.origin}/icon.svg`],
          url: window.location.origin,
        },
        false,
      );
      addLog("Step 3 OK: Instance created");

      addLog("Step 4: Calling hc.init()...");
      const initStart = Date.now();
      await hc.init();
      addLog(`Step 4 OK: init() completed in ${Date.now() - initStart}ms`);

      addLog("Step 5: Calling hc.openPairingModal()...");
      await hc.openPairingModal();
      addLog("Step 5 OK: openPairingModal() called - QR should be visible now");

    } catch (e) {
      addLog(`ERROR: ${e instanceof Error ? e.name + ": " + e.message : String(e)}`);
      if (e instanceof Error && e.stack) {
        addLog(`Stack: ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "monospace", maxWidth: 800, margin: "0 auto" }}>
      <h1>Wallet Debug v2</h1>
      <button
        onClick={runTest}
        disabled={testing}
        style={{ padding: "10px 20px", fontSize: 16, marginBottom: 20 }}
      >
        {testing ? "Testing..." : "Run HashConnect Test"}
      </button>
      <div style={{ background: "#f0f0f0", padding: 15, borderRadius: 5, minHeight: 200 }}>
        {log.length === 0 ? (
          <p style={{ color: "#999" }}>Click the button to start the test...</p>
        ) : (
          log.map((line, i) => (
            <div key={i} style={{ marginBottom: 5, fontSize: 14 }}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
