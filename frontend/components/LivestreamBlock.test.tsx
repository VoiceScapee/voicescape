/**
 * LivestreamBlock regression tests — source assertions, repo convention (no
 * jsdom here; components render in node-only vitest), plus a direct unit test
 * of the pure YouTube chat-URL helper.
 *
 * Guards the honesty rules: offline is the default until the player itself
 * says ONLINE/PLAYING; no raw platform error state ever; YouTube chat is the
 * real live_chat embed for the currently-playing video (never faked); tips
 * reuse the existing onTip flow (no new money code).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { youTubeLiveChatSrc } from "./LivestreamBlock";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "LivestreamBlock.tsx"), "utf8");
const rendererSrc = readFileSync(join(here, "PageRenderer.tsx"), "utf8");
const builderSrc = readFileSync(join(here, "..", "app", "builder", "page.tsx"), "utf8");

describe("LivestreamBlock — offline-first honesty", () => {
  it("starts offline: live state defaults to false and the offline card renders", () => {
    expect(src).toMatch(/useState\(false\)/);
    expect(src).toContain("OfflineCard");
    expect(src).toContain("livestream.offline");
  });

  it("Twitch goes live only on the player's ONLINE event (READY-gated)", () => {
    expect(src).toContain("Twitch.Player.READY");
    expect(src).toContain("Twitch.Player.ONLINE");
    expect(src).toContain("Twitch.Player.OFFLINE");
    // OFFLINE must flip it back — never stuck on a stale live state.
    expect(src).toMatch(/OFFLINE[\s\S]*?setLive\(false\)/);
  });

  it("never shows a raw player error state", () => {
    // Script/API load failures settle to offline, never an error UI.
    expect(src).toMatch(/catch\(\(\) => \{\s*\/\/ Script failed: stay offline/);
    // No error state hook, no error banner rendered anywhere.
    expect(src).not.toMatch(/useState<[^>]*[Ee]rror/);
    expect(src).not.toMatch(/set[A-Z][A-Za-z]*Error\(/);
    expect(src).not.toMatch(/className="[^"]*error[^"]*"/i);
  });
});

describe("LivestreamBlock — Twitch wiring", () => {
  it("loads the official Twitch embed script", () => {
    expect(src).toContain("https://player.twitch.tv/js/embed/v1.js");
  });

  it("passes parent as the embedding hostname (Twitch requires it)", () => {
    expect(src).toMatch(/parent:\s*\[window\.location\.hostname\]/);
  });

  it("muted autoplay by default with a tap-for-sound unmute", () => {
    expect(src).toMatch(/muted:\s*true/);
    expect(src).toMatch(/autoplay:\s*true/);
    expect(src).toContain("setMuted(false)");
    expect(src).toContain("livestream.tapForSound");
  });

  it("embeds official Twitch chat with darkpopout, keyed to the same channel + hostname", () => {
    expect(src).toContain("https://www.twitch.tv/embed/");
    expect(src).toContain("/chat?parent=");
    expect(src).toContain("darkpopout");
  });

  it("Twitch offline card links to the channel follow page", () => {
    expect(src).toContain("https://www.twitch.tv/${channel}");
  });
});

describe("LivestreamBlock — YouTube wiring", () => {
  it("uses the live_stream?channel= embed with muted autoplay + playsinline", () => {
    expect(src).toContain("https://www.youtube.com/embed/live_stream?channel=");
    expect(src).toContain("autoplay=1&mute=1&playsinline=1&enablejsapi=1");
  });

  it("never shows the raw iframe while offline (overlay covers it)", () => {
    // The offline overlay covers the iframe until the server status check
    // says live — no raw platform player or error card is ever exposed.
    expect(src).toMatch(/\{!live && \(\s*<div className="vs-livestream-overlay">/);
  });

  it("renders the real YouTube live_chat embed once a live video id is known", () => {
    // Chat panel is no longer Twitch-only: YouTube gets the official
    // live_chat embed for the currently-playing video, hidden until live.
    // Desktop renders it in the inline side-by-side column…
    expect(src).toContain("youTubeLiveChatSrc");
    expect(src).toMatch(/\{activeChatSrc && !isMobile && \(\s*<div className="vs-livestream-chat">/);
    // …while phones get the floating widget (one chat iframe at a time).
    expect(src).toMatch(/\{activeChatSrc && isMobile && <FloatingChatWidget chatSrc=\{activeChatSrc\}/);
    // Never a faked chat: the iframe src is the official live_chat endpoint.
    expect(src).toContain("https://www.youtube.com/live_chat?v=");
    expect(src).toContain("embed_domain=");
  });

  it("youTubeLiveChatSrc builds the official live_chat URL", () => {
    expect(youTubeLiveChatSrc("dQw4w9WgXcQ", "voicescape.vercel.app")).toBe(
      "https://www.youtube.com/live_chat?v=dQw4w9WgXcQ&embed_domain=voicescape.vercel.app",
    );
  });

  it("drives YouTube live state from the server status check, not the player", () => {
    // Regression: watching the live_stream resolver embed for a PLAYING event
    // through the IFrame API never fired on real phones, so the badge stayed
    // offline on a live stream. Live state now comes from /api/youtube-live.
    expect(src).toContain("/api/youtube-live?channel=");
    expect(src).toMatch(/setInterval\(check, 5 \* 60_000\)/);
  });

  it("embeds the concrete live video directly when the server says live", () => {
    expect(src).toContain("https://www.youtube.com/embed/${youTube.videoId}");
  });

  it("re-checks live status periodically so an ended stream flips offline", () => {
    expect(src).toMatch(/setInterval\(check, 5 \* 60_000\)/);
    // Offline is the default and any check failure keeps it.
    expect(src).toContain("offline-first");
  });

  it("mobile chat is a floating widget, not Stream/Chat tabs", () => {
    // Brandon's call: on phones viewers watch and chat at the same time, so
    // the tab switcher is gone — chat is a floating, draggable widget.
    expect(src).not.toContain('role="tablist"');
    expect(src).not.toContain("vs-livestream-tabs");
    expect(src).not.toContain("mobileTab");
    expect(src).toContain("FloatingChatWidget");
    expect(src).toContain("vs-chatfloat");
  });

  it("YouTube offline card links to the channel page", () => {
    expect(src).toContain("https://www.youtube.com/channel/${channel}");
  });

  it("unmute uses the IFrame API unMute (user gesture)", () => {
    expect(src).toContain("unMute?.()");
  });
});

describe("LivestreamBlock — channel sanitization + invalid config", () => {
  it("sanitizes the channel before embedding anything", () => {
    expect(src).toContain("sanitizeLivestreamChannel(block.platform, block.channel)");
  });

  it("renders nothing on a live page when the channel is invalid", () => {
    expect(src).toMatch(/if \(!channel\) \{[\s\S]*?if \(!preview\) return null;/);
  });

  it("shows a quiet invalid-config note in the builder preview only", () => {
    expect(src).toContain("livestream.invalidChannel");
  });
});

describe("LivestreamBlock — tips reuse the existing flow", () => {
  it("tip button calls the page's onTip (no new money code)", () => {
    expect(src).toMatch(/\{tipInteractive && onTip && \(\s*<button[^>]*onClick=\{onTip\}/);
    expect(src).toContain("livestream.tipStreamer");
    expect(src).not.toMatch(/writeContract|sendTransaction|parseEther/);
  });
});

describe("LivestreamBlock — responsive layout", () => {
  it("phone chat is a collapsible, draggable floating widget", () => {
    // Starts as a bubble so it never covers the video on load; the header
    // drags via pointer events; collapsing slides it off-screen instead of
    // unmounting so the live chat stays connected.
    expect(src).toContain("vs-chatfloat-bubble");
    expect(src).toContain("vs-chatfloat-header");
    expect(src).toContain("onPointerDown");
    expect(src).toContain("setPointerCapture");
    expect(src).toContain("vs-chatfloat-collapsed");
    expect(src).toContain('useMatchMedia("(max-width: 640px)")');
  });

  it("desktop keeps chat side-by-side with the player", () => {
    expect(src).toMatch(/\{activeChatSrc && !isMobile && \(\s*<div className="vs-livestream-chat">/);
    const css = readFileSync(join(here, "renderer.css"), "utf8");
    // The widget is phone-only; the inline column is hidden on phones.
    expect(css).toMatch(
      /@media \(min-width: 641px\)[\s\S]*?\.vs-chatfloat-root[\s\S]*?display:\s*none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.vs-livestream-chat[\s\S]*?display:\s*none/,
    );
  });

  it("player keeps 16:9", () => {
    const css = readFileSync(join(here, "renderer.css"), "utf8");
    expect(css).toMatch(/\.vs-livestream-frame[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
  });
});

describe("livestream block wiring", () => {
  it("PageRenderer handles the livestream case with onTip/tipInteractive", () => {
    expect(rendererSrc).toMatch(/case "livestream":[\s\S]*?<LivestreamBlock/);
    expect(rendererSrc).toMatch(/<LivestreamBlock[\s\S]*?tipInteractive=\{tipInteractive\}/);
    expect(rendererSrc).toMatch(/<LivestreamBlock[\s\S]*?onTip=\{onTip\}/);
  });

  it("builder preview passes the preview flag", () => {
    expect(builderSrc).toMatch(/<PageRenderer page=\{page\} preview \/>/);
  });

  it("builder has a livestream editor section (platform + channel)", () => {
    expect(builderSrc).toContain('block.type === "livestream"');
    expect(builderSrc).toMatch(/value=\{block\.platform\}/);
    expect(builderSrc).toMatch(/value=\{block\.channel\}/);
  });

  it("add-block dropdown picks up livestream from BLOCK_TYPES", () => {
    expect(builderSrc).toContain("BLOCK_TYPES.map");
  });
});
