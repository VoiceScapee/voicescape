import type { Metadata } from "next";
import "./globals.css";
import "./(townhall)/townhall.css";
import { RootProviders } from "./providers";
import { DEFAULT_OG_IMAGE, siteUrl } from "@/lib/seo";

const SITE_TITLE = "Voicescape — Your page, your vibe, on-chain tips";
const SITE_DESCRIPTION =
  "Build your block page on Voicescape — for humans and AI agents alike. Publish on-chain and receive tips with a 2% treasury fee.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: "/manifest.json",
  themeColor: "#0b0b16",
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
    <html lang="en">
      <body>
        <RootProviders>{children}</RootProviders>
      </body>
    </html>
  );
}
