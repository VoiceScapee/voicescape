import type { Metadata, Viewport } from "next";
import { Montserrat, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import "./(townhall)/townhall.css";
import "./seasons/october.css";
import { RootProviders } from "./providers";
import { Analytics } from "@vercel/analytics/next";
import { DEFAULT_OG_IMAGE, siteUrl } from "@/lib/seo";
import AgentChat from "@/components/AgentChat";
import DappVoiceMicMount from "@/components/DappVoiceMicMount";
import SeasonalTheme from "@/components/SeasonalTheme";
import Toasts from "@/components/Toasts";

/* Design-system type: Montserrat for display headings AND body/UI —
 * the sorting-colors UI direction (Brandon 2026-10-21) standardizes on
 * Hedera's own published free replacement font. Montserrat is SIL Open
 * Font License 1.1 (Google Fonts distribution, served via next/font —
 * no font files are committed to this repo). Hedera's own Styrene font
 * is licensed and must NEVER be used. IBM Plex Mono stays ONLY for
 * mono contexts (numbers, handles, timestamps, prices) — it is a
 * functional mono, not a brand typeface. */
const display = Montserrat({
  weight: ["700"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const sans = Montserrat({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  weight: ["500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const SITE_TITLE = "Voicescape — Your blockpage, your vibe, on-chain tips";
const SITE_DESCRIPTION =
  "Build your blockpage on Voicescape — for humans and AI agents alike. Publish on-chain and receive tips with a 2% treasury fee.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Voicescape",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "Voicescape",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: siteUrl(),
    images: [{ url: siteUrl() + DEFAULT_OG_IMAGE, alt: "Voicescape" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [siteUrl() + DEFAULT_OG_IMAGE],
  },
};

/* Viewport: device-width, no pinch-zoom lockouts (a11y), viewport-fit=cover
 * so the iOS PWA draws edge-to-edge; themeColor matches manifest #0b0b16
 * (was #090b12 — the mismatch flickered browser chrome on PWA launch). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0b16",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>
        <SeasonalTheme />
        <RootProviders>
          {children}
          {/* Inside RootProviders: the mic needs LanguageProvider (see
              AgentChat's note — it mounts outside and can't useLanguage). */}
          <DappVoiceMicMount />
        </RootProviders>
        <Analytics />
        <AgentChat />
        <Toasts />
      </body>
    </html>
  );
}
