"use client";

/**
 * TEMPORARY debug page — reproduces the wallet-connect flow step by step
 * with visible logging so we can see exactly where it breaks in a real
 * browser. DELETE before any public launch.
 */
import { useRef, useState } from "react";

export default function DebugWalletPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const logRef = useRef<string[]>([]);

  const log = (msg: string) => {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    logRef.current = [...logRef.current, line];
    setLines(logRef.current);
    // eslint-disable-next-line no-console
    console.log("[debug-wallet]", msg);
  };

  async function run() {
    if (running) return;
    setRunning(true);
    logRef.current = [];
    setLines([]);
    try {
      log("step 1: importing hashconnect…");
      const { HashConnect } = (await import("hashconnect")) as typeof import("hashconnect");
      log("step 1 OK: HashConnect loaded");

      log("step 2: importing @hashgraph/sdk…");
      const { LedgerId } = await import("@hashgraph/sdk");
      log("step 2 OK: LedgerId loaded");

      log("step 3: constructing HashConnect…");
      const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
      log(`step 3a: projectId present=${projectId.length > 0} len=${projectId.length}`);
      const hc = new HashConnect(
        LedgerId.MAINNET,
        projectId,
        {
          name: "Voicescape",
          description: "debug",
          icons: [`${window.location.origin}/icon.svg`],
          url: window.location.origin,
        },
        true, // debug on
      );
      log("step 3 OK: constructed");

      log("step 4: attaching pairingEvent listener…");
      hc.pairingEvent.on((data) => {
        log(`EVENT pairingEvent: accounts=${JSON.stringify(data.accountIds)}`);
      });
      log("step 4 OK");

      log("step 5: calling hc.init() (15s timeout)…");
      await Promise.race([
        hc.init(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("init() timed out after 15s")), 15000)),
      ]);
      log("step 5 OK: init() resolved");

      log(`step 6: connectedAccountIds=${JSON.stringify(hc.connectedAccountIds.map((a) => a.toString()))}`);

      log("step 7: calling openPairingModal('dark')…");
      await hc.openPairingModal("dark");
      log("step 7 OK: openPairingModal resolved");

      await new Promise((r) => setTimeout(r, 1500));
      const modal = document.querySelector("wcm-modal");
      log(`step 8: wcm-modal in DOM = ${!!modal}`);
      if (modal) {
        const rect = modal.getBoundingClientRect();
        log(`step 8a: modal rect ${rect.width}x${rect.height} at ${rect.x},${rect.y}`);
        log(`step 8b: modal shadowRoot = ${!!(modal as HTMLElement & { shadowRoot?: unknown }).shadowRoot}`);
      }
      log("DONE — modal should be visible. (Not pairing, just observing.)");
    } catch (e) {
      log(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      if (e instanceof Error && e.stack) log(`stack: ${e.stack.split("\n").slice(0, 4).join(" | ")}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: "0 auto", fontFamily: "monospace" }}>
      <h1>Wallet debug</h1>
      <button
        onClick={run}
        disabled={running}
        style={{ padding: "10px 20px", fontSize: 16, marginBottom: 16 }}
      >
        {running ? "Running…" : "Run HashConnect flow"}
      </button>
      <div
        style={{
          background: "#111",
          color: "#0f0",
          padding: 16,
          borderRadius: 8,
          whiteSpace: "pre-wrap",
          minHeight: 300,
          fontSize: 13,
        }}
      >
        {lines.length === 0 ? "Press the button." : lines.join("\n")}
      </div>
    </div>
  );
}
