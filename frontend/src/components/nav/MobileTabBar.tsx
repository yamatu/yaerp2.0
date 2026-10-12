'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { BriefcaseBusiness, FolderKanban, Mail, MessageSquare, UserRound, type LucideIcon } from 'lucide-react'

interface MobileTab {
  href: string
  label: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

const TABS: MobileTab[] = [
  { href: '/', label: '工作台', icon: FolderKanban, match: (path) => path === '/' },
  { href: '/trade', label: '外贸', icon: BriefcaseBusiness, match: (path) => path.startsWith('/trade') },
  { href: '/channels', label: '消息', icon: MessageSquare, match: (path) => path.startsWith('/channels') || path.startsWith('/whatsapp') },
  { href: '/mail', label: '邮件', icon: Mail, match: (path) => path.startsWith('/mail') },
  { href: '/settings', label: '我的', icon: UserRound, match: (path) => path.startsWith('/settings') || path.startsWith('/admin') },
]

// Full-screen tools (sheet editor, label printing, login) keep the whole viewport.
const HIDDEN_PREFIXES = ['/login', '/sheets/', '/trade/labels/']

export function isMobileTabBarHidden(pathname: string) {
  return HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/**
 * App-style bottom navigation for phones (< md). While it is visible the body
 * carries `has-mobile-tabbar`, which reserves space at the bottom and exposes
 * `--mobile-tabbar-offset` for other fixed elements (see globals.css).
 */
export default function MobileTabBar() {
  const pathname = usePathname() || '/'
  const hidden = isMobileTabBarHidden(pathname)

  useEffect(() => {
    document.body.classList.toggle('has-mobile-tabbar', !hidden)
    return () => document.body.classList.remove('has-mobile-tabbar')
  }, [hidden])

  if (hidden) return null

  return (
    <nav
      aria-label="主导航"
      className="mobile-tabbar fixed inset-x-0 bottom-0 z-[60] border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="grid h-14 grid-cols-5">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.match(pathname)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`flex select-none flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition [-webkit-tap-highlight-color:transparent] active:scale-95 ${active ? 'text-sky-700' : 'text-slate-500'}`}
            >
              <span className={`flex h-7 w-12 items-center justify-center rounded-full transition ${active ? 'bg-sky-50' : ''}`}>
                <Icon className={`h-5 w-5 ${active ? 'stroke-[2.4]' : ''}`} />
              </span>
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
