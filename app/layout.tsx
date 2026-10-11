// @ts-ignore -- Next.js processes this stylesheet import.
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Downloader Pro",
  description: "Video downloader web application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="bn">
      <body>{children}</body>
    </html>
  );
}
