import type { MetadataRoute } from 'next'

/**
 * Web app manifest so phones can "add to home screen" and launch YaERP as a
 * standalone app. No service worker: API responses are never cached.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'YaERP',
    short_name: 'YaERP',
    description: 'YaERP 2.0 企业资源协同工作台',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#0f172a',
    background_color: '#ffffff',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: '邮件', short_name: '邮件', url: '/mail', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: '外贸业务', short_name: '外贸', url: '/trade', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: '消息', short_name: '消息', url: '/channels', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  }
}
