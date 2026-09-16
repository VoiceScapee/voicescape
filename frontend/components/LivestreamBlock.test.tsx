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

  it("treats onError 100/150 as offline and PLAYING as live (never the raw iframe)", () => {
    expect(src).toContain("onError");
    expect(src).toMatch(/e\?\.data === 100 \|\| e\?\.data === 150/);
    expect(src).toContain("YT.PlayerState.PLAYING");
  });

  it("renders the real YouTube live_chat embed once a live video id is known", () => {
    // Chat panel is no longer Twitch-only: YouTube gets the official
    // live_chat embed for the currently-playing video, hidden until live.
    expect(src).toContain("youTubeLiveChatSrc");
    expect(src).toMatch(/\{\(isTwitch \|\| youTubeChat\) && \(\s*<div[^>]*vs-livestream-chat/);
    // Never a faked chat: the iframe src is the official live_chat endpoint.
    expect(src).toContain("https://www.youtube.com/live_chat?v=");
    expect(src).toContain("embed_domain=");
  });

  it("youTubeLiveChatSrc builds the official live_chat URL", () => {
    expect(youTubeLiveChatSrc("dQw4w9WgXcQ", "voicescape.vercel.app")).toBe(
      "https://www.youtube.com/live_chat?v=dQw4w9WgXcQ&embed_domain=voicescape.vercel.app",
    );
  });

  it("captures the playing video id from the IFrame API (chat needs it)", () => {
    expect(src).toContain("getVideoData");
    expect(src).toMatch(/video_id/);
    expect(src).toMatch(/PLAYING[\s\S]*?setVideoId/);
  });

  it("ended streams clear live state and drop the chat", () => {
    expect(src).toMatch(/PlayerState\.ENDED[\s\S]*?setLive\(false\)/);
    expect(src).toMatch(/PlayerState\.ENDED[\s\S]*?setVideoId\(null\)/);
  });

  it("Stream/Chat mobile tabs appear for YouTube chat too", () => {
    expect(src).toMatch(/\{showChat && \(\s*<div className="vs-livestream-tabs"/);
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
  it("has Stream/Chat tabs for Twitch (mobile pattern)", () => {
    expect(src).toContain('role="tablist"');
    expect(src).toContain("livestream.stream");
    expect(src).toContain("livestream.chat");
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
