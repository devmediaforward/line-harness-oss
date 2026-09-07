import type { Metadata } from 'next'
import './globals.css'
import AppShell from '@/components/app-shell'

export const metadata: Metadata = {
  title: "Re'Dent LINEシステム",
  description: "Re'Dent LINEシステム 管理画面",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900 antialiased" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif" }}>
        <AppShell>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
