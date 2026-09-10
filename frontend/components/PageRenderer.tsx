"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import type { Block, RegistryMeta, VoicescapePage } from "@/lib/schema";
import Logo from "@/components/Logo";
import { getActiveChain } from "@/lib/chains";
import { audioGatewayUrl } from "@/lib/ipfs";
import {
  MUSIC_SOURCE_LABELS,
  trackEmbedHeight,
  trackEmbedUrl,
  trackOpenUrl,
} from "@/lib/music";
import type { MusicTrack } from "@/lib/schema";
import {
  IconBook,
  IconBolt,
  IconExternal,
  IconGlobe,
  IconLink,
  IconMusic,
  IconPause,
  IconPlay,
  IconTip,
  IconUsers,
} from "@/components/icons";
import "./renderer.css";

interface RendererProps {
  page: VoicescapePage;
  /** If true, shows the tip jar as an interactive button; parent supplies onTip. */
  tipInteractive?: boolean;
  onTip?: () => void;
  /** On-chain registry metadata (source of truth). Falls back to page.ownerType when absent. */
  meta?: RegistryMeta | null;
  /** Called when a visitor clicks "Pay per call" on a service listing. */
  onPayService?: (service: ServiceItem) => void;
}

export type ServiceItem = Extract<Block, { type: "services" }>["items"][number];

type MusicBlockT = Extract<Block, { type: "music" }>;

/**
 * Real music player. Tracks play through the platform's own embed (Spotify /
 * YouTube / SoundCloud hold the licenses) or a native <audio> element for the
 * owner's own IPFS uploads.
 *
 * Autoplay policy: browsers block autoplay with sound, so everything is
 * click-to-play — embeds are only created after the visitor clicks a track,
 * and IPFS audio uses preload="none" with native controls. Never a silent
 * broken player. Legacy {title, note} blocks without tracks keep the old
 * styled placeholder look.
 */
function MusicBlock({
  block,
  profileTrackIndex,
}: {
  block: MusicBlockT;
  /** Index into block.tracks of the page's MySpace-style profile song. */
  profileTrackIndex?: number;
}) {
  // Defensive: pages pinned before the track schema may have no tracks array.
  const tracks: MusicTrack[] = Array.isArray(block.tracks) ? block.tracks : [];
  const [active, setActive] = useState<number | null>(null);

  const profileIdx =
    profileTrackIndex !== undefined &&
    profileTrackIndex >= 0 &&
    profileTrackIndex < tracks.length
      ? profileTrackIndex
      : undefined;

  if (tracks.length === 0) {
    return (
      <section className="pv-block pv-music pv-glass" aria-label="Music">
        <div className="pv-music-legacy">
          <div className="pv-music-cover" aria-hidden="true">
            <IconMusic size={30} />
          </div>
          <div className="pv-music-info">
            <p className="pv-music-title">{block.title || "Now vibing to"}</p>
            {block.note && <p className="pv-music-note">{block.note}</p>}
          </div>
        </div>
      </section>
    );
  }

  const trackLabel = (t: MusicTrack) =>
    t.title || t.artist || `${MUSIC_SOURCE_LABELS[t.source]} track`;

  const renderPlayer = (track: MusicTrack) => {
    const embed = trackEmbedUrl(track);
    if (embed) {
      const height = trackEmbedHeight(track);
      return (
        <div
          className="pv-embed-wrap"
          style={height ? { height } : { aspectRatio: "16 / 9" }}
        >
          <iframe
            key={embed}
            src={embed}
            title={`Play ${trackLabel(track)}`}
            loading="lazy"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
          />
        </div>
      );
    }
    // "ipfs" — the owner's own upload: native audio, visitor presses play.
    return (
      <audio
        className="pv-audio"
        controls
        preload="none"
        src={audioGatewayUrl(track.id)}
      >
        Your browser does not support audio playback.
      </audio>
    );
  };

  const renderRow = (track: MusicTrack, i: number) => {
    const isActive = active === i;
    const openUrl = trackOpenUrl(track);
    return (
      <li key={i} className={`pv-track${isActive ? " is-active" : ""}`}>
        <button
          type="button"
          className="pv-track-btn"
          onClick={() => setActive(isActive ? null : i)}
          aria-expanded={isActive}
          aria-label={`${isActive ? "Hide" : "Play"} ${trackLabel(track)}`}
        >
          <span className="pv-track-play" aria-hidden="true">
            {isActive ? <IconPause size={16} /> : <IconPlay size={16} />}
          </span>
          <span className="pv-track-meta">
            <span className="pv-track-title">{track.title || "Untitled track"}</span>
            <span className="pv-track-sub vs-mono">
              {track.artist ? `${track.artist} · ` : ""}
              {MUSIC_SOURCE_LABELS[track.source]}
            </span>
          </span>
        </button>
        {openUrl && (
          <a
            className="pv-track-open"
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${trackLabel(track)} in ${MUSIC_SOURCE_LABELS[track.source]}`}
            onClick={(e) => e.stopPropagation()}
          >
            <IconExternal size={14} />
          </a>
        )}
        {isActive && <div className="pv-track-player">{renderPlayer(track)}</div>}
      </li>
    );
  };

  return (
    <section className="pv-block pv-music pv-glass" aria-label="Music">
      <div className="pv-music-head">
        <span className="pv-music-icon" aria-hidden="true">
          <IconMusic size={22} />
        </span>
        <h2 className="pv-block-title">{block.title || "Music"}</h2>
      </div>

      {profileIdx !== undefined && (
        <button
          type="button"
          className="pv-profile-song"
          onClick={() => setActive(active === profileIdx ? null : profileIdx)}
          aria-expanded={active === profileIdx}
        >
          <span className="pv-profile-song-badge">★ Profile song</span>
          <span className="pv-profile-song-title">
            {tracks[profileIdx].title || "Untitled track"}
          </span>
          {tracks[profileIdx].artist && (
            <span className="pv-profile-song-artist">{tracks[profileIdx].artist}</span>
          )}
          <span className="pv-profile-song-play" aria-hidden="true">
            {active === profileIdx ? <IconPause size={18} /> : <IconPlay size={18} />}
          </span>
        </button>
      )}
      {profileIdx !== undefined && active === profileIdx && (
        <div className="pv-track-player">{renderPlayer(tracks[profileIdx])}</div>
      )}

      <ul className="pv-tracklist">
        {tracks.map((t, i) => (i === profileIdx ? null : renderRow(t, i)))}
      </ul>
    </section>
  );
}

function BlockView({
  block,
  onPayService,
  profileTrackIndex,
}: {
  block: Block;
  onPayService?: (s: ServiceItem) => void;
  /** For music blocks: index of the page's profile song within block.tracks. */
  profileTrackIndex?: number;
}) {
  switch (block.type) {
    case "hero": {
      const initial = (block.title || "?").trim().charAt(0).toUpperCase() || "?";
      return (
        <section className="pv-block pv-hero">
          <div className="pv-avatar-ring">
            <div className="pv-avatar" aria-hidden="true">
              {block.avatarEmoji || initial}
            </div>
          </div>
          <h1 className="pv-title">{block.title}</h1>
          {block.subtitle && <p className="pv-subtitle">{block.subtitle}</p>}
        </section>
      );
    }
    case "bio":
      return (
        <section className="pv-block pv-bio pv-glass" aria-label="Bio">
          <p>{block.text}</p>
        </section>
      );
    case "links":
      return (
        <section className="pv-block pv-links" aria-label="Links">
          {block.items.map((item, i) => (
            <a
              key={i}
              className="pv-link-btn"
              href={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <IconLink size={18} />
              <span className="pv-link-label">{item.label}</span>
              <IconExternal size={14} className="pv-link-ext" />
            </a>
          ))}
        </section>
      );
    case "tipJar":
      return (
        <section className="pv-block pv-tipjar" aria-label="Tip jar">
          <span className="pv-tipjar-icon" aria-hidden="true">
            <IconTip size={26} />
          </span>
          {block.message && <p>{block.message}</p>}
        </section>
      );
    case "guestbook":
      return (
        <section className="pv-block" aria-label="Guestbook">
          <h2 className="pv-block-title">
            <IconBook size={20} />
            <span>Guestbook</span>
          </h2>
          {block.entries.length === 0 && (
            <p className="pv-empty">No entries yet. Be the first to sign!</p>
          )}
          {block.entries.map((e, i) => (
            <article key={i} className="pv-gb-card">
              <div className="pv-gb-meta">
                <span className="pv-gb-name">{e.name}</span>
                <span className="pv-gb-date vs-mono">{e.date}</span>
              </div>
              <p>{e.message}</p>
            </article>
          ))}
        </section>
      );
    case "music":
      return <MusicBlock block={block} profileTrackIndex={profileTrackIndex} />;
    case "gallery":
      return (
        <section className="pv-block" aria-label="Gallery">
          <div className="pv-gallery">
            {block.images.map((img, i) => (
              <div key={i} className="pv-gallery-tile" aria-hidden="true">
                {img}
              </div>
            ))}
          </div>
        </section>
      );
    case "top8": {
      const title = block.title || "Top 8";
      return (
        <section className="pv-block" aria-label={title}>
          <h2 className="pv-block-title">
            <IconUsers size={20} />
            <span>{title}</span>
          </h2>
          {block.friends.length === 0 ? (
            <p className="pv-empty">No friends listed yet.</p>
          ) : (
            <div className="pv-top8-grid">
              {block.friends.map((f, i) => {
                const initial = (f.name || "?").trim().charAt(0).toUpperCase() || "?";
                const inner = (
                  <>
                    <span className="pv-friend-avatar" aria-hidden="true">
                      {f.avatarEmoji || initial}
                    </span>
                    <span className="pv-friend-name">{f.name}</span>
                  </>
                );
                return f.url ? (
                  <a key={i} className="pv-friend" href={f.url} target="_blank" rel="noreferrer">
                    {inner}
                  </a>
                ) : (
                  <div key={i} className="pv-friend">
                    {inner}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      );
    }
    case "services":
      return <ServicesBlock block={block} onPayService={onPayService} />;
    case "capabilities":
      return <CapabilitiesBlock block={block} />;
    case "operator":
      return <OperatorBlock block={block} />;
    case "reviews":
      return <ReviewsBlock block={block} />;
    case "booking":
      return <BookingBlock block={block} />;
    default:
      return null;
  }
}

function ServicesBlock({ block, onPayService }: { block: Extract<Block, { type: "services" }>; onPayService?: (s: ServiceItem) => void }) {
  return (
    <section className="pv-block" aria-label="Services">
      <h2 className="pv-block-title">
        <IconBolt size={20} />
        <span>Services — pay per call</span>
      </h2>
      {block.items.length === 0 && <p className="pv-empty">No services listed yet.</p>}
      <div className="pv-services">
        {block.items.map((s, i) => (
          <article key={i} className="pv-service-card pv-glass">
            <div className="pv-service-head">
              <h3 className="pv-service-name">{s.name}</h3>
              <span className="pv-service-price vs-mono">${(s.priceUsdCents / 100).toFixed(2)}</span>
            </div>
            {s.description && <p className="pv-service-desc">{s.description}</p>}
            <div className="pv-service-foot">
              <span className="pv-service-endpoint vs-mono" title={s.endpoint}>
                {s.endpoint}
              </span>
              {onPayService ? (
                <button
                  type="button"
                  className="pv-service-pay"
                  onClick={() => onPayService(s)}
                >
                  <IconBolt size={16} /> Pay per call
                </button>
              ) : (
                <span className="pv-service-note">Pay-per-call available on the live page</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CapabilitiesBlock({ block }: { block: Extract<Block, { type: "capabilities" }> }) {
  return (
    <section className="pv-block" aria-label="Capabilities">
      <h2 className="pv-block-title">
        <span aria-hidden="true">🧠</span>
        <span>Capabilities</span>
      </h2>
      {block.items.length === 0 ? (
        <p className="pv-empty">No capabilities listed.</p>
      ) : (
        <div className="pv-caps">
          {block.items.map((c, i) => (
            <code key={i} className="pv-cap vs-mono">{c}</code>
          ))}
        </div>
      )}
    </section>
  );
}

function OperatorBlock({ block }: { block: Extract<Block, { type: "operator" }> }) {
  const chain = getActiveChain();
  return (
    <section className="pv-block pv-operator pv-glass" aria-label="Operator disclosure">
      <h2 className="pv-block-title">
        <IconUsers size={20} />
        <span>Operated by</span>
      </h2>
      <dl className="pv-operator-grid">
        {block.name && (
          <>
            <dt>Name</dt>
            <dd>
              {block.url ? (
                <a href={block.url} target="_blank" rel="noreferrer">
                  {block.name} <IconExternal size={13} />
                </a>
              ) : (
                block.name
              )}
            </dd>
          </>
        )}
        <dt>Wallet</dt>
        <dd>
          <a
            className="vs-mono"
            href={`${chain.blockExplorer}/address/${block.wallet}`}
            target="_blank"
            rel="noreferrer"
            title={block.wallet}
          >
            {block.wallet}
          </a>
        </dd>
      </dl>
      <p className="pv-operator-note">
        This page is run by an AI agent. The operator above is the human or organization
        responsible for it.
      </p>
    </section>
  );
}

function ReviewsBlock({ block }: { block: Extract<Block, { type: "reviews" }> }) {
  const chain = getActiveChain();
  return (
    <section className="pv-block" aria-label={block.title || "Reviews"}>
      <h2 className="pv-block-title">
        <span aria-hidden="true">⭐</span>
        <span>{block.title || "Reviews"}</span>
      </h2>
      {block.entries.length === 0 && <p className="pv-empty">No reviews yet.</p>}
      {block.entries.map((e, i) => (
        <article key={i} className="pv-gb-card">
          <div className="pv-gb-meta">
            <span className="pv-gb-name">{e.name}</span>
            <span className="pv-gb-date vs-mono">{e.date}</span>
          </div>
          <p>{e.message}</p>
          {e.txHash && (
            <a
              className="pv-review-tx vs-mono"
              href={`${chain.blockExplorer}/transaction/${e.txHash}`}
              target="_blank"
              rel="noreferrer"
              title={`Payment proof: ${e.txHash}`}
            >
              <IconExternal size={13} /> payment proof
            </a>
          )}
        </article>
      ))}
    </section>
  );
}

function BookingBlock({ block }: { block: Extract<Block, { type: "booking" }> }) {
  return (
    <section className="pv-block" aria-label={block.title || "Booking"}>
      <h2 className="pv-block-title">
        <IconGlobe size={20} />
        <span>{block.title || "Book"}</span>
      </h2>
      <div className="pv-links">
        {block.items.map((item, i) => (
          <a key={i} className="pv-link-btn" href={item.url} target="_blank" rel="noreferrer">
            <IconLink size={18} />
            <span className="pv-link-label">
              {item.label}
              {item.note && <span className="pv-link-note">{item.note}</span>}
            </span>
            <IconExternal size={14} className="pv-link-ext" />
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * THE agent banner. Loud by design: hazard stripes, a giant AGENT PAGE badge,
 * and the full operator disclosure. Rendered from the ON-CHAIN registry record
 * whenever available, so a page can never hide its agent status in its JSON.
 */
function AgentBanner({ meta }: { meta: RegistryMeta }) {
  const chain = getActiveChain();
  return (
    <div className="pv-agent-banner" role="alert" aria-label="This is an agent page">
      <div className="pv-agent-hazard" aria-hidden="true" />
      <div className="pv-agent-body">
        <div className="pv-agent-badge">
          <span aria-hidden="true">🤖</span> AGENT PAGE
        </div>
        <p className="pv-agent-warn">
          This page is operated by an <strong>AI agent</strong>, not a human.
          {meta.purpose ? (
            <> Its stated purpose: <em>{meta.purpose}</em></>
          ) : null}
        </p>
        <dl className="pv-agent-operator">
          <dt>Operator wallet</dt>
          <dd>
            <a
              className="vs-mono"
              href={`${chain.blockExplorer}/address/${meta.operator}`}
              target="_blank"
              rel="noreferrer"
              title={meta.operator}
            >
              {meta.operator}
            </a>
          </dd>
          <dt>Page owner</dt>
          <dd>
            <a
              className="vs-mono"
              href={`${chain.blockExplorer}/address/${meta.owner}`}
              target="_blank"
              rel="noreferrer"
              title={meta.owner}
            >
              {meta.owner}
            </a>
          </dd>
        </dl>
        <p className="pv-agent-note">
          Operator disclosure is read from the on-chain registry — the page itself cannot remove this banner.
        </p>
      </div>
      <div className="pv-agent-hazard" aria-hidden="true" />
    </div>
  );
}

export default function PageRenderer({ page, tipInteractive, onTip, meta, onPayService }: RendererProps) {
  const { theme } = page;
  const themeStyle = {
    "--pv-bg": theme.background,
    "--pv-fg": theme.foreground,
    "--pv-accent": theme.accent,
    "--pv-font": theme.fontFamily,
  } as CSSProperties;

  // The on-chain registry is the source of truth for agent status. Fall back
  // to the page JSON's own declaration (used in the builder preview).
  const isAgent = meta ? meta.ownerType === "agent" : page.ownerType === "agent";
  const agentMeta: RegistryMeta | null = isAgent
    ? (meta ?? {
        owner: "",
        ownerType: "agent" as const,
        operator:
          page.blocks.find((b): b is Extract<Block, { type: "operator" }> => b.type === "operator")
            ?.wallet ?? "",
        purpose: page.purpose ?? "",
      })
    : null;

  return (
    <div className={`pv-root${isAgent ? " is-agent" : ""}`} style={themeStyle}>
      <header className="pv-header">
        <a className="pv-brand" href="/" aria-label="Voicescape home">
          <Logo size={24} />
          <span className="pv-brand-text">
            voicescape <span className="pv-username vs-mono">/{page.username}</span>
          </span>
        </a>
      </header>

      {agentMeta && <AgentBanner meta={agentMeta} />}

      <main className="pv-blocks">
        {page.blocks.map((block, i) => (
          <BlockView
            key={i}
            block={block}
            onPayService={onPayService}
            profileTrackIndex={
              block.type === "music" &&
              page.profileSong &&
              page.profileSong.blockIndex === i
                ? page.profileSong.trackIndex
                : undefined
            }
          />
        ))}

        {tipInteractive && (
          <div className="pv-tip-cta">
            <button type="button" className="pv-tip-cta-btn" onClick={onTip}>
              <IconTip size={20} />
              <span>Tip this page</span>
            </button>
          </div>
        )}
      </main>

      <footer className="pv-footer">
        <Logo size={16} />
        <span>Made with Voicescape</span>
      </footer>
    </div>
  );
}
