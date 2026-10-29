import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://monkey-invest-korea.dldydcks0528.chatgpt.site"),
  alternates: { canonical: "/" },
  title: "침팬지와 대결하기 | Monkey Invest Korea",
  description: "침팬지가 고른 주식, 인간이 예측한 방향. KOSPI와 NASDAQ에서 펼쳐지는 익명 상승·하락 투표. 첫 대결을 준비하고 있어요.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "침팬지와 대결하기",
    description: "당신의 직감, 침팬지를 이길 수 있을까요? 로그인 없이 함께하는 시장 예측 실험.",
    locale: "ko_KR",
    url: "https://monkey-invest-korea.dldydcks0528.chatgpt.site",
    type: "website",
    images: [{ url: "/chimp-portrait.webp", width: 768, height: 768, alt: "침팬지와 대결하기" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
