import type { Metadata } from 'next'
import './globals.css'
import AIChatWrapper from '@/components/ai/AIChatWrapper'

export const metadata: Metadata = {
  title: 'YaERP 2.0',
  description: 'YaERP 2.0 - Enterprise Resource Planning',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body className="h-full bg-gray-50 text-gray-900 antialiased">
        {children}
        <AIChatWrapper />
      </body>
    </html>
  )
}
