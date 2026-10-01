"use client";

/**
 * /embed — "Get your tip button" creator page.
 *
 * Plain-language, no jargon: type your username, copy the code, paste it on
 * your website or link-in-bio page. Live preview shows exactly what visitors
 * will see. When someone tips through it, the tip settles through the
 * standard on-chain flow — the creator keeps 98%.
 */
import { useMemo, useState } from "react";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import {
  EMBED_AMOUNT_PRESETS,
  buildEmbedTipSnippet,
  normalizeEmbedUsername,
} from "@/lib/embed";
import "./embed.css";

export default function EmbedPage() {
  const [username, setUsername] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const name = useMemo(() => normalizeEmbedUsername(username), [username]);
  const snippet = useMemo(
    () => (name ? buildEmbedTipSnippet(name, amount != null ? { amount } : {}) : ""),
    [name, amount],
  );
  const previewUrl = useMemo(
    () =>
      name
        ? `/embed/tip/${name}${amount != null ? `?amount=${amount}` : ""}`
        : "",
    [name, amount],
  );

  const copy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
    } catch {
      // Clipboard API unavailable (permissions, non-secure context) —
      // fall back to selecting the textarea for manual copy.
      const el = document.getElementById("embed-code") as HTMLTextAreaElement | null;
      el?.focus();
      el?.select();
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Navbar right={<WalletConnect />} />
      <main className="embed-page">
        <h1>Get your tip button</h1>
        <p className="lede">
          Put a tip button on your own website, blog, or link-in-bio page. Visitors tip
          you without leaving your site — every tip settles on Hedera and{" "}
          <strong>you keep 98%</strong> of it, sent straight to your wallet.
        </p>

        <div className="embed-field">
          <label htmlFor="embed-username">Your Voicescape username</label>
          <input
            id="embed-username"
            className="embed-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. bacon-the-dino"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="embed-field">
          <label>Suggested tip amount (optional)</label>
          <div className="embed-chips">
            <button
              type="button"
              className={`th-chip${amount == null ? " is-active" : ""}`}
              onClick={() => setAmount(null)}
            >
              Let them choose
            </button>
            {EMBED_AMOUNT_PRESETS.map((a) => (
              <button
                key={a}
                type="button"
                className={`th-chip${amount === a ? " is-active" : ""}`}
                onClick={() => setAmount(a)}
              >
                ${a}
              </button>
            ))}
          </div>
        </div>

        {name ? (
          <>
            <div className="embed-field">
              <label htmlFor="embed-code">Copy this code, paste it on your site</label>
              <textarea id="embed-code" className="embed-code" readOnly value={snippet} />
              <div className="embed-row" style={{ marginTop: 8 }}>
                <button type="button" className="vs-btn vs-btn-primary" onClick={copy}>
                  {copied ? "Copied!" : "Copy code"}
                </button>
              </div>
            </div>

            <div className="embed-field">
              <label>Preview — this is what your visitors see</label>
              <div className="embed-preview-wrap">
                <iframe
                  src={previewUrl}
                  width="320"
                  height="480"
                  style={{ border: 0, borderRadius: 16, maxWidth: "100%" }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  title={`Preview: tip @${name} on Voicescape`}
                />
              </div>
            </div>
          </>
        ) : (
          <p className="embed-note">
            Type your username above to generate your code. It&apos;s the same name as
            your blockpage — the part after voicescape.vercel.app/ in your page
            address.
          </p>
        )}

        <ol className="embed-steps">
          <li>Type your Voicescape username above.</li>
          <li>Copy the code.</li>
          <li>
            Paste it where your site lets you add HTML — for example a Carrd
            &ldquo;Embed&rdquo; element or the custom-HTML block on your blog.
          </li>
          <li>
            Done. Tips come straight to your wallet through the same on-chain flow
            as tipping on your blockpage — you keep 98% of every one.
          </li>
        </ol>

        <p className="embed-note">
          The button opens your visitor&apos;s wallet inside the frame — they never
          leave your site, and your site can&apos;t see their wallet or their
          Voicescape session. It works on phones and desktops.
        </p>
      </main>
    </>
  );
}
