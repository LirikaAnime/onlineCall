import type { Metadata, Viewport } from "next";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Manual Meet",
  description: "Приватные WebRTC-созвоны без сервера: GitHub Pages, ручной обмен кодами, чат и демонстрация экрана.",
  applicationName: "Manual Meet",
  authors: [{ name: "Manual Meet" }],
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Manual Meet"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#10201d"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <head>
        <link rel="manifest" href={`${basePath}/manifest.webmanifest`} />
        <link rel="icon" href={`${basePath}/favicon.svg`} />
        <link rel="apple-touch-icon" href={`${basePath}/icon.svg`} />
      </head>
      <body>{children}</body>
    </html>
  );
}
