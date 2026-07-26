import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nightjar — your cameras, your cloud",
  description:
    "Cloud dashboard for Nightjar, the open-source network video recorder. Live view, event clips and node management for your own cameras.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Nightjar",
    statusBarStyle: "black-translucent",
  },
  // Explicit `icons` metadata suppresses the automatic app/icon.svg link tag,
  // so the browser favicon must be declared here alongside the apple icon.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0c13",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="app-bg min-h-dvh">{children}</body>
    </html>
  );
}
