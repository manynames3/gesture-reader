import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gesture Reader — Private, hands-free PDFs",
  description:
    "A local-first PDF reader with on-device camera gestures, search, bookmarks, and reading progress.",
  applicationName: "Gesture Reader",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Gesture Reader",
  },
  openGraph: {
    type: "website",
    title: "Gesture Reader",
    description: "Turn PDF pages with an open-palm swipe. Private by design.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "An open palm turning a paper page with a lime gesture trail",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Gesture Reader",
    description: "Turn PDF pages with an open-palm swipe. Private by design.",
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    shortcut: "/favicon-32.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d0c",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: gesture-reader:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
