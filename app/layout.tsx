import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      'https://pinkrocket-cs-review-mockup.kimhyein0214.chatgpt.site',
  ),
  title: 'AI 답변 검수함 · Pink Rocket CS',
  description:
    '고객 문의, AI 추천답변, 사람 수정본, 쇼핑몰 실제 답변을 구분해 검수하는 CS 운영 화면',
  openGraph: {
    title: 'AI 답변 검수함',
    description: '원문 · AI 추천 · 사람 답변 · 실제 응답 확인',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AI 답변 검수함',
    description: '원문 · AI 추천 · 사람 답변 · 실제 응답 확인',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
