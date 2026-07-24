import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nightjar — your cameras, your cloud",
  description:
    "Cloud dashboard for Nightjar, the open-source network video recorder. Live view, event clips and node management for your own cameras.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="app-bg min-h-dvh">{children}</body>
    </html>
  );
}
