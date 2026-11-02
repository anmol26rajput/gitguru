import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Suspense } from "react";
import { EmbedProvider } from "@/components/Embed";
import Nav from "@/components/Nav";
import Waking from "@/components/Waking";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GitGuru",
  description: "Talk to any codebase.",
};

// Android Chrome: the on-screen keyboard shrinks the layout (and dvh), so the sticky question box stays above it.
// iOS Safari ignores this and scrolls the focused box into view itself.
export const viewport: Viewport = { interactiveWidget: "resizes-content" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-dvh flex flex-col">
        <Waking />
        <Suspense>
          <EmbedProvider>
            <Nav />
            {children}
          </EmbedProvider>
        </Suspense>
      </body>
    </html>
  );
}
