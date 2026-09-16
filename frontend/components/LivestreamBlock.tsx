"use client";

/**
 * Livestream block (Phase 1): Twitch/YouTube embeds only — $0, no video
 * pipeline. The blockpage is never in the video pipeline; the owner streams
 * to the platform directly (OBS/phone app) and this block embeds the
 * platform's own player.
 *
 * Honesty rules:
 * - Offline is the default. Twitch shows the player only after the player
 *   fires ONLINE; YouTube only after the IFrame API reports PLAYING.
 * - Never show a raw platform error state — an offline card always stands in.
 * - Twitch chat is the official embed. YouTube has no chat in Phase 1
 *   (player only — no fake chat).
 * - Tips reuse the page's existing onTip flow (atomic 98/2 contract).
 *   No new money code here.
 */
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { sanitizeLivestreamChannel, type Block } from "@/lib/schema";
import type { I18nKey } from "@/lib/i18n/dictionaries";
import { IconPlay, IconTip } from "./icons";

type LivestreamBlockT = Extract<Block, { type: "livestream" }>;

declare global {
  interface Window {
    Twitch?: any;
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const TWITCH_SCRIPT = "https://player.twitch.tv/js/embed/v1.js";
const YOUTUBE_API_SCRIPT = "https://www.youtube.com/iframe_api";

/** Placeholder so the player hooks run unconditionally (hooks rule) when the
 *  channel is invalid; the effects bail out early and the component renders
 *  the invalid-channel path instead. */
const PLACEHOLDER_CHANNEL = "___invalid___";

let twitchScriptPromise: Promise<void> | null = null;
function loadTwitchScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Twitch?.Player) return Promise.resolve();
  if (!twitchScriptPromise) {
    twitchScriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TWITCH_SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        twitchScriptPromise = null;
        reject(new Error("twitch embed script failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return twitchScriptPromise;
}

let youTubeApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve();
  if (!youTubeApiPromise) {
    youTubeApiPromise = new Promise<void>((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      const s = document.createElement("script");
      s.src = YOUTUBE_API_SCRIPT;
      s.async = true;
      s.onerror = () => {
        youTubeApiPromise = null;
        reject(new Error("youtube iframe api failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return youTubeApiPromise;
}

/** Twitch interactive player. `live` flips true only on the player's ONLINE event. */
function useTwitchPlayer(channel: string) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLive(false);
    if (channel === PLACEHOLDER_CHANNEL) return () => {};
    loadTwitchScript()
      .then(() => {
        if (cancelled || !mountRef.current) return;
        const p = new window.Twitch.Player(mountRef.current, {
          channel,
          // Twitch requires the embedding host (no scheme) or the player refuses to load.
          parent: [window.location.hostname],
          muted: true,
          autoplay: true,
          width: "100%",
          height: "100%",
        });
        playerRef.current = p;
        p.addEventListener(window.Twitch.Player.READY, () => {
          p.addEventListener(window.Twitch.Player.ONLINE, () => {
            if (!cancelled) setLive(true);
          });
          p.addEventListener(window.Twitch.Player.OFFLINE, () => {
            if (!cancelled) setLive(false);
          });
        });
      })
      .catch(() => {
        // Script failed: stay offline. Never surface a raw player error.
        if (!cancelled) setLive(false);
      });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore teardown errors */
      }
      playerRef.current = null;
    };
  }, [channel]);

  const unmute = () => {
    try {
      playerRef.current?.setMuted(false);
    } catch {
      /* ignore */
    }
  };

  return { mountRef, live, unmute };
}

/**
 * YouTube live player via the undocumented live_stream?channel= embed plus
 * the official IFrame Player API for state inference. `live` flips true only
 * when the player reports PLAYING; onError 100/150 (unavailable / embedding
 * not allowed) confirms offline. Never trust the iframe's own error card.
 */
function useYouTubeLive(channelId: string) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const playerRef = useRef<any>(null);
  const [live, setLive] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLive(false);
    setVideoId(null);
    if (channelId === PLACEHOLDER_CHANNEL) return () => {};
    loadYouTubeApi()
      .then(() => {
        if (cancelled || !iframeRef.current || !window.YT?.Player) return;
        const p = new window.YT.Player(iframeRef.current, {
          events: {
            onStateChange: (e: any) => {
              if (cancelled) return;
              if (e?.data === window.YT.PlayerState.PLAYING) {
                setLive(true);
                // The live_chat embed needs the concrete video id — read it
                // from the player once it's actually playing.
                try {
                  const vid = p.getVideoData?.()?.video_id;
                  if (typeof vid === "string" && vid) setVideoId(vid);
                } catch {
                  /* chat stays hidden; video still plays */
                }
              } else if (e?.data === window.YT.PlayerState.ENDED) {
                setLive(false);
                setVideoId(null);
              }
            },
            onError: (e: any) => {
              // 100 = video not found/unavailable, 150 = embedding not allowed.
              if (!cancelled && (e?.data === 100 || e?.data === 150)) setLive(false);
            },
          },
        });
        playerRef.current = p;
      })
      .catch(() => {
        if (!cancelled) setLive(false);
      });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore teardown errors */
      }
      playerRef.current = null;
    };
  }, [channelId]);

  const unmute = () => {
    try {
      playerRef.current?.unMute?.();
      playerRef.current?.setVolume?.(100);
    } catch {
      /* ignore */
    }
  };

  return { iframeRef, live, unmute, videoId };
}

/**
 * Official YouTube live-chat embed for the currently-playing video.
 * embed_domain must match the embedding host or YouTube refuses to load it.
 */
export function youTubeLiveChatSrc(videoId: string, hostname: string): string {
  return (
    `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}` +
    `&embed_domain=${encodeURIComponent(hostname)}`
  );
}

export default function LivestreamBlock({
  block,
  tipInteractive,
  onTip,
  preview,
}: {
  block: LivestreamBlockT;
  tipInteractive?: boolean;
  onTip?: () => void;
  /** Builder preview: shows a quiet note when the channel can't be embedded. */
  preview?: boolean;
}) {
  const { t } = useLanguage();
  const [mobileTab, setMobileTab] = useState<"stream" | "chat">("stream");
  const [unmuted, setUnmuted] = useState(false);

  const channel = sanitizeLivestreamChannel(block.platform, block.channel);

  // Hooks must run unconditionally — use a safe placeholder and gate rendering.
  const twitch = useTwitchPlayer(channel && block.platform === "twitch" ? channel : PLACEHOLDER_CHANNEL);
  const youTube = useYouTubeLive(channel && block.platform === "youtube" ? channel : PLACEHOLDER_CHANNEL);

  if (!channel) {
    // Bad config: render nothing on a live page; a quiet note in the builder
    // preview only, so the owner knows what to fix.
    if (!preview) return null;
    return (
      <section className="pv-block" aria-label={t("livestream.title")}>
        <p className="pv-empty">{t("livestream.invalidChannel")}</p>
      </section>
    );
  }

  const isTwitch = block.platform === "twitch";
  const { live, unmute } = isTwitch ? twitch : youTube;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const chatSrc = `https://www.twitch.tv/embed/${channel}/chat?parent=${encodeURIComponent(hostname)}&darkpopout`;
  // YouTube chat exists only while a concrete live video is playing.
  const youTubeChat =
    !isTwitch && live && youTube.videoId ? youTubeLiveChatSrc(youTube.videoId, hostname) : null;
  const showChat = isTwitch || youTubeChat;
  const youTubeSrc =
    `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channel)}` +
    `&autoplay=1&mute=1&playsinline=1&enablejsapi=1` +
    (typeof window !== "undefined" ? `&origin=${encodeURIComponent(window.location.origin)}` : "");
  const followUrl = isTwitch
    ? `https://www.twitch.tv/${channel}`
    : `https://www.youtube.com/channel/${channel}`;

  const handleUnmute = () => {
    unmute();
    setUnmuted(true);
  };

  const title = block.title?.trim() || t("livestream.title");

  return (
    <section className="pv-block vs-livestream" aria-label={title}>
      <h2 className="pv-block-title">
        <IconPlay size={20} />
        <span>{title}</span>
        {live && (
          <span className="vs-live-badge" aria-live="polite">
            <span className="vs-live-dot" aria-hidden="true" />
            {t("livestream.live")}
          </span>
        )}
      </h2>

      {showChat && (
        <div className="vs-livestream-tabs" role="tablist" aria-label={title}>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "stream"}
            className={mobileTab === "stream" ? "vs-tab-active" : ""}
            onClick={() => setMobileTab("stream")}
          >
            {t("livestream.stream")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "chat"}
            className={mobileTab === "chat" ? "vs-tab-active" : ""}
            onClick={() => setMobileTab("chat")}
          >
            {t("livestream.chat")}
          </button>
        </div>
      )}

      <div className="vs-livestream-layout">
        <div
          className={`vs-livestream-player${showChat && mobileTab === "chat" ? " vs-mobile-hidden" : ""}`}
        >
          {isTwitch ? (
            <div className="vs-livestream-embedwrap">
              {/* The player mounts underneath; it appears only on the ONLINE event. */}
              <div ref={twitch.mountRef} className="vs-livestream-frame" />
              {!live && (
                <div className="vs-livestream-overlay">
                  <OfflineCard followUrl={followUrl} t={t} />
                </div>
              )}
            </div>
          ) : (
            <div className="vs-livestream-embedwrap">
              {/* The IFrame API watches this iframe for PLAYING / onError
                  100/150 to decide live vs offline. The offline overlay covers
                  it until PLAYING fires — the raw iframe is never shown. */}
              <iframe
                ref={youTube.iframeRef}
                className="vs-livestream-frame"
                src={youTubeSrc}
                title={title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
              {!live && (
                <div className="vs-livestream-overlay">
                  <OfflineCard followUrl={followUrl} t={t} />
                </div>
              )}
            </div>
          )}
        </div>

        {(isTwitch || youTubeChat) && (
          <div
            className={`vs-livestream-chat${mobileTab === "stream" ? " vs-mobile-hidden" : ""}`}
          >
            <iframe
              src={isTwitch ? chatSrc : (youTubeChat as string)}
              title={t("livestream.chat")}
              className="vs-livestream-frame"
              allowFullScreen
            />
          </div>
        )}
      </div>

      <div className="vs-livestream-actions">
        {live && !unmuted && (
          <button type="button" className="vs-btn vs-btn-ghost" onClick={handleUnmute}>
            🔊 {t("livestream.tapForSound")}
          </button>
        )}
        {tipInteractive && onTip && (
          <button type="button" className="vs-btn vs-btn-primary" onClick={onTip}>
            <IconTip size={16} /> {t("livestream.tipStreamer")}
          </button>
        )}
        <a
          className="vs-livestream-follow"
          href={followUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("livestream.follow")} ↗
        </a>
      </div>
    </section>
  );
}

function OfflineCard({ followUrl, t }: { followUrl: string; t: (k: I18nKey) => string }) {
  return (
    <div className="vs-livestream-offline" role="status">
      <div className="vs-livestream-offline-icon" aria-hidden="true">
        📺
      </div>
      <p className="vs-livestream-offline-text">{t("livestream.offline")}</p>
      <a
        className="vs-livestream-follow"
        href={followUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("livestream.follow")} ↗
      </a>
    </div>
  );
}
