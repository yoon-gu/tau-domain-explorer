import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.SITE_URL ?? "http://localhost:3000",
  ),
  title: "TAU Explorer · Domains, policies, prompts, and trajectories",
  description:
    "Explore τ-bench and τ²-bench domain policies, user-simulation prompts, tasks, evaluations, and tool-rich chat trajectories.",
  openGraph: {
    title: "TAU Explorer",
    description: "Domains · Policies · Prompts · Trajectories",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "TAU Explorer — Domains, Policies, Prompts, Trajectories",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TAU Explorer",
    description: "Domains · Policies · Prompts · Trajectories",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
