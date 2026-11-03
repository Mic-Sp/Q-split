import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Q-Split | Hybrid Workload Simulator";
const description = "Interactive hybrid quantum-classical workload profiler evaluating Shor's algorithm and Quantum-MIPS across physical NISQ hardware and fault-tolerant surface-code architectures.";
const canonicalUrl = "https://q-split.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(canonicalUrl),
  title,
  description,
  alternates: { canonical: canonicalUrl },
  authors: [{ name: "Michael Sprague" }],
  openGraph: {
    type: "website",
    url: canonicalUrl,
    siteName: "Q-Split",
    title,
    description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  other: {
    "article:published_time": "2026-11-02T00:00:00Z",
  },
};

/**
 * Provide persistent system/light/dark themes and shared fonts around the page tree.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
