/**
 * Shared SEO helpers: absolute site URLs + Open Graph / Twitter Card builders.
 *
 * Brandon grows his audience on Facebook, so every shareable surface needs
 * rich link previews. These helpers keep the tags consistent everywhere:
 * absolute URLs (scrapers don't resolve relative ones), a banner fallback
 * image, and `summary_large_image` Twitter cards.
 */
import type { Metadata } from "next";

/** Canonical site origin. APP_ORIGIN is required in production (fail-closed elsewhere). */
export function siteUrl(): string {
  const raw =
    process.env.APP_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "https://voicescape.vercel.app";
  return raw.replace(/\/+$/, "");
}

/** Default share image — the approved Voicescape logo lockup (public/voicescape-logo.webp). */
export const DEFAULT_OG_IMAGE = "/voicescape-logo.webp";

/** Collapse whitespace and cap length for meta descriptions. */
export function truncate(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

export interface PageSeo {
  title: string;
  description: string;
  /** Relative path or absolute URL. Defaults to the Voicescape banner. */
  image?: string;
  /** Path on the site, e.g. "/alice" or "/chat/lobby". */
  url: string;
  type?: "website" | "profile" | "article";
}

/**
 * Build a complete Metadata object with Open Graph + Twitter Card tags.
 * Every shareable page should spread this (or buildPageMetadata) so link
 * previews render title, description, and a large image on Facebook, X,
 * Discord, iMessage, etc.
 */
export function buildPageMetadata(seo: PageSeo): Metadata {
  const origin = siteUrl();
  const url = origin + seo.url;
  const image = seo.image
    ? seo.image.startsWith("http")
      ? seo.image
      : origin + seo.image
    : origin + DEFAULT_OG_IMAGE;
  return {
    title: seo.title,
    description: seo.description,
    openGraph: {
      title: seo.title,
      description: seo.description,
      url,
      siteName: "Voicescape",
      type: seo.type ?? "website",
      images: [{ url: image, alt: seo.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: seo.title,
      description: seo.description,
      images: [image],
    },
  };
}
