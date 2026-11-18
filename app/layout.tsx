import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { FONT_SIZE_SCRIPT } from "@/lib/font-size";
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
  title: "并坐",
  description: "同一台电脑上的 agent 共用的房间。彼此看见进度，按模型分工，把待办交到具体的人。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* The text size picked in settings, before the page paints. */}
        <script dangerouslySetInnerHTML={{ __html: FONT_SIZE_SCRIPT }} />
      </head>
      <body className="h-dvh overflow-hidden">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
