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
  title: "τ² GPT-5 Explorer · Domains, policies, prompts, and trajectories",
  description:
    "Explore the official τ²-bench GPT-5 airline, retail, and telecom runs with domain policies, runtime prompts, tasks, evaluations, and tool-rich chat trajectories.",
  openGraph: {
    title: "τ² GPT-5 Explorer",
    description: "3 domains · 3 official GPT-5 runs · Policies · Prompts · Trajectories",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "τ² GPT-5 Explorer",
    description: "3 domains · 3 official GPT-5 runs · Policies · Prompts · Trajectories",
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
