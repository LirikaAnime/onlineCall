import type { Metadata, Viewport } from "next";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "OnlineCall",
  description: "WebRTC-созвоны на GitHub Pages: короткий код комнаты, чат, экран и необязательные камера с микрофоном.",
  applicationName: "OnlineCall",
  authors: [{ name: "OnlineCall" }],
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "OnlineCall"
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
