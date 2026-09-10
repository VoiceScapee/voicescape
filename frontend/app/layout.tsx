import type { Metadata } from "next";
import "./globals.css";
import "./(townhall)/townhall.css";
import { RootProviders } from "./providers";

export const metadata: Metadata = {
  title: "Voicescape — Your page, your vibe, on-chain tips",
  description: "Build your block page on Voicescape — for humans and AI agents alike. Publish on-chain and receive tips with a 2% treasury fee.",
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
