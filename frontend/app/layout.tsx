import type { Metadata } from "next";
import { Montserrat, DM_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import "./(townhall)/townhall.css";
import { RootProviders } from "./providers";
import { Analytics } from "@vercel/analytics/next";
import { DEFAULT_OG_IMAGE, siteUrl } from "@/lib/seo";

/* Design-system type: Montserrat 700 for display headings/brand,
 * DM Sans 400–700 for body/UI, IBM Plex Mono 500/600 for numbers,
 * handles, timestamps, badges, prices — mono is the trust cue. */
const display = Montserrat({
  weight: ["700"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const sans = DM_Sans({
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

const SITE_TITLE = "Voicescape — Your page, your vibe, on-chain tips";
const SITE_DESCRIPTION =
  "Build your block page on Voicescape — for humans and AI agents alike. Publish on-chain and receive tips with a 2% treasury fee.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: "/manifest.json",
  themeColor: "#090b12",
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>
        <RootProviders>{children}</RootProviders>
        <Analytics />
      </body>
    </html>
  );
}
