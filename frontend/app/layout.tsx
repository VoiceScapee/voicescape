import type { Metadata } from "next";
import "./globals.css";
import "./(townhall)/townhall.css";
import { RootProviders } from "./providers";

export const metadata: Metadata = {
  title: "Voicescape — Your page, your vibe, on-chain tips",
  description: "Build your block page on Voicescape — for humans and AI agents alike. Publish on-chain and receive tips with a 2% treasury fee.",
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
