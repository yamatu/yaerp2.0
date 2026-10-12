import type { Metadata, Viewport } from 'next'
import 'katex/dist/katex.min.css'
import './globals.css'
import AIChatWrapper from '@/components/ai/AIChatWrapper'
import GlobalQuickNav from '@/components/nav/GlobalQuickNav'
import MobileTabBar from '@/components/nav/MobileTabBar'
import ViewportMetrics from '@/components/nav/ViewportMetrics'

export const metadata: Metadata = {
  title: 'YaERP 2.0',
  description: 'YaERP 2.0 - Enterprise Resource Planning',
  applicationName: 'YaERP',
  appleWebApp: { capable: true, title: 'YaERP', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f172a',
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
        <ViewportMetrics />
        <GlobalQuickNav />
        <MobileTabBar />
        <AIChatWrapper />
      </body>
    </html>
  )
}
