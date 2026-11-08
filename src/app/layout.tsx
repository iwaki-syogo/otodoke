import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://otodoke.app"),
  title: { default: "Otodoke", template: "%s | Otodoke" },
  description: "荷物に、予定を合わせない。どの店で買った荷物も、いつ届くか・いつ家にいればいいか・今月いくら使ったかが分かる荷物カレンダー。設定は最初の 1 回だけ。",
  openGraph: {
    siteName: "Otodoke",
    type: "website",
    locale: "ja_JP",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fafaf9",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
